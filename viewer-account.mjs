import { formatDuration } from './watchtime-period.mjs';

const sessionKey = 'yanibox-viewer-session';
const returnKey = 'yanibox-viewer-return';
const filmsUrl = new URL('films.html', import.meta.url);
const callback = location.pathname === filmsUrl.pathname && new URLSearchParams(location.search).has('code');
const account = document.getElementById('viewer-account');
const accountLabel = document.createElement('span');
account.replaceChildren(accountLabel);
const listeners = [];
let client;
let viewer;
let statsRequest;
let ready = false;
let opening = false;

const storage = {
  getItem: key => localStorage.getItem(key),
  removeItem: key => localStorage.removeItem(key),
  setItem(key, value) {
    if (key === sessionKey) {
      const session = JSON.parse(value);
      delete session.provider_token;
      delete session.provider_refresh_token;
      value = JSON.stringify(session);
    }
    localStorage.setItem(key, value);
  }
};

const dialog = document.createElement('dialog');
dialog.className = 'viewer-dialog';
dialog.setAttribute('aria-labelledby', 'viewer-title');
dialog.innerHTML = `
  <div class="viewer-banner">
    <button class="viewer-close" type="button" aria-label="Закрыть" autofocus>×</button>
    <div class="viewer-avatar" aria-hidden="true"><span></span><img alt="" hidden></div>
    <div class="viewer-title-group"><h2 id="viewer-title">Профиль зрителя</h2><p class="hint viewer-handle"></p></div>
  </div>
  <div class="viewer-dialog-body">
    <div class="viewer-guest">
      <p>Войди через Twitch, чтобы увидеть свою статистику на канале и оценивать фильмы.</p>
      <p class="hint">Для входа Twitch передаёт Supabase данные аккаунта и email. Адрес не отображается на сайте.</p>
      <button class="viewer-account viewer-login" type="button" disabled>Войти через Twitch</button>
    </div>
    <div class="viewer-member" hidden>
      <dl class="viewer-stats" aria-label="Статистика на канале Yanibox">
        <div><dt>Время просмотра</dt><dd data-stat="time">—</dd><small class="hint" data-detail="time"></small></div>
        <div><dt>Сообщения</dt><dd data-stat="messages">—</dd><small class="hint" data-detail="messages"></small></div>
        <div><dt>Смайлы Twitch</dt><dd data-stat="emotes">—</dd><small class="hint" data-detail="emotes"></small></div>
      </dl>
      <div class="viewer-footer">
        <a class="nav-link" href="watchtime.html">Рейтинг зрителей ↗</a>
        <button class="viewer-logout" type="button">Выйти</button>
      </div>
    </div>
    <p class="hint viewer-message" role="status"></p>
  </div>`;
document.body.append(dialog);

const part = selector => dialog.querySelector(selector);
const message = part('.viewer-message');
const logIn = part('.viewer-login');
const logOut = part('.viewer-logout');
const avatar = part('.viewer-avatar img');
const initial = part('.viewer-avatar span');
avatar.addEventListener('error', () => { avatar.hidden = true; });
displayProfile();

function stat(key, value, detail) {
  part(`[data-stat="${key}"]`).textContent = value ?? '—';
  part(`[data-detail="${key}"]`).textContent = detail;
}

async function loadStats() {
  const current = viewer;
  const request = statsRequest = new AbortController();
  const { signal } = request;
  for (const key of ['time', 'messages', 'emotes']) stat(key, null, 'Загрузка…');
  const snapshot = async () => {
    const response = await fetch(new URL('data/watchtime.json', import.meta.url), {
      cache: 'no-cache', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
    });
    if (!response.ok) throw new Error('WizeBot snapshot unavailable');
    return response.json();
  };
  const showWizeBot = (key, entry, field, format, detail) => {
    const index = entry?.viewers?.findIndex(row => row.name.toLowerCase() === current.login) ?? -1;
    const value = index >= 0 ? entry.viewers[index][field] : undefined;
    const description = value == null ? (entry ? 'Нет записи в WizeBot' : 'WizeBot недоступен') :
      entry.stale ? 'Последний снимок WizeBot' : detail(index);
    stat(key, value == null ? null : format(value), description);
  };
  await Promise.all([
    snapshot().then(data => {
      if (signal.aborted) return;
      showWizeBot('time', data.periods?.global, 'seconds', formatDuration, rank => `№ ${rank + 1} в рейтинге`);
      showWizeBot('messages', data.messages, 'count', value => value.toLocaleString('ru-RU'), () => 'За всё время · WizeBot');
    }).catch(() => {
      if (signal.aborted) return;
      stat('time', null, 'WizeBot недоступен');
      stat('messages', null, 'WizeBot недоступен');
    }),
    (async () => {
      try {
        const { data, error } = await client.rpc('get_my_twitch_emotes')
          .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        if (error) throw error;
        if (!signal.aborted) stat('emotes', data?.toLocaleString('ru-RU'), data == null ? 'Нет данных' : 'С начала сбора');
      } catch {
        if (!signal.aborted) stat('emotes', null, 'Нет данных');
      }
    })()
  ]);
}

