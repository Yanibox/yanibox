import {
  addRedemption, categories, checkData, element, film, loadCatalog, mergeCatalog, orderDateLabel, posterUrl,
  statuses, uploadedPoster, viewingDate, viewingDateLabel
} from './core.mjs?v=catalog-sync';
import { CatalogChanged, checkOwner, findCatalogRevision, readGithub, writeGithub } from './github.mjs?v=catalog-sync';
import { findMovieInfo, loadMovieInfo, movieDetails, movieKey, runtimeLabel } from './movie-info.mjs?v=hours';
import { beginLogin, finishLogin, getRewards, listen, redirectUri, validate } from './twitch.mjs';
import { gamesAdmin } from './games-admin.mjs';
import { scheduleAdmin } from './schedule-admin.mjs';

const byId = id => document.getElementById(id);
const form = byId('editor');
const fields = form.elements;
const token = byId('github-token');
const repo = 'Yanibox/yanibox';
const client = byId('client');
const rewardsField = byId('rewards');
const rewardOptions = byId('reward-options');
const auto = byId('auto-publish');
const posterPreview = byId('poster-preview');
const sitePath = new URL('.', import.meta.url).pathname;
// Сохраняем доступ к черновикам и настройкам со старого адреса GitHub Pages.
const namespace = 'yanibox-kino:' + (sitePath === '/yanibox/' ? '/kinoclub/' : sitePath);
const draftKey = namespace + ':draft';
const autoKey = namespace + ':auto-publish';
let githubToken = '';
const streams = scheduleAdmin(repo, () => githubToken);
const games = gamesAdmin(namespace, () => Boolean(githubToken));
const sections = [...document.querySelectorAll('[data-admin-section]')];
function openSection(section) {
  for (const button of sections) {
    const selected = button.dataset.adminSection === section;
    byId(button.getAttribute('aria-controls')).hidden = !selected;
    button.setAttribute('aria-pressed', String(selected));
  }
  if (section === 'schedule') streams.show();
  if (section === 'games') games.show();
}
for (const button of sections) button.addEventListener('click', () => openSection(button.dataset.adminSection));
let twitchCallback;
let state;
let baseData;
let knownPublished;
let dirty = false;
let editing = '';
let uploads = {};
let clearPoster = false;
let movieSearchTimer;
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
const pendingMovieInfo = new Map();
const say = (id, text) => { byId(id).textContent = text; };
const lock = (name, action) => navigator.locks
  ? navigator.locks.request(namespace + ':' + name, action)
  : Promise.resolve().then(action);

function readLocal() {
  const saved = localStorage.getItem(draftKey);
  if (!saved) return;
  const { data, changed, posters = {}, base } = JSON.parse(saved);
  state = checkData(data);
  dirty = Boolean(changed);
  baseData = dirty ? (base?.revision === state.revision ? checkData(base) : undefined) : state;
  uploads = posters;
}

function saveLocal(data, changed, posters = uploads, base = baseData) {
  const used = new Set(data.items.map(item => item.poster));
  const pending = Object.fromEntries(Object.entries(posters).filter(([path]) => used.has(path)));
  try {
    localStorage.setItem(draftKey, JSON.stringify({ data, changed, posters: pending, base: changed ? base : undefined }));
  } catch (error) {
    if (error.name === 'QuotaExceededError') throw new Error('В браузере не хватило места. Опубликуй предыдущие черновики с постерами и попробуй снова.');
    throw error;
  }
  state = data;
  dirty = changed;
  baseData = changed ? base : data;
  if (!changed) knownPublished = data;
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
  byId('save-publish').disabled = busy || savingEditor;
  byId('save-draft').disabled = busy || savingEditor;
}

function updateScheduleForm() {
  const planned = fields.status.value === 'planned';
  byId('planned-date-field').hidden = !planned;
  byId('planned-time-field').hidden = !planned;
  byId('planned-hint').hidden = !planned;
  fields.plannedOn.disabled = !planned;
  fields.plannedTime.disabled = !planned;
  fields.plannedOn.required = planned;
}

