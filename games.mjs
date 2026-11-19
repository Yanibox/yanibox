import { element } from './core.mjs';
import { checkGames, gameDuration, gameKey, gameStatuses } from './games-data.mjs';

const byId = id => document.getElementById(id);
const grid = byId('games-cards');
const search = byId('games-search');
const status = byId('games-status');
const sort = byId('games-sort');
const message = byId('games-message');
const summary = byId('games-summary');
const states = { playing: 0, finished: 1, idea: 2 };
const dateFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'long', timeZone: 'Europe/Moscow' });
let games = [];
let stats;

for (const [id, label] of Object.entries(gameStatuses)) status.add(new Option(label, id));
search.addEventListener('input', render);
status.addEventListener('change', render);
sort.addEventListener('change', render);

async function load(path) {
  const response = await fetch(`data/${path}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Данные временно недоступны.');
  return response.json();
}

function twitchMinutes(game) {
  const key = gameKey(game.twitchCategory);
  const seconds = Object.hasOwn(stats?.seconds || {}, key) ? stats.seconds[key] : null;
  return Number.isFinite(seconds) ? seconds / 60 : null;
}

function metric(list, label, value) {
  const row = element('div', null, 'game-metric');
  const data = element('dd');
  if (typeof value === 'string') data.textContent = value;
  else data.append(value);
  row.append(element('dt', label), data);
  list.append(row);
}

function gameCard(game) {
  const card = element('li', null, 'game-card');
  const art = element('div', null, 'game-cover');
  const placeholder = element('span', game.title.slice(0, 1).toUpperCase());
  placeholder.setAttribute('aria-hidden', 'true');
  art.append(placeholder);
  if (game.poster) {
    const cover = element('img');
    cover.alt = '';
    cover.loading = 'lazy';
    cover.addEventListener('error', () => cover.remove(), { once: true });
    cover.src = game.poster;
    art.append(cover);
  }
  const state = element('span', gameStatuses[game.status], 'game-state');
  state.dataset.status = game.status;
  art.append(state);
  const details = element('div', null, 'game-details');
  const metrics = element('dl');
  let average = gameDuration(game.averageMinutes);
  if (game.hltbId) {
    const link = element('a', average === '—' ? 'HowLongToBeat ↗' : average + ' ↗');
    link.href = 'https://howlongtobeat.com/game/' + game.hltbId;
    link.title = 'HowLongToBeat';
    average = link;
  }
  metric(metrics, 'Сюжет', average);
  metric(metrics, 'Yanibox', gameDuration(game.ownMinutes));
  metric(metrics, 'Twitch', gameDuration(twitchMinutes(game)));
  details.append(element('h2', game.title), metrics);
  card.append(art, details);
  return card;
}

const sorters = {
  list: (a, b) => states[a.status] - states[b.status],
  stream: (a, b) => (twitchMinutes(b) ?? -1) - (twitchMinutes(a) ?? -1),
  average: (a, b) => (a.averageMinutes ?? Infinity) - (b.averageMinutes ?? Infinity),
  title: (a, b) => a.title.localeCompare(b.title, 'ru')
};

function render() {
  const term = gameKey(search.value.trim());
  const list = games.filter(game => (!status.value || status.value === game.status) &&
    [game.title, game.twitchCategory].some(value => gameKey(value).includes(term)));
  list.sort(sorters[sort.value]);
  summary.textContent = `${list.length} из ${games.length}`;
  message.textContent = list.length ? '' : 'Игры не найдены.';
  grid.replaceChildren(...list.map(gameCard));
}

const [catalog, history] = await Promise.allSettled([load('games.json'), load('twitch-games.json')]);
try {
  games = checkGames(catalog.value);
  stats = history.value;
  const time = byId('games-sources').querySelector('time');
  const start = Date.parse(stats?.startedAt);
  if (Number.isFinite(start)) {
    time.dateTime = stats.startedAt;
    time.textContent = dateFormat.format(start);
  } else {
    time.parentElement.textContent = '«Сюжет» — среднее время по HowLongToBeat. «Yanibox» — время прохождения, отмеченное стримером. Twitch появится после первых наблюдений.';
  }
  byId('games-sources').hidden = false;
  render();
} catch (error) { message.textContent = error.message; }
