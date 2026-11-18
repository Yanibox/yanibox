import {
  addRedemption, categories, checkData, element, film, loadCatalog, orderDateLabel, posterUrl,
  statuses, uploadedPoster, viewingDateLabel
} from './core.mjs';
import { checkOwner, readGithub, writeGithub } from './github.mjs';
import { findMovieInfo, loadMovieInfo, movieDetails, movieKey, runtimeLabel } from './movie-info.mjs';
import { beginLogin, finishLogin, getRewards, listen, redirectUri, validate } from './twitch.mjs';

const byId = id => document.getElementById(id);
const form = byId('editor');
const fields = form.elements;
const token = byId('github-token');
const repo = 'Yanibox/yanibox';
const client = byId('client');
const rewardsField = byId('rewards');
const rewardOptions = byId('reward-options');
const auto = byId('auto-publish');
const posterFile = byId('poster-file');
const posterPreview = byId('poster-preview');
const sitePath = new URL('.', import.meta.url).pathname;
// Сохраняем доступ к черновикам и настройкам со старого адреса GitHub Pages.
const namespace = 'yanibox-kino:' + (sitePath === '/yanibox/' ? '/kinoclub/' : sitePath);
const draftKey = namespace + ':draft';
const autoKey = namespace + ':auto-publish';
let githubToken = '';
let twitchCallback;
let state;
let dirty = false;
let editing = '';
let uploads = {};
let newPoster = '';
let clearPoster = false;
let preparingPoster = false;
let savingEditor = false;
let visibilityCheck = 0;
let busy = false;
let autoPending = false;
let autoTimer;
let auth;
let identity;
let stopSocket;
let validateTimer;
let twitchGeneration = 0;
const selectedRewards = new Set();
let subscriptionStatus = '';
let subscriptionMessage = '';
const movieRecords = Object.create(null);
const pendingMovieInfo = new Set();
const say = (id, text) => { byId(id).textContent = text; };
const lock = (name, action) => navigator.locks
  ? navigator.locks.request(namespace + ':' + name, action)
  : Promise.resolve().then(action);

function readLocal() {
  const saved = localStorage.getItem(draftKey);
  if (!saved) return;
  const { data, changed, posters = {} } = JSON.parse(saved);
  state = checkData(data);
  dirty = Boolean(changed);
  uploads = posters;
}

function saveLocal(data, changed, posters = uploads) {
  const used = new Set(data.items.map(item => item.poster));
  const pending = Object.fromEntries(Object.entries(posters).filter(([path]) => used.has(path)));
  try {
    localStorage.setItem(draftKey, JSON.stringify({ data, changed, posters: pending }));
  } catch (error) {
    if (error.name === 'QuotaExceededError') throw new Error('В браузере не хватило места. Опубликуй предыдущие черновики с постерами и попробуй снова.');
    throw error;
  }
  state = data;
  dirty = changed;
  uploads = pending;
  render();
}

function errorText(error) {
  return error instanceof TypeError ? 'Нет связи с сервисом. Проверь интернет и попробуй снова.' : error.message;
}

function renderPublish() {
  say('dirty', dirty ? 'Есть неопубликованные изменения' : '');
  say('github-state', busy ? 'Синхронизация…' : dirty ? 'Черновик' : 'Список загружен');
  byId('publish').disabled = busy || savingEditor || !state || !dirty || !githubToken;
  byId('reload').disabled = busy || savingEditor || !githubToken;
  byId('logout').disabled = busy || savingEditor;
  byId('save-publish').disabled = busy || preparingPoster || savingEditor;
  byId('save-draft').disabled = busy || preparingPoster || savingEditor;
}

function edit(item) {
  form.reset();
  newPoster = '';
  clearPoster = false;
  preparingPoster = false;
  editing = item?.id || '';
  if (item) for (const name of ['title', 'viewer', 'category', 'status', 'rating', 'runtime', 'watchedOn', 'note']) {
    fields[name].value = item[name] ?? '';
  }
  if (item && !uploadedPoster(item.poster)) fields.poster.value = item.poster;
  showMovieSuggestion(item);
  renderPublish();
  say('edit-title', item ? 'Редактировать фильм' : 'Добавить фильм');
  byId('cancel').hidden = !item;
  if (item) fields.title.focus();
}

