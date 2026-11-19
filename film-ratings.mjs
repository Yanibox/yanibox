import { element } from './core.mjs';

const sessionKey = 'yanibox-viewer-session';
const sessionStorageWithoutProviderTokens = {
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

async function connect() {
  const response = await fetch(new URL('data/rating-config.json', import.meta.url));
  if (!response.ok) return null;
  const config = await response.json();
  if (!config) return null;

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('supabase.js', import.meta.url);
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return window.supabase.createClient(config.url, config.key, {
    auth: { flowType: 'pkce', storageKey: sessionKey, storage: sessionStorageWithoutProviderTokens }
  });
}

export function filmRatings(onChange) {
  const panel = document.getElementById('viewer-auth');
  const accountButton = document.getElementById('viewer-account');
  const message = document.getElementById('viewer-auth-message');
  let client;
  let viewerId;
  let ratings;
  let loadId = 0;

  async function login() {
    message.textContent = '';
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'twitch',
        options: { redirectTo: new URL('films.html', location.href).href }
      });
      if (error) throw error;
    } catch {
      message.textContent = 'Не удалось начать вход через Twitch. Попробуй ещё раз.';
      return false;
    }
    return true;
  }

  async function loadRatings() {
    const id = ++loadId;
    let nextRatings = null;
    try {
      const { data, error } = await client.rpc('get_film_ratings');
      if (!error) nextRatings = data;
    } catch {
      // Keep the catalog usable when ratings cannot be loaded.
    }
    if (id !== loadId) return;
    ratings = nextRatings;
    onChange();
  }

  accountButton.addEventListener('click', async () => {
    accountButton.disabled = true;
    if (viewerId) {
      try {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw error;
      } catch {
        message.textContent = 'Не удалось выйти. Попробуй ещё раз.';
      }
    } else {
      await login();
    }
    accountButton.disabled = false;
  });

  async function initialize() {
    try {
      client = await connect();
      if (!client) return;
      panel.hidden = false;
      client.auth.onAuthStateChange((event, session) => {
        const nextViewer = session?.user.app_metadata?.provider === 'twitch' ? session.user.id : undefined;
        if (event !== 'INITIAL_SESSION' && nextViewer === viewerId) return;
        if (viewerId !== nextViewer) {
          viewerId = nextViewer;
          ratings = undefined;
          loadId++;
        }
        accountButton.textContent = viewerId ? 'Выйти' : 'Войти через Twitch';
        accountButton.hidden = false;
        onChange();
        // Supabase Auth holds its session lock while delivering this callback.
        setTimeout(() => void loadRatings(), 0);
      });
    } catch {
      panel.hidden = false;
      message.textContent = 'Вход через Twitch временно недоступен.';
    }
  }

  function forMovie(item) {
    if (!client || item.status !== 'watched') return null;
    const block = element('div', null, 'viewer-rating');
    const current = ratings && Object.hasOwn(ratings, item.id) ? ratings[item.id] : null;
    const label = ratings === undefined ? 'Зрители: загружаем оценки…' :
      ratings === null ? 'Зрители: оценки временно недоступны' :
      current?.votes ? `Зрители: ${Number(current.average).toLocaleString('ru')} / 10 · голосов: ${current.votes}` :
      'Зрители: пока без оценок';
    block.append(element('p', label));
    if (!current) return block;

    if (!viewerId) {
      const button = element('button', 'Войти, чтобы оценить');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        if (!await login()) button.disabled = false;
      });
      block.append(button);
      return block;
    }

    const form = element('form', null, 'viewer-vote');
    const select = element('select');
    select.required = true;
    select.setAttribute('aria-label', 'Твоя оценка: ' + item.title);
    select.add(new Option('Оценка', ''));
    for (let score = 1; score <= 10; score++) select.add(new Option(`${score} / 10`, String(score)));
    select.value = current.mine == null ? '' : String(current.mine);
    const submit = element('button', current.mine == null ? 'Оценить' : 'Изменить');
    const result = element('p', '', 'hint');
    result.setAttribute('role', 'status');
    submit.type = 'submit';
    form.append(select, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const voter = viewerId;
      select.disabled = submit.disabled = true;
      result.textContent = '';
      try {
        const { data, error } = await client.rpc('set_film_rating', {
          movie_id: item.id, score: Number(select.value)
        });
        if (voter !== viewerId) return;
        if (error) throw error;
        if (ratings) ratings[item.id] = data;
        block.firstElementChild.textContent = `Зрители: ${Number(data.average).toLocaleString('ru')} / 10 · голосов: ${data.votes}`;
        submit.textContent = 'Изменить';
        result.textContent = 'Оценка сохранена.';
      } catch {
        result.textContent = 'Не удалось сохранить оценку. Попробуй ещё раз.';
      } finally {
        select.disabled = submit.disabled = false;
      }
    });
    block.append(form, result);
    return block;
  }

  void initialize();
  return { forMovie };
}
