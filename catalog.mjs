import { categories, element, loadCatalog, statuses } from './core.mjs';

const byId = id => document.getElementById(id);
const [search, category, status, sort, summary, message, cards] =
  ['search', 'category', 'status', 'sort', 'summary', 'catalog-message', 'cards'].map(byId);
let items = [];

function card(item) {
  const node = element('article', null, 'card');
  const art = element('div', null, 'card-art');
  const placeholder = element('span', '▶');
  placeholder.setAttribute('aria-hidden', 'true');
  art.append(placeholder);
  if (item.poster) {
    const image = element('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => art.replaceChildren(placeholder), { once: true });
    image.src = item.poster;
    art.replaceChildren(image);
  }

  const body = element('div', null, 'card-body');
  const meta = element('div', null, 'film-meta');
  meta.append(element('span', statuses[item.status], 'pill'));
  if (item.category) meta.append(element('span', item.category));
  if (item.rating != null) meta.append(element('span', '★ ' + item.rating.toLocaleString('ru') + ' / 10', 'rating'));
  body.append(meta, element('h3', item.title));
  if (item.viewer) body.append(element('p', 'Заказал: ' + item.viewer, 'hint'));
  if (item.note) body.append(element('p', item.note, 'hint'));
  node.append(art, body);
  return node;
}

function render() {
  const term = search.value.trim().toLocaleLowerCase('ru');
  const list = items.filter(item =>
    (!term || [item.title, item.viewer].some(value => value.toLocaleLowerCase('ru').includes(term))) &&
    (!category.value || item.category === category.value) &&
    (!status.value || item.status === status.value));

  if (sort.value === 'rating') list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  if (sort.value === 'new') list.sort((a, b) => b.created.localeCompare(a.created));
  summary.textContent = list.length ? `Показано ${list.length} из ${items.length}` : '';
  message.textContent = list.length ? '' : items.length ? 'По этим фильтрам ничего не нашлось.' : 'В каталоге пока нет фильмов.';
  cards.replaceChildren(...list.map(card));
}

for (const [value, label] of Object.entries(statuses)) status.add(new Option(label, value));
search.addEventListener('input', render);
for (const control of [category, status, sort]) control.addEventListener('change', render);

try {
  ({ items } = await loadCatalog());
  for (const value of categories(items)) category.add(new Option(value, value));
  render();
} catch (error) {
  message.textContent = error.message;
}
