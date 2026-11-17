import { addRedemption, categories, checkData, element, film, statuses } from './core.mjs';
import { checkOwner, readGithub, writeGithub } from './github.mjs';
import { beginLogin, finishLogin, getRewards, listen, redirectUri, validate } from './twitch.mjs';

const byId = id => document.getElementById(id);
const form = byId('editor');
const fields = form.elements;
const token = byId('github-token');
const repo = 'Yanibox/kinoclub';
const client = byId('client');
const reward = byId('reward');
const auto = byId('auto-publish');
const namespace = 'yanibox-kino:' + new URL('.', import.meta.url).pathname;
const draftKey = namespace + ':draft';
let githubToken = '';
let twitchCallback;
let state;
let dirty = false;
let editing = '';
let busy = false;
let autoPending = false;
let autoTimer;
let auth;
let identity;
let stopSocket;
let validateTimer;
let twitchGeneration = 0;
const say = (id, text) => { byId(id).textContent = text; };
const lock = (name, action) => navigator.locks
  ? navigator.locks.request(namespace + ':' + name, action)
  : Promise.resolve().then(action);

function readLocal() {
  const saved = localStorage.getItem(draftKey);
  if (!saved) return;
  const { data, changed } = JSON.parse(saved);
  state = checkData(data);
  dirty = Boolean(changed);
}

function saveLocal(data, changed) {
  localStorage.setItem(draftKey, JSON.stringify({ data, changed }));
  state = data;
  dirty = changed;
  render();
}

function errorText(error) {
  return error instanceof TypeError ? 'Нет связи с сервисом. Проверь интернет и попробуй снова.' : error.message;
}

function renderPublish() {
  say('dirty', dirty ? 'Есть неопубликованные изменения' : '');
  say('github-state', busy ? 'Синхронизация…' : dirty ? 'Черновик' : 'Список загружен');
  byId('publish').disabled = busy || !state || !dirty || !githubToken;
  byId('reload').disabled = busy || !githubToken;
  byId('logout').disabled = busy;
}

function edit(item) {
  form.reset();
  editing = item?.id || '';
  if (item) for (const name of ['title', 'viewer', 'category', 'status', 'rating', 'poster', 'note']) {
    fields[name].value = item[name] ?? '';
  }
  say('edit-title', item ? 'Редактировать фильм' : 'Добавить фильм');
  byId('cancel').hidden = !item;
  if (item) fields.title.focus();
}

function render() {
  renderPublish();
  if (!state) return;
  say('admin-count', `Всего: ${state.items.length}`);
  byId('categories').replaceChildren(...categories(state.items).map(value => new Option(value, value)));
  const rows = [...state.items].reverse().map(item => {
    const row = element('li');
    const name = element('div');
    name.append(element('strong', item.title), element('div',
      [statuses[item.status], item.category, item.viewer, item.rating == null ? '' : item.rating + '/10']
        .filter(Boolean).join(' · '), 'hint'));
    const actions = element('div', null, 'film-meta');
    const change = element('button', 'Изменить');
    change.addEventListener('click', () => edit(item));
    const remove = element('button', 'Удалить');
    remove.addEventListener('click', async () => {
      if (!confirm(`Удалить «${item.title}» из списка?`)) return;
      try {
        await lock('draft', () => {
          readLocal();
          saveLocal({ ...state, items: state.items.filter(film => film.id !== item.id) }, true);
          if (editing === item.id) edit();
        });
      } catch (error) { say('edit-message', errorText(error)); }
    });
    actions.append(change, remove);
    row.append(name, actions);
    return row;
  });
  byId('queue').replaceChildren(...(rows.length ? rows : [element('li', 'Очередь пока пуста.', 'muted')]));
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!githubToken) return;
  const values = Object.fromEntries(new FormData(form));
  const id = editing;
  try {
    await lock('draft', () => {
      readLocal();
      const previous = state.items.find(item => item.id === id);
      if (id && !previous) throw new Error('Фильм уже удалён. Открой другой заказ.');
      const item = film(values, previous);
      if (!item.title) throw new Error('Введи название фильма.');
      if (values.poster.trim() && !item.poster) throw new Error('Ссылка на постер должна начинаться с https://.');
      const items = previous ? state.items.map(row => row.id === id ? item : row) : [...state.items, item];
      saveLocal({ ...state, items }, true);
    });
    edit();
    say('edit-message', 'Фильм сохранён в черновике.');
  } catch (error) { say('edit-message', errorText(error)); }
});
byId('cancel').addEventListener('click', () => edit());
for (const [value, label] of Object.entries(statuses)) fields.status.add(new Option(label, value));

