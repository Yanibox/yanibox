import { categories, element, loadCatalog, orderDateLabel, statuses, viewingDateLabel } from './core.mjs';
import { filmRatings } from './film-ratings.mjs?v=compact';
import { loadMovieInfo, movieDetails, runtimeLabel } from './movie-info.mjs?v=hours';
import { ownerTools } from './showcase-owner.mjs';

const byId = id => document.getElementById(id);
const [search, category, status, viewer, sort, summary, message, cards] =
  ['search', 'category', 'status', 'viewer', 'sort', 'summary', 'catalog-message', 'cards'].map(byId);
const lower = value => value.toLocaleLowerCase('ru');
const viewerName = item => item.viewer || (item.source === 'Стример' ? '' : item.source);
function orderDate(item) {
  const timestamp = new Date(item.orderedOn ? `${item.orderedOn}T00:00:00+03:00` : item.created);
  return Number.isNaN(timestamp.getTime()) ? '' : timestamp.toISOString();
}
const planDate = item => item.status === 'planned' && item.plannedOn ? item.plannedOn + item.plannedTime : '';
const queuePriority = { queued: 0, planned: 1, watched: 2, skipped: 2 };
let items = [];
let records = {};
let revision;
let refreshing = false;
const ratings = filmRatings(render);
const owner = ownerTools(render, updated => {
  items = items.map(item => item.id === updated.id ? updated : item);
  render();
});
const cardSize = byId('card-size');
const cardSizeKey = 'yanibox-card-size';

try {
  const saved = localStorage.getItem(cardSizeKey);
  if ([...cardSize.options].some(option => option.value === saved)) cardSize.value = saved;
} catch { /* The size can still be changed for this visit. */ }
cards.dataset.size = cardSize.value;
cardSize.addEventListener('change', () => {
  cards.dataset.size = cardSize.value;
  try { localStorage.setItem(cardSizeKey, cardSize.value); } catch {}
});

function compareDates(left, right, direction = 1) {
  if (!left || !right) return Number(!left) - Number(!right);
  return direction * left.localeCompare(right);
}

function compareQueue(a, b) {
  const priority = queuePriority[a.status] - queuePriority[b.status];
  if (priority) return priority;
  if (a.status === 'queued') return compareDates(orderDate(a), orderDate(b));
  if (a.status === 'planned') return compareDates(planDate(a), planDate(b));
  return 0;
}

const comparators = {
  queue: compareQueue,
  old: (a, b) => compareDates(orderDate(a), orderDate(b)),
  new: (a, b) => compareDates(orderDate(a), orderDate(b), -1),
  planned: (a, b) => compareDates(planDate(a), planDate(b)),
  watched: (a, b) => compareDates(a.watchedOn, b.watchedOn, -1),
  rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1)
};

