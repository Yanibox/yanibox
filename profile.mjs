import { session, setSession, settings, viewerRequest, onSessionChange } from './viewer-account.mjs?v=passkeys';
import { formatDuration } from './watchtime-period.mjs';

const get = id => document.getElementById('viewer-' + id);
const part = selector => document.querySelector(selector);
const guest = part('.viewer-guest');
const member = part('.viewer-member');
const identity = part('.viewer-identity');
const message = part('.viewer-message');
const webauthn = window.SimpleWebAuthnBrowser;
const errors = {
  'rate-limit': 'Слишком много попыток. Попробуй через несколько минут.',
  'invalid-recovery': 'Код восстановления недействителен или уже использован.',
  'invalid-name': 'Введи ник длиной от 2 до 32 символов.',
  'invalid-twitch': 'Этот логин Twitch не найден. Проверь написание.',
  'already-linked': 'Этот Twitch уже привязан к профилю.',
  'twitch-unavailable': 'Сейчас Twitch недоступен. Попробуй позже.',
  passkey: 'Не удалось подтвердить ключ доступа. Попробуй ещё раз.',
  session: 'Сессия закончилась. Войди ещё раз.',
};
let view;
let polling;
let enabled = false;

function showError(error) {
  message.textContent = error.name === 'NotAllowedError' || error.code === 'ERROR_CEREMONY_ABORTED'
    ? 'Ввод ключа доступа отменён или время ожидания истекло.'
    : errors[error.message] ?? 'Не удалось выполнить действие. Попробуй ещё раз.';
}

function stat(key, value, detail) {
  part(`[data-stat="${key}"]`).textContent = value ?? '—';
  part(`[data-detail="${key}"]`).textContent = detail;
}

async function loadStats(login, signal) {
  for (const key of ['time', 'messages', 'emotes']) stat(key, null, 'Загрузка…');
  const show = (key, entry, field, format, explain) => {
    const index = entry?.viewers?.findIndex(row => row.name.toLowerCase() === login) ?? -1;
    const value = index < 0 ? null : entry.viewers[index][field];
    stat(key, value == null ? null : format(value),
      value == null ? (entry ? 'Нет записи в WizeBot' : 'WizeBot недоступен') :
        entry.stale ? 'Последний снимок WizeBot' : explain(index));
  };
  fetch('data/watchtime.json', { cache: 'no-cache', signal }).then(response => {
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  }).then(data => {
    if (signal.aborted) return;
    show('time', data.periods?.global, 'seconds', formatDuration, index => `№ ${index + 1} в рейтинге`);
    show('messages', data.messages, 'count', count => count.toLocaleString('ru-RU'), () => 'За всё время · WizeBot');
  }).catch(() => {
    if (signal.aborted) return;
    stat('time', null, 'WizeBot недоступен');
    stat('messages', null, 'WizeBot недоступен');
  });
  viewerRequest('emotes', {}, signal).then(({ count }) => {
    if (!signal.aborted) stat('emotes', count?.toLocaleString('ru-RU'), count == null ? 'Нет данных' : 'С начала сбора');
  }).catch(() => {
    if (!signal.aborted) stat('emotes', null, 'Нет данных');
  });
}

function closeCode() {
  polling?.abort();
  get('link-code').hidden = true;
  get('command').textContent = '';
}

async function showProfile(profile, refresh = true) {
  view?.abort();
  const { signal } = (view = new AbortController());
  guest.hidden = Boolean(profile) || !enabled;
  member.hidden = identity.hidden = !profile;
  if (!profile) {
    closeCode();
    return;
  }
  part('.viewer-name').textContent = profile.name;
  part('.viewer-handle').textContent = profile.twitch ? '@' + profile.twitch : '';
  get('link-section').hidden = Boolean(profile.twitch);
  get('unlink').hidden = !profile.twitch;
  part('.viewer-stats').hidden = !profile.twitch;
  if (!profile.twitch) return;
  closeCode();
  let login = profile.twitch;
  if (refresh) {
    try {
      ({ twitch: login } = await viewerRequest('refresh-twitch', {}, signal));
    } catch {}
    if (signal.aborted) return;
    if (!login) {
      await reload();
      return;
    }
    part('.viewer-handle').textContent = '@' + login;
  }
  void loadStats(login, signal);
}

