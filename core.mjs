export const statuses = {
  queued: 'В очереди', planned: 'Запланирован', watched: 'Посмотрели', skipped: 'Отклонён'
};

const text = (value, length) => String(value ?? '').trim().slice(0, length);
const orderDate = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow'
});
const watchDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' });

export function orderDateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${orderDate.format(date)} МСК`;
}

export function minutes(value) {
  const amount = Number(value);
  return Number.isInteger(amount) && amount > 0 && amount <= 1440 ? amount : null;
}

export function viewingDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : '';
}

export function viewingDateLabel(value) {
  return viewingDate(value) ? watchDate.format(new Date(value)) : '';
}

export const uploadedPoster = value => /^data\/posters\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.webp$/.test(value);

export function posterUrl(value) {
  if (uploadedPoster(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function film(fields, previous = {}) {
  const rating = fields.rating === '' || fields.rating == null ? NaN : Number(fields.rating);
  const plannedOn = fields.status === 'planned' ? viewingDate(fields.plannedOn) : '';
  return {
    id: previous.id ?? crypto.randomUUID(),
    title: text(fields.title, 140),
    viewer: text(fields.viewer, 60),
    source: text(fields.source, 110),
    rewardTitle: text(previous.rewardTitle ?? fields.rewardTitle, 110),
    category: text(fields.category, 40),
    status: Object.hasOwn(statuses, fields.status) ? fields.status : 'queued',
    rating: Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : null,
    poster: posterUrl(text(fields.poster, 1000)),
    autoPoster: posterUrl(text(fields.autoPoster, 1000)),
    runtime: minutes(fields.runtime),
    note: text(fields.note, 240),
    watchedOn: viewingDate(fields.watchedOn),
    orderedOn: viewingDate(fields.orderedOn),
    plannedOn,
    plannedTime: plannedOn && typeof fields.plannedTime === 'string' &&
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields.plannedTime) ? fields.plannedTime : '',
    created: previous.created ?? new Date().toISOString()
  };
}

export function addRedemption(state, event) {
  if (typeof event.id !== 'string' || !event.id || state.seen.includes(event.id)) return null;
  const item = film({
    title: event.user_input,
    viewer: event.user_login || event.user_name,
    rewardTitle: event.reward?.title
  }, { id: 'twitch-' + event.id, created: event.redeemed_at || new Date().toISOString() });
  if (!item.title) return null;
  return { ...state, items: [...state.items, item], seen: [...state.seen, event.id] };
}

export function mergeCatalog(base, draft, latest) {
  const entries = data => new Map(data.items.map(item => [item.id, item]));
  const original = entries(base);
  const local = entries(draft);
  const remote = entries(latest);
  const publishedOrders = new Set(latest.seen);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const items = [];
  for (const id of new Set([...remote.keys(), ...local.keys()])) {
    const before = original.get(id);
    const ours = local.get(id);
    const theirs = remote.get(id);
    if (!before && !theirs && id.startsWith('twitch-') && publishedOrders.has(id.slice(7))) continue;
    let merged;
    if (same(ours, before)) merged = theirs;
    else if (same(theirs, before) || same(ours, theirs)) merged = ours;
    else {
      const conflict = () => new Error(`«${(ours || theirs).title}» изменён и в черновике, и на GitHub. Черновик сохранён.`);
      if (!before || !ours || !theirs) throw conflict();
      merged = { ...theirs };
      for (const key of Object.keys(ours)) {
        if (ours[key] === before[key]) continue;
        if (theirs[key] !== before[key] && theirs[key] !== ours[key]) throw conflict();
        merged[key] = ours[key];
      }
    }
    if (merged) items.push(merged);
  }
  return { revision: latest.revision, items, seen: [...new Set([...latest.seen, ...draft.seen])] };
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

export async function loadCatalog(signal) {
  const response = await fetch(new URL('data/movies.json', import.meta.url), { cache: 'no-store', signal });
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