function edit(item, plan = false) {
  form.reset();
  clearPoster = false;
  editing = item?.id || '';
  if (item) for (const name of ['title', 'viewer', 'source', 'category', 'status', 'rating', 'runtime', 'watchedOn', 'orderedOn', 'plannedOn', 'plannedTime', 'note']) {
    fields[name].value = item[name] ?? '';
  }
  if (plan) fields.status.value = 'planned';
  updateScheduleForm();
  if (item && !uploadedPoster(item.poster)) fields.poster.value = item.poster;
  queueMovieSearch();
  renderPublish();
  say('edit-title', item ? 'Редактировать фильм' : 'Добавить фильм');
  byId('cancel').hidden = !item;
  if (item) (plan ? fields.plannedOn : fields.title).focus();
}

function showMovieSuggestion(item) {
  const title = fields.title.value.trim();
  const key = movieKey(title);
  const record = movieRecords[key];
  const remembered = item && movieKey(item.title) === key ? item.autoPoster : '';
  const details = movieDetails({ title, autoPoster: remembered }, movieRecords);
  fields.runtime.placeholder = details.runtime ? runtimeLabel(details.runtime) : 'Найдётся по названию';
  const link = fields.poster.value.trim();
  const saved = !clearPoster && uploadedPoster(item?.poster) ? item.poster : '';
  const source = (link ? posterUrl(link) : uploads[saved] || saved) || details.poster;
  byId('remove-poster').hidden = !(link || saved);
  if (source) {
    if (posterPreview.getAttribute('src') === source) return;
    posterPreview.hidden = true;
    posterPreview.src = source;
    say('poster-message', 'Загружаем постер…');
    return;
  }
  posterPreview.hidden = true;
  posterPreview.removeAttribute('src');
  let message = 'Введи название фильма для поиска постера.';
  if (key) {
    if (pendingMovieInfo.has(key) || !record) message = 'Ищем постер по названию…';
    else if (record.error) message = 'Поиск пока недоступен. Сайт попробует ещё раз при публикации.';
    else message = 'Постер не найден. Попробуй добавить год выпуска к названию.';
  }
  say('poster-message', message);
}

function refreshPoster() {
  showMovieSuggestion(state?.items.find(item => item.id === editing));
}

function queueMovieSearch() {
  clearTimeout(movieSearchTimer);
  const title = fields.title.value.trim();
  const item = state?.items.find(item => item.id === editing);
  const autoPoster = item && movieKey(item.title) === movieKey(title) ? item.autoPoster : '';
  refreshPoster();
  if (githubToken && movieKey(title)) movieSearchTimer = setTimeout(() => {
    void previewMovieInfo({ title, autoPoster, poster: posterUrl(fields.poster.value.trim()) });
  }, 450);
}

posterPreview.addEventListener('load', () => {
  if (!posterPreview.getAttribute('src')) return;
  posterPreview.hidden = false;
  say('poster-message', 'Постер готов.');
});
posterPreview.addEventListener('error', () => {
  if (!posterPreview.getAttribute('src')) return;
  posterPreview.hidden = true;
  say('poster-message', 'Источник не отдал изображение. Можно уточнить название и год или указать ссылку.');
});
fields.poster.addEventListener('input', () => {
  if (fields.poster.value) clearPoster = true;
  refreshPoster();
});
fields.title.addEventListener('input', queueMovieSearch);
fields.watchedOn.addEventListener('change', () => {
  if (fields.watchedOn.value) fields.status.value = 'watched';
  updateScheduleForm();
});
fields.status.addEventListener('change', updateScheduleForm);
byId('remove-poster').addEventListener('click', () => {
  fields.poster.value = '';
  clearPoster = true;
  queueMovieSearch();
});