function card(item) {
  const { poster, runtime, year } = movieDetails(item, records);
  const node = element('article', null, 'card');
  const art = element('div', null, 'card-art');
  const placeholder = element('span', '▶');
  placeholder.setAttribute('aria-hidden', 'true');
  art.append(placeholder);
  if (poster) {
    const image = element('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => { placeholder.hidden = true; }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = poster;
    art.append(image);
  }

  const body = element('div', null, 'card-body');
  const badges = element('div', null, 'film-meta card-badges');
  const badge = element('span', statuses[item.status], 'pill');
  badge.dataset.status = item.status;
  badges.append(badge);
  const redeemed = item.id.startsWith('twitch-');
  const pointsLabel = /^баллы(?: канала| twitch)?$/i;
  const channelPoints = redeemed || [item.source, item.rewardTitle].some(value => pointsLabel.test(value));
  if (channelPoints || (item.source && lower(item.source) !== lower(item.viewer))) {
    const source = element('span', channelPoints ? 'Баллы канала' : item.source, 'pill');
    if (channelPoints || /\btwitch\b/i.test(item.source)) source.dataset.source = 'twitch';
    badges.append(source);
  }
  body.append(badges, element('h3', item.title));
  const meta = element('div', null, 'film-meta card-facts');
  if (year) meta.append(element('span', `${year} год`));
  if (runtime) meta.append(element('span', runtimeLabel(runtime)));
  if (item.category) meta.append(element('span', item.category));
  if (meta.childElementCount) body.append(meta);
  const order = element('div', null, 'card-order');
  if (item.viewer) {
    const customer = element('p', 'Заказ · ');
    customer.append(element('strong', item.viewer));
    order.append(customer);
  }
  const preciseOrder = redeemed && orderDateLabel(item.created);
  const ordered = preciseOrder || (item.orderedOn ? viewingDateLabel(item.orderedOn) :
    item.viewer ? orderDateLabel(item.created) : '');
  if (ordered) {
    const time = element('time', ordered);
    time.dateTime = preciseOrder ? item.created : item.orderedOn || item.created;
    order.append(time);
  }
  if (order.childElementCount) body.append(order);
  if (item.status === 'planned' && item.plannedOn) {
    const clock = item.plannedTime ? ` в ${item.plannedTime} МСК` : '';
    const time = element('time', `Показ ${viewingDateLabel(item.plannedOn)}${clock}`, 'planned-date');
    time.dateTime = item.plannedTime ? `${item.plannedOn}T${item.plannedTime}+03:00` : item.plannedOn;
    body.append(time);
  }
  const date = item.watchedOn ? `Посмотрели ${viewingDateLabel(item.watchedOn)}` : '';
  if (date) {
    const time = element('time', date, 'hint');
    time.dateTime = item.watchedOn;
    body.append(time);
  }
  if (item.note) body.append(element('p', item.note, 'hint'));
  const scores = element('div', null, 'card-scores');
  if (item.rating != null) scores.append(element('p', 'Стример · ' + item.rating.toLocaleString('ru') + '/10', 'rating'));
  const viewerRating = ratings.forMovie(item);
  if (viewerRating) scores.append(viewerRating);
  if (scores.childElementCount) body.append(scores);
  const edit = owner.forMovie(item);
  if (edit) body.append(edit);
  node.append(art, body);
  return node;
}

function render() {
  const term = lower(search.value.trim());
  const list = items.filter(item =>
    (!term || [item.title, item.viewer, item.source].some(value => lower(value).includes(term))) &&
    (!category.value || item.category === category.value) &&
    (!viewer.value || lower(viewerName(item)) === viewer.value) &&
    (!status.value || item.status === status.value));

  list.sort(comparators[sort.value] || compareQueue);
  summary.textContent = list.length ? `Показано ${list.length} из ${items.length}` : '';
  message.textContent = list.length ? '' : items.length ? 'По этим фильтрам ничего не нашлось.' : 'В каталоге пока нет фильмов.';
  cards.replaceChildren(...list.map(card));
}

for (const [value, label] of Object.entries(statuses)) status.add(new Option(label, value));
search.addEventListener('input', render);
for (const control of [category, status, viewer, sort]) control.addEventListener('change', render);

function updateOptions(select, placeholder, options) {
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...options);
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const info = loadMovieInfo().catch(() => null);
    try {
      const catalog = await loadCatalog();
      if (revision !== catalog.revision) {
        items = catalog.items;
        revision = catalog.revision;
        updateOptions(category, 'Все категории', categories(items).map(value => new Option(value, value)));
        const viewers = new Map(items.map(viewerName).filter(Boolean).map(name => [lower(name), name]));
        const names = [...viewers.values()].sort((a, b) => a.localeCompare(b, 'ru'));
        updateOptions(viewer, 'Все зрители', names.map(name => new Option(name, lower(name))));
        render();
      }
    } catch (error) {
      if (revision === undefined) message.textContent = error.message;
    }
    const nextRecords = await info;
    if (nextRecords && JSON.stringify(records) !== JSON.stringify(nextRecords)) {
      records = nextRecords;
      if (revision !== undefined) render();
    }
  } finally { refreshing = false; }
}

await refresh();
window.setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
