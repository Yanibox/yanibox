const search = document.getElementById('viewer-search');
const period = document.getElementById('period');
const status = document.getElementById('watchtime-status');
const table = document.getElementById('watchtime-table');
const rows = document.getElementById('watchtime-rows');
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow'
});
let snapshot;
let failed = false;
let refreshing = false;

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600).toLocaleString('ru-RU');
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours} ч ${minutes} мин ${seconds % 60} с`;
}

function render() {
  const entry = snapshot?.periods[period.value];
  const query = search.value.trim().replace(/^@/, '').toLowerCase();
  const fragment = document.createDocumentFragment();
  let count = 0;
  for (const [index, viewer] of (entry?.viewers ?? []).entries()) {
    if (!viewer.name.toLowerCase().includes(query)) continue;
    const row = document.createElement('tr');
    for (const value of [index + 1, viewer.name, formatDuration(viewer.seconds)]) {
      row.insertCell().textContent = value;
    }
    fragment.append(row);
    count++;
  }
  rows.replaceChildren(fragment);
  table.hidden = count === 0;

  if (!entry) {
    status.textContent = snapshot || failed
      ? 'Статистика WizeBot за этот период пока недоступна.'
      : 'Загружаем статистику…';
    return;
  }
  const date = new Date(entry.updatedAt);
  const outdated = failed || entry.stale || Date.now() - date.getTime() > 90 * 60 * 1000;
  const timestamp = dateFormat.format(date) + ' МСК';
  const result = count ? `Зрителей ${count} из ${entry.viewers.length}`
    : query && entry.viewers.length ? 'Зритель не найден' : 'За этот период пока нет зрителей в рейтинге';
  status.textContent = `${result} · ${outdated ? 'Последние доступные данные' : 'Обновлено'} ${timestamp}`;
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
  render();
}

search.addEventListener('input', render);
period.addEventListener('change', render);
void refresh();
window.setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