function displayProfile() {
  accountLabel.textContent = viewer?.displayName ?? 'Войти через Twitch';
  part('.viewer-guest').hidden = Boolean(viewer);
  part('.viewer-member').hidden = !viewer;
  part('#viewer-title').textContent = viewer?.displayName ?? 'Профиль зрителя';
  part('.viewer-handle').textContent = viewer?.login ? '@' + viewer.login : '';
  initial.textContent = viewer?.displayName[0]?.toUpperCase() ?? 'Y';
  if (viewer?.avatar) avatar.src = viewer.avatar;
  else avatar.removeAttribute('src');
  avatar.hidden = !viewer?.avatar;
}

export function openViewerAccount() {
  if (dialog.open) return;
  dialog.showModal();
  if (viewer) void loadStats();
}

account.addEventListener('click', openViewerAccount);
part('.viewer-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => statsRequest?.abort());
account.hidden = false;

logIn.addEventListener('click', async () => {
  logIn.disabled = true;
  message.textContent = '';
  try {
    const page = location.pathname.endsWith('/watchtime.html') ? 'watchtime.html' :
      location.pathname === filmsUrl.pathname ? 'films.html' : 'index.html';
    try { sessionStorage.setItem(returnKey, page); } catch {}
    const { error } = await client.auth.signInWithOAuth({
      provider: 'twitch',
      options: { redirectTo: filmsUrl.href }
    });
    if (error) throw error;
  } catch {
    message.textContent = 'Не удалось начать вход через Twitch. Попробуй ещё раз.';
    logIn.disabled = false;
  }
});

logOut.addEventListener('click', async () => {
  logOut.disabled = true;
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  } catch {
    message.textContent = 'Не удалось выйти. Попробуй ещё раз.';
  } finally {
    logOut.disabled = false;
  }
});

export function onViewerSession(listener) {
  listeners.push(listener);
  if (ready) listener(client, viewer?.id);
}

function finishLogin() {
  if (!viewer) return;
  try {
    const page = sessionStorage.getItem(returnKey);
    if (!page || !['index.html', 'films.html', 'watchtime.html'].includes(page)) return;
    const target = new URL(page, import.meta.url);
    if (callback && target.pathname !== location.pathname) {
      location.replace(target);
      return;
    }
    if ((callback && page === 'films.html') || (!callback && page !== 'films.html' && target.pathname === location.pathname)) {
      sessionStorage.removeItem(returnKey);
      if (!opening) {
        opening = true;
        openViewerAccount();
      }
    }
  } catch { /* The session still works without restoring the previous page. */ }
}

async function initialize() {
  try {
    const response = await fetch(new URL('data/rating-config.json', import.meta.url));
    const config = response.ok ? await response.json() : null;
    if (!config) {
      message.textContent = 'Вход через Twitch пока недоступен на этой версии сайта.';
      return;
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('supabase.js', import.meta.url);
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
    client = window.supabase.createClient(config.url, config.key, {
      auth: { flowType: 'pkce', storageKey: sessionKey, storage }
    });
    client.auth.onAuthStateChange((event, session) => {
      const user = session?.user;
      const signedIn = user?.app_metadata?.provider === 'twitch';
      if (ready && viewer?.id === (signedIn ? user.id : undefined)) return;
      statsRequest?.abort();
      const data = user?.identities?.find(identity => identity.provider === 'twitch')?.identity_data ??
        user?.user_metadata ?? {};
      const login = [data.name, data.full_name, data.preferred_username]
        .find(value => typeof value === 'string' && /^[a-z0-9_]{1,25}$/i.test(value))?.toLowerCase();
      const picture = data.avatar_url || data.picture;
      viewer = signedIn ? {
        id: user.id, login: login ?? '', displayName: data.nickname || data.slug || login || 'Зритель',
        avatar: typeof picture === 'string' && /^https:\/\/static-cdn\.jtvnw\.net\//.test(picture) ? picture : null
      } : undefined;
      ready = true;
      logIn.disabled = false;
      message.textContent = !viewer && callback ? 'Не удалось завершить вход через Twitch. Попробуй ещё раз.' : '';
      displayProfile();
      for (const listener of listeners) listener(client, viewer?.id);
      // Auth holds its session lock while delivering this callback.
      setTimeout(() => {
        finishLogin();
        if (dialog.open && viewer && (!statsRequest || statsRequest.signal.aborted)) void loadStats();
      }, 0);
      if (event === 'SIGNED_OUT' && dialog.open) logIn.focus();
    });
  } catch {
    message.textContent = 'Вход через Twitch временно недоступен.';
  }
}

void initialize();
