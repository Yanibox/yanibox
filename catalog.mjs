import { categories, element, loadCatalog, orderDateLabel, statuses, viewingDateLabel } from './core.mjs';
import { loadMovieInfo, movieDetails, runtimeLabel } from './movie-info.mjs';

const byId = id => document.getElementById(id);
const [search, category, status, sort, summary, message, cards] =
  ['search', 'category', 'status', 'sort', 'summary', 'catalog-message', 'cards'].map(byId);
let items = [];
let records = {};
let revision;
let refreshing = false;

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
    image.addEventListener('error', () => art.replaceChildren(placeholder), { once: true });
    image.src = poster;
    art.replaceChildren(image);
  }

  const body = element('div', null, 'card-body');
  const meta = element('div', null, 'film-meta');
  meta.append(element('span', statuses[item.status], 'pill'));
  if (item.category) meta.append(element('span', item.category));
  if (year) meta.append(element('span', year));
  if (runtime) meta.append(element('span', runtimeLabel(runtime)));
  if (item.rating != null) meta.append(element('span', '★ ' + item.rating.toLocaleString('ru') + ' / 10', 'rating'));
  body.append(meta, element('h3', item.title));
  if (item.viewer) body.append(element('p', 'Заказал: ' + item.viewer, 'hint'));
  if (item.source && item.source.toLocaleLowerCase('ru') !== item.viewer.toLocaleLowerCase('ru')) {
    body.append(element('p', 'Источник: ' + item.source, 'hint'));
  }
  if (item.rewardTitle) body.append(element('p', item.rewardTitle, 'hint'));
  const date = item.watchedOn ? `Посмотрели ${viewingDateLabel(item.watchedOn)}` : '';
  if (date) {
    const time = element('time', date, 'hint');
    time.dateTime = item.watchedOn;
    body.append(time);
  }
  const ordered = item.orderedOn ? `Заказ от ${viewingDateLabel(item.orderedOn)}` : !date && orderDateLabel(item.created);
  if (ordered) {
    const time = element('time', ordered, 'hint');
    time.dateTime = item.orderedOn || item.created;
    body.append(time);
  }
  if (item.note) body.append(element('p', item.note, 'hint'));
  node.append(art, body);
  return node;
}

function render() {
  const term = search.value.trim().toLocaleLowerCase('ru');
  const list = items.filter(item =>
    (!term || [item.title, item.viewer, item.source].some(value => value.toLocaleLowerCase('ru').includes(term))) &&
    (!category.value || item.category === category.value) &&
    (!status.value || item.status === status.value));

  if (sort.value === 'rating') list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  if (sort.value === 'new') list.sort((a, b) => (b.orderedOn || b.created).localeCompare(a.orderedOn || a.created));
  if (sort.value === 'watched') list.sort((a, b) => b.watchedOn.localeCompare(a.watchedOn));
  summary.textContent = list.length ? `Показано ${list.length} из ${items.length}` : '';
  message.textContent = list.length ? '' : items.length ? 'По этим фильтрам ничего не нашлось.' : 'В каталоге пока нет фильмов.';
  cards.replaceChildren(...list.map(card));
}

for (const [value, label] of Object.entries(statuses)) status.add(new Option(label, value));
search.addEventListener('input', render);
for (const control of [category, status, sort]) control.addEventListener('change', render);

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
        const selected = category.value;
        category.replaceChildren(new Option('Все категории', ''),
          ...categories(items).map(value => new Option(value, value)));
        if ([...category.options].some(option => option.value === selected)) category.value = selected;
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
