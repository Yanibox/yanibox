const moscowDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', dateStyle: 'short' });
export const dateInMoscow = date => moscowDate.format(date);

function asDate(day) {
  return new Date(day + 'T00:00:00Z');
}

export function shiftDays(day, days) {
  const date = asDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shiftMonths(day, months) {
  const date = asDate(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

export function periodDates(period, today) {
  if (period === 'previous-week') {
    const monday = shiftDays(today, -((asDate(today).getUTCDay() + 6) % 7));
    return [shiftDays(monday, -7), shiftDays(monday, -1)];
  }
  return [shiftMonths(today, period === 'year' ? -12 : -3), today];
}

export function compareSnapshots(start, end) {
  const elapsed = Math.floor((Date.parse(end.updatedAt) - Date.parse(start.updatedAt)) / 1000);
  if (elapsed <= 0) return null;
  const baseline = new Map(start.viewers.map(viewer => [viewer.name.toLowerCase(), viewer.seconds]));
  const viewers = [];
  let inconsistent = 0;
  for (const viewer of end.viewers) {
    const key = viewer.name.toLowerCase();
    const seconds = viewer.seconds - (baseline.get(key) ?? 0);
    baseline.delete(key);
    if (seconds < 0 || seconds > elapsed + 3600) {
      inconsistent++;
    } else if (seconds > 0) {
      viewers.push({ name: viewer.name, seconds });
    }
  }
  inconsistent += baseline.size;
  viewers.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, 'en'));
  return { viewers, inconsistent };
}
