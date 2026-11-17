export const statuses = {
  queued: 'В очереди', planned: 'Запланирован', watched: 'Посмотрели', skipped: 'Отклонён'
};

const text = (value, length) => String(value ?? '').trim().slice(0, length);
const orderDate = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow'
});

export function orderDateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${orderDate.format(date)} МСК`;
}

export function minutes(value) {
  const amount = Number(value);
  return Number.isInteger(amount) && amount > 0 && amount <= 1440 ? amount : null;
}

export function posterUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function film(fields, previous = {}) {
  const rating = fields.rating === '' || fields.rating == null ? NaN : Number(fields.rating);
  return {
    id: previous.id ?? crypto.randomUUID(),
    title: text(fields.title, 140),
    viewer: text(fields.viewer, 60),
    category: text(fields.category, 40),
    status: Object.hasOwn(statuses, fields.status) ? fields.status : 'queued',
    rating: Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : null,
    poster: posterUrl(text(fields.poster, 1000)),
    runtime: minutes(fields.runtime),
    note: text(fields.note, 240),
    created: previous.created ?? new Date().toISOString()
  };
}

export function addRedemption(state, event) {
  if (typeof event.id !== 'string' || !event.id || state.seen.includes(event.id)) return null;
  const item = film({
    title: event.user_input,
    viewer: event.user_login || event.user_name
  }, { id: 'twitch-' + event.id, created: event.redeemed_at || new Date().toISOString() });
  if (!item.title) return null;
  return { ...state, items: [...state.items, item], seen: [...state.seen, event.id] };
}

export function checkData(value) {
  if (!value || typeof value.revision !== 'string' || !Array.isArray(value.items) ||
      !Array.isArray(value.seen) || value.seen.some(id => typeof id !== 'string') ||
      value.items.some(item => !item || typeof item.id !== 'string' || !item.id ||
        typeof item.created !== 'string' || !item.title || typeof item.title !== 'string')) {
    throw new Error('Файл фильмов имеет неверный формат.');
  }
  return { revision: value.revision, items: value.items.map(item => film(item, item)), seen: value.seen };
}

export async function loadCatalog() {
  const response = await fetch(new URL('data/movies.json', import.meta.url), { cache: 'no-store' });
  if (!response.ok) throw new Error('Список фильмов недоступен.');
  return checkData(await response.json());
}

export function element(tag, content, className = '') {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

export const categories = items => [...new Set(items.map(item => item.category).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'ru'));