async function sync(action) {
  if (busy || !githubToken) return;
  const credential = githubToken;
  busy = true;
  renderPublish();
  say('publish-message', '');
  try {
    await lock('github', () => action(credential));
  } catch (error) {
    say('publish-message', errorText(error));
  } finally {
    busy = false;
    renderPublish();
    if (autoPending) schedulePublish();
  }
}

function publish() {
  if (!githubToken || busy) return;
  autoPending = false;
  return sync(async credential => {
    const snapshot = await lock('draft', () => {
      readLocal();
      return dirty ? state : null;
    });
    if (!snapshot) return;
    const original = JSON.stringify(snapshot);
    const revision = await writeGithub(repo, credential, snapshot);
    await lock('draft', () => {
      readLocal();
      saveLocal({ ...state, revision }, JSON.stringify(state) !== original);
    });
    say('publish-message', 'Список сохранён на GitHub. Витрина обновится после публикации GitHub Pages.');
  });
}

function schedulePublish() {
  if (!auto.checked || !githubToken) {
    autoPending = false;
    return;
  }
  autoPending = true;
  clearTimeout(autoTimer);
  if (!busy) autoTimer = setTimeout(() => {
    if (auto.checked) publish();
  }, 5000);
}

byId('publish').addEventListener('click', publish);
byId('reload').addEventListener('click', () => sync(async credential => {
  const original = localStorage.getItem(draftKey);
  const { data } = await readGithub(repo, credential);
  await lock('draft', () => {
    if (original !== localStorage.getItem(draftKey)) throw new Error('Очередь обновилась. Повтори загрузку.');
    readLocal();
    if (dirty && !confirm('Заменить неопубликованный черновик версией с GitHub?')) return;
    saveLocal(data, false);
    edit();
    say('publish-message', 'Загружена версия с GitHub.');
  });
}));
window.addEventListener('storage', event => {
  if (githubToken && event.key === draftKey) {
    readLocal();
    render();
  }
});

function twitchStatus(status, message) {
  say('twitch-state', status);
  say('twitch-message', message);
}

function disconnect(status = 'Отключён', message = '') {
  twitchGeneration++;
  stopSocket?.();
  stopSocket = undefined;
  identity = undefined;
  auth = undefined;
  clearInterval(validateTimer);
  sessionStorage.removeItem(namespace + ':twitch');
  reward.disabled = true;
  reward.replaceChildren(new Option('Подключи Twitch', ''));
  byId('twitch-stop').hidden = true;
  twitchStatus(status, message);
}

async function receive(event) {
  try {
    const changed = await lock('draft', () => {
      if (!githubToken) return false;
      readLocal();
      const next = addRedemption(state, event);
      if (next) saveLocal(next, true);
      return Boolean(next);
    });
    if (changed) {
      say('twitch-message', 'Добавлен заказ от ' + (event.user_login || event.user_name || 'зрителя') + '.');
      schedulePublish();
    }
  } catch (error) { say('twitch-message', 'Заказ не сохранён. ' + errorText(error)); }
}

function selectReward() {
  stopSocket?.();
  const key = namespace + ':reward:' + identity.user_id;
  localStorage.setItem(key, reward.value);
  if (!reward.value) {
    twitchStatus('Twitch подключён', 'Выбери награду для заказов.');
    return;
  }
  stopSocket = listen({ auth, userId: identity.user_id, rewardId: reward.value, onEvent: receive, onStatus: twitchStatus });
}