function recordDate(item) {
  const day = (item.status === 'watched' && item.watchedOn) || item.orderedOn;
  const timestamp = Date.parse(day ? `${day}T00:00:00+03:00` : item.created);
  return Number.isFinite(timestamp) ? timestamp : Number.MIN_SAFE_INTEGER;
}

function render() {
  renderPublish();
  if (!state) return;
  say('admin-count', `Всего: ${state.items.length}`);
  refreshPoster();
  byId('categories').replaceChildren(...categories(state.items).map(value => new Option(value, value)));
  const newestFirst = [...state.items].reverse().sort((a, b) => recordDate(b) - recordDate(a));
  const rows = newestFirst.map(item => {
    const row = element('li');
    const name = element('div');
    const details = movieDetails(item, movieRecords);
    const key = movieKey(item.title);
    const info = pendingMovieInfo.has(key) ? 'Ищем сведения…' : details.poster ? 'Есть постер' :
      movieRecords[key] ? 'Постер не найден' : '';
    name.append(element('strong', item.title), element('div',
      [statuses[item.status], item.category, item.viewer, item.source, item.rewardTitle,
        item.watchedOn ? `Просмотр: ${viewingDateLabel(item.watchedOn)}` : '',
        item.plannedOn ? `Показ: ${viewingDateLabel(item.plannedOn)}${item.plannedTime ? ` в ${item.plannedTime} МСК` : ''}` : '',
        item.orderedOn ? `Заказ: ${viewingDateLabel(item.orderedOn)}` : orderDateLabel(item.created),
        runtimeLabel(details.runtime), info, item.rating == null ? '' : item.rating + '/10']
        .filter(Boolean).join(' · '), 'hint'));
    const actions = element('div', null, 'film-meta');
    const change = element('button', 'Изменить');
    change.addEventListener('click', () => { if (!savingEditor) edit(item); });
    actions.append(change);
    if (item.status === 'queued') {
      const plan = element('button', 'Запланировать');
      plan.addEventListener('click', () => { if (!savingEditor) edit(item, true); });
      actions.append(plan);
    }
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
    actions.append(remove);
    row.append(name, actions);
    return row;
  });
  byId('queue').replaceChildren(...(rows.length ? rows : [element('li', 'Очередь пока пуста.', 'muted')]));
}

