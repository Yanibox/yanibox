import { compareSnapshots, dateInMoscow, formatDuration, periodDates, shiftDays } from './watchtime-period.mjs';

const search = document.getElementById('viewer-search');
const period = document.getElementById('period');
const ranks = document.getElementById('rank-filter');
const dates = document.getElementById('watchtime-dates');
const from = document.getElementById('range-from');
const to = document.getElementById('range-to');
const status = document.getElementById('watchtime-status');
const details = document.getElementById('watchtime-details');
const table = document.getElementById('watchtime-table');
const rows = document.getElementById('watchtime-rows');
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow'
});
const shortDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeZone: 'UTC' });
const savedDays = new Map();
let snapshot;
let failed = false;
let refreshing = false;
let selection = 0;
let entry;
let message = 'Загружаем статистику…';

function showDay(day) {
  return shortDate.format(new Date(day + 'T00:00:00Z'));
}

function render() {
  const query = search.value.trim().replace(/^@/, '').toLowerCase();
  const fragment = document.createDocumentFragment();
  const ranked = entry?.viewers ?? [];
  const limit = ranks.value ? Number(ranks.value) : ranked.length;
  let count = 0;
  for (const [index, viewer] of ranked.slice(0, limit).entries()) {
    if (!viewer.name.toLowerCase().includes(query)) continue;
    const row = document.createElement('tr');
    const badge = document.createElement('span');
    badge.className = index < 3 ? `rank rank-${index + 1}` : 'rank';
    badge.textContent = index + 1;
    row.insertCell().append(badge);
    row.insertCell().textContent = viewer.name;
    row.insertCell().textContent = formatDuration(viewer.seconds);
    fragment.append(row);
    count++;
  }
  rows.replaceChildren(fragment);
  table.hidden = count === 0;
  details.hidden = !entry?.description;
  details.textContent = entry?.description ?? '';

  if (!entry) {
    status.textContent = message;
    return;
  }
  const date = new Date(entry.updatedAt);
  const outdated = failed || entry.stale || Date.now() - date.getTime() > 90 * 60 * 1000;
  const timestamp = dateFormat.format(date) + ' МСК';
  const result = count ? `Зрителей ${count} из ${ranked.length}`
    : query && ranked.length ? 'Зритель не найден в выбранных местах' : 'За этот период пока нет зрителей в рейтинге';
  status.textContent = entry.description ? result
    : `${result} · ${outdated ? 'Последние доступные данные' : 'Обновлено'} ${timestamp}`;
}

async function loadDay(day) {
  if (!savedDays.has(day)) {
    const response = await fetch(`data/watchtime-history/${day}.json`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('History unavailable');
    const reading = await response.json();
    if (!Array.isArray(reading.viewers) || dateInMoscow(new Date(reading.updatedAt)) !== day) {
      throw new Error('Invalid watchtime history');
    }
    savedDays.set(day, reading);
  }
  return savedDays.get(day);
}

async function updatePeriod() {
  const request = ++selection;
  const value = period.value;
  dates.hidden = value !== 'custom';
  const today = dateInMoscow(new Date());
  from.max = to.max = today;
  const days = snapshot?.days ?? [];
  if (value === 'custom' && !from.value) from.value = days[0] ?? today;
  if (value === 'custom' && !to.value) to.value = today;

  if (!snapshot || ['global', 'month', 'week'].includes(value)) {
    entry = snapshot?.periods[value];
    message = snapshot || failed ? 'Статистика WizeBot за этот период пока недоступна.' : 'Загружаем статистику…';
    render();
    return;
  }

  const [start, end] = value === 'custom' ? [from.value, to.value] : periodDates(value, today);
  entry = undefined;
  if (!start || !end || start > end || end > today) {
    message = 'Выберите диапазон дат до сегодняшнего дня включительно.';
  } else {
    const endDay = end === today ? today : shiftDays(end, 1);
    const live = snapshot.periods.global;
    const hasEnd = end === today ? live && dateInMoscow(new Date(live.updatedAt)) === today : days.includes(endDay);
    if (!days.includes(start) || !hasEnd) {
      message = days.length
        ? `За выбранные даты нет полного архива. Снимки собираются с ${showDay(days[0])} (МСК).`
        : 'Архив WizeBot пока пуст.';
    } else {
      message = 'Сравниваем снимки WizeBot…';
      render();
      try {
        const [first, last] = await Promise.all([loadDay(start), end === today ? live : loadDay(endDay)]);
        if (request !== selection) return;
        const result = compareSnapshots(first, last);
        if (result) {
          const range = `${dateFormat.format(new Date(first.updatedAt))} — ${dateFormat.format(new Date(last.updatedAt))} МСК`;
          const exclusions = result.inconsistent ? ` Записей с несопоставимыми показаниями: ${result.inconsistent}.` : '';
          entry = {
            viewers: result.viewers, updatedAt: last.updatedAt,
            description: `Приблизительно по снимкам WizeBot · ${range}.${exclusions}`
          };
        } else {
          message = 'Дождитесь следующего снимка WizeBot, чтобы сравнить время просмотра.';
        }
      } catch {
        if (request !== selection) return;
        message = 'Не удалось загрузить архив за выбранные даты.';
      }
    }
  }
  render();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('data/watchtime.json', { cache: 'no-cache', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Watchtime unavailable');
    const next = await response.json();
    if (!next.periods || typeof next.periods !== 'object') throw new Error('Invalid watchtime snapshot');
    snapshot = next;
    failed = false;
  } catch {
    failed = true;
  } finally {
    refreshing = false;
  }
  void updatePeriod();
}

search.addEventListener('input', render);
ranks.addEventListener('change', render);
for (const control of [period, from, to]) control.addEventListener('change', updatePeriod);
void refresh();
window.setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