function showMovieSuggestion(item) {
  const details = item && movieDetails(item, movieRecords);
  fields.runtime.placeholder = details?.runtime ? runtimeLabel(details.runtime) : 'Найдётся по названию';
  if (preparingPoster) return;
  const link = fields.poster.value.trim();
  const saved = !clearPoster && uploadedPoster(item?.poster) ? item.poster : '';
  const ownPoster = newPoster || (link ? posterUrl(link) : uploads[saved] || saved);
  const sameTitle = item?.title === fields.title.value.trim();
  const source = ownPoster || (sameTitle ? movieDetails({ ...item, poster: '' }, movieRecords).poster : '');
  byId('remove-poster').hidden = !(newPoster || link || saved);
  if (posterPreview.getAttribute('src') === source) return;
  posterPreview.hidden = true;
  if (source) posterPreview.src = source;
  else posterPreview.removeAttribute('src');
  say('poster-message', source ? 'Проверяем изображение…' : 'Без своего постера сайт попробует найти обложку по названию фильма.');
}

function refreshPoster() {
  showMovieSuggestion(state?.items.find(item => item.id === editing));
}

posterPreview.addEventListener('load', () => {
  posterPreview.hidden = false;
  say('poster-message', 'Изображение загружено.');
});
posterPreview.addEventListener('error', () => {
  posterPreview.hidden = true;
  say('poster-message', 'Изображение не открылось. Укажи прямую ссылку или загрузи файл.');
});
fields.poster.addEventListener('input', () => {
  if (fields.poster.value) {
    posterFile.value = '';
    preparingPoster = false;
    newPoster = '';
    clearPoster = true;
    renderPublish();
  }
  refreshPoster();
});
fields.title.addEventListener('input', refreshPoster);
fields.watchedOn.addEventListener('change', () => {
  if (fields.watchedOn.value) fields.status.value = 'watched';
});
byId('remove-poster').addEventListener('click', () => {
  posterFile.value = '';
  fields.poster.value = '';
  newPoster = '';
  clearPoster = true;
  preparingPoster = false;
  refreshPoster();
  renderPublish();
});