async function connect(credentials) {
  const version = ++twitchGeneration;
  byId('twitch-stop').hidden = false;
  twitchStatus('Подключение', 'Проверяем доступ к наградам.');
  try {
    const user = await validate(credentials);
    const rewards = await getRewards(credentials, user.user_id);
    if (version !== twitchGeneration) return;
    auth = credentials;
    identity = user;
    sessionStorage.setItem(namespace + ':twitch', JSON.stringify(credentials));
    client.value = credentials.clientId;
    reward.replaceChildren(new Option('Выбрать награду', ''), ...rewards.map(entry =>
      new Option(`${entry.title} · ${entry.cost} баллов`, entry.id)));
    reward.disabled = !rewards.length;
    const remembered = localStorage.getItem(namespace + ':reward:' + user.user_id);
    if (rewards.some(entry => entry.id === remembered)) {
      reward.value = remembered;
      selectReward();
    } else {
      twitchStatus('Twitch подключён', rewards.length ? 'Канал: ' + user.login + '. Выбери награду.' :
        'На канале нет активной награды с обязательным вводом текста.');
    }
    validateTimer = setInterval(async () => {
      try { await validate(credentials); } catch (error) {
        if (version === twitchGeneration) disconnect('Нужен вход', errorText(error));
      }
    }, 55 * 60 * 1000);
  } catch (error) {
    if (version === twitchGeneration) disconnect('Ошибка подключения', errorText(error));
  }
}

byId('redirect').textContent = redirectUri;
client.value = localStorage.getItem(namespace + ':client') || '';
byId('copy-redirect').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(redirectUri);
    say('twitch-message', 'Адрес скопирован.');
  } catch { say('twitch-message', 'Выдели и скопируй адрес рядом с кнопкой.'); }
});
byId('twitch-login').addEventListener('click', () => {
  try {
    const value = client.value.trim();
    localStorage.setItem(namespace + ':client', value);
    beginLogin(value);
  } catch (error) { say('twitch-message', errorText(error)); }
});
byId('twitch-stop').addEventListener('click', () => disconnect());
reward.addEventListener('change', selectReward);

try {
  twitchCallback = finishLogin();
  if (twitchCallback) say('login-message', 'Twitch подтвердил вход. Войди в панель, чтобы продолжить.');
} catch (error) { say('login-message', errorText(error)); }

byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('login-button');
  const credential = token.value.trim();
  if (!credential || button.disabled || githubToken) return;
  button.disabled = true;
  token.value = '';
  say('login-message', 'Проверяем доступ…');
  try {
    await checkOwner(repo, credential);
    const { data } = await readGithub(repo, credential);
    await lock('draft', () => {
      readLocal();
      if (!dirty) saveLocal(data, false);
    });
    githubToken = credential;
    byId('login').hidden = true;
    byId('workspace').hidden = false;
    byId('workspace').inert = false;
    byId('logout').focus();
    render();
    const twitchCredentials = twitchCallback || JSON.parse(sessionStorage.getItem(namespace + ':twitch') || 'null');
    twitchCallback = undefined;
    if (twitchCredentials) await connect(twitchCredentials);
  } catch (error) {
    say(githubToken ? 'twitch-message' : 'login-message', errorText(error));
  } finally { button.disabled = false; }
});

byId('logout').addEventListener('click', () => {
  githubToken = '';
  autoPending = false;
  clearTimeout(autoTimer);
  auto.checked = false;
  disconnect();
  edit();
  state = undefined;
  dirty = false;
  byId('queue').replaceChildren();
  byId('categories').replaceChildren();
  byId('workspace').inert = true;
  byId('workspace').hidden = true;
  byId('login').hidden = false;
  say('login-message', 'Ты вышел из панели.');
  token.focus();
});