async function reload() {
  if (!enabled) return;
  if (!session()) {
    await showProfile(null);
    return;
  }
  const token = session();
  try {
    const profile = await viewerRequest('profile');
    if (token === session()) await showProfile(profile);
  } catch (error) {
    if (!session()) await showProfile(null);
    showError(error);
  }
}

function task(control, run) {
  return async event => {
    if (event.type === 'submit') event.preventDefault();
    if (control.disabled) return;
    control.disabled = true;
    message.textContent = '';
    try {
      await run(event);
    } catch (error) {
      if (!session() && guest.hidden && get('recovery-saved').hidden) await showProfile(null);
      showError(error);
    } finally {
      control.disabled = false;
    }
  };
}

function submit(id, run) {
  const form = get(id);
  form.addEventListener('submit', task(form.querySelector('button'), () => run(new FormData(form))));
}

function click(id, run) {
  const button = get(id);
  button.addEventListener('click', task(button, run));
}

async function ceremony(action, data = {}) {
  if (!webauthn?.browserSupportsWebAuthn()) {
    message.textContent = 'В этом браузере ключи доступа недоступны. Открой сайт в другом браузере.';
    return;
  }
  const { id, options } = await viewerRequest(action + '-begin', data);
  const response = action === 'login'
    ? await webauthn.startAuthentication({ optionsJSON: options })
    : await webauthn.startRegistration({ optionsJSON: options });
  const result = await viewerRequest(action + '-finish', { id, response });
  if (result.recovery) {
    guest.hidden = true;
    get('recover').reset();
    get('recovery-code').textContent = result.recovery.match(/.{8}/g).join('-');
    get('recovery-saved').hidden = false;
    get('recovery-title').focus();
  }
  try {
    setSession(result.session);
  } catch {
    message.textContent = 'Браузер запретил сохранение входа. Разреши хранение данных сайта и войди с ключом доступа.';
    return;
  }
  if (!result.recovery) await reload();
}

submit('register', data => ceremony('register', { name: data.get('name') }));
click('login', () => ceremony('login'));
submit('recover', data => ceremony('recover', {
  recovery: data.get('recovery').replace(/[\s-]/g, '').toLowerCase(),
}));
click('recovery-done', async () => {
  get('recovery-code').textContent = '';
  get('recovery-saved').hidden = true;
  await reload();
});

submit('link', async data => {
  closeCode();
  const { code } = await viewerRequest('link', { login: data.get('login') });
  get('command').textContent = '!привязать ' + code;
  get('link-code').hidden = false;
  const { signal } = (polling = new AbortController());
  const deadline = Date.now() + 300000;
  async function check() {
    if (signal.aborted) return;
    try {
      const profile = await viewerRequest('profile', {}, signal);
      if (signal.aborted) return;
      if (profile.twitch) {
        await showProfile(profile, false);
        message.textContent = 'Twitch привязан.';
        return;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (!session()) {
        await showProfile(null);
        showError(error);
        return;
      }
    }
    if (Date.now() >= deadline) {
      closeCode();
      message.textContent = 'Код истёк. Получи новый код для привязки.';
    } else setTimeout(check, 3500);
  }
  setTimeout(check, 3500);
});

click('copy-command', async () => {
  try {
    await navigator.clipboard.writeText(get('command').textContent);
    message.textContent = 'Команда скопирована.';
  } catch {
    message.textContent = 'Выдели и скопируй команду вручную.';
  }
});
click('logout', async () => {
  await viewerRequest('logout');
  setSession(null);
  await showProfile(null);
});
click('unlink', async () => {
  if (!confirm('Отвязать Twitch и удалить твои оценки фильмов?')) return;
  await viewerRequest('unlink');
  await reload();
});
click('delete', async () => {
  if (!confirm('Удалить профиль, ключ доступа на Yanibox и твои оценки фильмов?')) return;
  await viewerRequest('delete');
  setSession(null);
  await showProfile(null);
  message.textContent = 'Профиль удалён.';
});

onSessionChange(() => {
  if (get('recovery-saved').hidden) void reload();
});
enabled = Boolean(await settings());
if (enabled) {
  message.textContent = '';
  await reload();
} else message.textContent = 'Профиль временно недоступен.';