async function previewMovieInfo(item) {
  const key = movieKey(item.title);
  if (!key) return null;
  if (pendingMovieInfo.has(key)) return pendingMovieInfo.get(key);
  const record = movieRecords[key];
  const details = movieDetails(item, movieRecords);
  const fresh = record && Date.now() - record.checkedAt < (record.error ? 15_000 : 600_000);
  if (fresh || (details.poster && details.runtime)) return record?.info;
  const request = findMovieInfo(item.title).then(info => {
    movieRecords[key] = { info, checkedAt: Date.now() };
    return info;
  }, () => {
    movieRecords[key] = { info: record?.info, checkedAt: Date.now(), error: true };
    return record?.info;
  }).finally(() => {
    pendingMovieInfo.delete(key);
    if (githubToken) render();
  });
  pendingMovieInfo.set(key, request);
  render();
  return request;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!githubToken || busy || savingEditor) return;
  const publishNow = event.submitter?.id !== 'save-draft';
  const values = Object.fromEntries(new FormData(form));
  const id = editing;
  const keepPoster = !clearPoster;
  const link = values.poster.trim();
  const title = values.title.trim();
  const before = state.items.find(item => item.id === id);
  if (!title) return say('edit-message', 'Введи название фильма.');
  if (values.status === 'planned' && !viewingDate(values.plannedOn)) return say('edit-message', 'Укажи дату показа.');
  if (link && (!posterUrl(link) || uploadedPoster(link))) {
    return say('edit-message', 'Нужна прямая ссылка на изображение с https://.');
  }
  savingEditor = true;
  form.inert = true;
  clearTimeout(movieSearchTimer);
  renderPublish();
  try {
    const ownPoster = link || (keepPoster && uploadedPoster(before?.poster));
    const remembered = before && movieKey(before.title) === movieKey(title) ? before.autoPoster : '';
    if (!ownPoster && !remembered) say('edit-message', 'Ищем постер перед сохранением…');
    const match = ownPoster || remembered ? null : await previewMovieInfo({ title });
    const saved = await lock('draft', () => {
      if (!githubToken) throw new Error('Войди в панель, чтобы сохранить фильм.');
      readLocal();
      const previous = state.items.find(item => item.id === id);
      if (id && !previous) throw new Error('Фильм уже удалён. Открой другой заказ.');
      values.poster = link || (keepPoster && uploadedPoster(previous?.poster) ? previous.poster : '');
      values.autoPoster = match?.poster || (previous && movieKey(previous.title) === movieKey(title) ? previous.autoPoster : '');
      const item = film(values, previous);
      const items = previous ? state.items.map(row => row.id === id ? item : row) : [...state.items, item];
      saveLocal({ ...state, items }, true);
      return item;
    });
    edit();
    say('edit-message', 'Фильм сохранён в черновике.');
    void previewMovieInfo(saved);
    if (publishNow) await publish('edit-message');
  } catch (error) { say('edit-message', errorText(error)); }
  finally {
    form.inert = false;
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
    say(target, 'Черновик сохранён. Отправляем изменения на GitHub…');
    for (let attempt = 0; ; attempt++) {
      try {
        const snapshot = await draftForPublishing(credential);
        if (!snapshot) {
          say(target, 'Список уже сохранён на GitHub.');
          return;
        }
        const revision = await writeGithub(repo, credential, snapshot.data, snapshot.posters);
        const published = { ...snapshot.data, revision };
        await lock('draft', () => {
          readLocal();
          const remaining = Object.fromEntries(Object.entries(uploads).filter(([path]) => !Object.hasOwn(snapshot.posters, path)));
          saveLocal({ ...state, revision }, JSON.stringify(state) !== JSON.stringify(snapshot.data), remaining, published);
          knownPublished = published;
        });
        say(target, 'Сохранено на GitHub. Ждём обновления витрины…');
        void waitForCatalog(revision, target, ++visibilityCheck);
        return;
      } catch (error) {
        if (attempt >= 2 || !(error instanceof CatalogChanged || error instanceof TypeError || error.status >= 500)) throw error;
        say(target, 'Повторяем синхронизацию с GitHub…');
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }, target);
}

async function draftForPublishing(credential) {
  const local = await lock('draft', () => {
    readLocal();
    return dirty ? { revision: state.revision, base: baseData } : null;
  });
  if (!local) return null;
  const { data: latest } = await readGithub(repo, credential);
  const base = latest.revision === local.revision ? latest :
    local.base ?? await findCatalogRevision(repo, credential, local.revision);
  return lock('draft', () => {
    readLocal();
    if (!dirty) return null;
    if (state.revision !== local.revision) throw new CatalogChanged('Черновик обновился. Повтори синхронизацию.');
    const merged = mergeCatalog(base, state, latest);
    const changed = JSON.stringify(merged) !== JSON.stringify(latest);
    saveLocal(merged, changed, uploads, latest);
    knownPublished = latest;
    return changed ? { data: state, posters: uploads } : null;
  });
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
function hasPendingOrders() {
  const base = baseData ?? knownPublished;
  return dirty && base && state.seen.some(id => !base.seen.includes(id));
}

auto.addEventListener('change', () => {
  localStorage.setItem(autoKey, String(auto.checked));
  if (auto.checked && hasPendingOrders()) schedulePublish();
});
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
    knownPublished = data;
    auto.checked = localStorage.getItem(autoKey) !== 'false';
    byId('login').hidden = true;
    byId('workspace').hidden = false;
    byId('workspace').inert = false;
    byId('logout').focus();
    render();
    if (auto.checked && hasPendingOrders()) schedulePublish();
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
  streams.reset();
  games.reset();
  openSection('films');
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