async function preparePoster(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('Выбери изображение до 10 МБ.');
  const image = await createImageBitmap(file).catch(() => null);
  if (!image) throw new Error('Не удалось открыть файл. Подойдут JPEG, PNG, WebP или AVIF.');
  try {
    const scale = Math.min(1, 720 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL('image/webp', .8);
    if (!encoded.startsWith('data:image/webp;base64,') || encoded.length > 400000) {
      throw new Error('Не удалось подготовить постер. Выбери изображение меньшего размера.');
    }
    return encoded;
  } finally { image.close(); }
}

posterFile.addEventListener('change', async () => {
  const file = posterFile.files[0];
  if (!file) return;
  preparingPoster = true;
  renderPublish();
  say('poster-message', 'Готовим постер…');
  try {
    const encoded = await preparePoster(file);
    if (posterFile.files[0] !== file) return;
    newPoster = encoded;
    fields.poster.value = '';
    preparingPoster = false;
    refreshPoster();
  } catch (error) {
    if (posterFile.files[0] !== file) return;
    preparingPoster = false;
    posterFile.value = '';
    say('poster-message', errorText(error));
  } finally { renderPublish(); }
});

function render() {
  renderPublish();
  if (!state) return;
  say('admin-count', `Всего: ${state.items.length}`);
  if (editing) showMovieSuggestion(state.items.find(item => item.id === editing));
  byId('categories').replaceChildren(...categories(state.items).map(value => new Option(value, value)));
  const rows = [...state.items].reverse().map(item => {
    const row = element('li');
    const name = element('div');
    const details = movieDetails(item, movieRecords);
    const key = movieKey(item.title);
    const info = pendingMovieInfo.has(key) ? 'Ищем сведения…' : details.poster ? 'Есть постер' :
      movieRecords[key] ? 'Постер не найден' : '';
    name.append(element('strong', item.title), element('div',
      [statuses[item.status], item.category, item.viewer, item.rewardTitle,
        item.watchedOn ? `Просмотр: ${viewingDateLabel(item.watchedOn)}` : orderDateLabel(item.created),
        runtimeLabel(details.runtime), info, item.rating == null ? '' : item.rating + '/10']
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

async function previewMovieInfo(item) {
  const key = movieKey(item.title);
  const details = movieDetails(item, movieRecords);
  const checked = movieRecords[key]?.checkedAt || 0;
  if (!key || (details.poster && details.runtime) || pendingMovieInfo.has(key) ||
      Date.now() - checked < 10 * 60 * 1000) return;
  pendingMovieInfo.add(key);
  render();
  try {
    const info = await findMovieInfo(item.title);
    movieRecords[key] = { info, checkedAt: Date.now() };
  } catch {
    // Pages will retry the lookup after publication.
  } finally {
    pendingMovieInfo.delete(key);
    if (githubToken) render();
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!githubToken || busy || preparingPoster || savingEditor) return;
  const publishNow = event.submitter?.id !== 'save-draft';
  const values = Object.fromEntries(new FormData(form));
  const id = editing;
  const image = newPoster;
  const keepPoster = !clearPoster;
  savingEditor = true;
  renderPublish();
  try {
    const saved = await lock('draft', () => {
      if (!githubToken) throw new Error('Войди в панель, чтобы сохранить фильм.');
      readLocal();
      const previous = state.items.find(item => item.id === id);
      if (id && !previous) throw new Error('Фильм уже удалён. Открой другой заказ.');
      const link = values.poster.trim();
      if (link && (!posterUrl(link) || uploadedPoster(link))) throw new Error('Нужна прямая ссылка на изображение с https://.');
      values.poster = image ? `data/posters/${crypto.randomUUID()}.webp` : link ||
        (keepPoster && uploadedPoster(previous?.poster) ? previous.poster : '');
      const item = film(values, previous);
      if (!item.title) throw new Error('Введи название фильма.');
      const items = previous ? state.items.map(row => row.id === id ? item : row) : [...state.items, item];
      saveLocal({ ...state, items }, true, image ? { ...uploads, [item.poster]: image } : uploads);
      return item;
    });
    edit();
    say('edit-message', 'Фильм сохранён в черновике.');
    void previewMovieInfo(saved);
    if (publishNow) await publish('edit-message');
  } catch (error) { say('edit-message', errorText(error)); }
  finally {
    savingEditor = false;
    renderPublish();
    if (autoPending) schedulePublish();
  }
});
byId('cancel').addEventListener('click', () => edit());
for (const [value, label] of Object.entries(statuses)) fields.status.add(new Option(label, value));

async function sync(action, target = 'publish-message') {
  if (busy || !githubToken) return;
  const credential = githubToken;
  busy = true;
  renderPublish();
  say(target, '');
  try {
    await lock('github', () => action(credential));
  } catch (error) {
    say(target, target === 'edit-message' ? `Черновик сохранён. ${errorText(error)}` : errorText(error));
  } finally {
    busy = false;
    renderPublish();
    if (autoPending) schedulePublish();
  }
}

function publish(target = 'publish-message') {
  if (!githubToken || busy) return;
  autoPending = false;
  return sync(async credential => {
    const snapshot = await lock('draft', () => {
      readLocal();
      return dirty ? { data: state, posters: uploads } : null;
    });
    if (!snapshot) return;
    const original = JSON.stringify(snapshot.data);
    say(target, 'Черновик сохранён. Отправляем изменения на GitHub…');
    const revision = await writeGithub(repo, credential, snapshot.data, snapshot.posters);
    await lock('draft', () => {
      readLocal();
      const remaining = Object.fromEntries(Object.entries(uploads).filter(([path]) => !Object.hasOwn(snapshot.posters, path)));
      saveLocal({ ...state, revision }, JSON.stringify(state) !== original, remaining);
    });
    say(target, 'Сохранено на GitHub. Ждём обновления витрины…');
    void waitForCatalog(revision, target, ++visibilityCheck);
  }, target);
}

async function waitForCatalog(revision, target, check) {
  for (let attempt = 0; attempt < 20 && check === visibilityCheck; attempt++) {
    const catalog = await loadCatalog(AbortSignal.timeout(5000)).catch(() => null);
    if (check !== visibilityCheck) return;
    if (catalog?.revision === revision) {
      say(target, 'Опубликовано. Изменения уже видны в разделе «Фильмы».');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 6000));
  }
  if (check === visibilityCheck) say(target, 'Сохранено на GitHub. Витрина пока обновляется.');
}

function schedulePublish() {
  if (!auto.checked || !githubToken) {
    autoPending = false;
    return;
  }
  autoPending = true;
  clearTimeout(autoTimer);
  if (!busy && !savingEditor) autoTimer = setTimeout(() => {
    if (auto.checked && !savingEditor) publish();
  }, 5000);
}

byId('publish').addEventListener('click', () => publish());
auto.addEventListener('change', () => localStorage.setItem(autoKey, String(auto.checked)));
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
  selectedRewards.clear();
  subscriptionStatus = '';
  subscriptionMessage = '';
  rewardsField.disabled = true;
  rewardOptions.replaceChildren(element('p', 'Подключи Twitch.', 'hint'));
  byId('twitch-stop').hidden = true;
  twitchStatus(status, message);
}

async function receive(event) {
  try {
    const added = await lock('draft', () => {
      if (!githubToken || !selectedRewards.has(event.reward?.id)) return null;
      readLocal();
      const next = addRedemption(state, event);
      if (next) saveLocal(next, true);
      return next?.items.at(-1);
    });
    if (added) {
      say('twitch-message', 'Добавлен заказ от ' + (event.user_login || event.user_name || 'зрителя') + '.');
      void previewMovieInfo(added);
      schedulePublish();
    }
  } catch (error) { say('twitch-message', 'Заказ не сохранён. ' + errorText(error)); }
}

function showSubscription() {
  if (!selectedRewards.size) {
    twitchStatus('Twitch подключён', 'Отметь награды для заказов.');
  } else if (subscriptionStatus === 'Слушает награды') {
    twitchStatus(`Слушает награды · ${selectedRewards.size}`, subscriptionMessage);
  } else {
    twitchStatus(subscriptionStatus, subscriptionMessage);
  }
}

function selectRewards() {
  if (!identity) return;
  selectedRewards.clear();
  for (const checkbox of rewardOptions.querySelectorAll('input:checked')) selectedRewards.add(checkbox.value);
  localStorage.setItem(namespace + ':reward:' + identity.user_id, JSON.stringify([...selectedRewards]));
  if (selectedRewards.size && !stopSocket) {
    stopSocket = listen({
      auth, userId: identity.user_id, rewardIds: selectedRewards, onEvent: receive,
      onStatus(status, message) {
        subscriptionStatus = status;
        subscriptionMessage = message;
        if (status === 'Ошибка подписки' || status === 'Подписка отозвана') stopSocket = undefined;
        showSubscription();
      }
    });
  }
  showSubscription();
}

function rememberedRewardIds(userId) {
  const value = localStorage.getItem(namespace + ':reward:' + userId);
  // В предыдущей версии сохранялся один идентификатор без JSON.
  if (!value?.startsWith('[')) return value ? [value] : [];
  try {
    const ids = JSON.parse(value);
    return Array.isArray(ids) ? ids : [];
  } catch { return []; }
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
    rewardsField.disabled = !rewards.length;
    if (rewards.length) {
      const remembered = rememberedRewardIds(user.user_id);
      rewardOptions.replaceChildren(...rewards.map(entry => {
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.value = entry.id;
        checkbox.checked = remembered.includes(entry.id);
        const label = element('label', null, 'checkbox');
        label.append(checkbox, element('span', `${entry.title} · ${entry.cost} баллов`));
        return label;
      }));
      selectRewards();
    } else {
      rewardOptions.replaceChildren();
      twitchStatus('Twitch подключён', 'На канале нет активных наград с обязательным вводом текста.');
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
rewardOptions.addEventListener('change', selectRewards);

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
    auto.checked = localStorage.getItem(autoKey) === 'true';
    byId('login').hidden = true;
    byId('workspace').hidden = false;
    byId('workspace').inert = false;
    byId('logout').focus();
    render();
    void loadMovieInfo().then(records => {
      for (const [key, record] of Object.entries(records)) if (!Object.hasOwn(movieRecords, key)) movieRecords[key] = record;
      if (githubToken) render();
    }).catch(() => {});
    const twitchCredentials = twitchCallback || JSON.parse(sessionStorage.getItem(namespace + ':twitch') || 'null');
    twitchCallback = undefined;
    if (twitchCredentials) await connect(twitchCredentials);
  } catch (error) {
    say(githubToken ? 'twitch-message' : 'login-message', errorText(error));
  } finally { button.disabled = false; }
});

byId('logout').addEventListener('click', () => {
  githubToken = '';
  visibilityCheck++;
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
