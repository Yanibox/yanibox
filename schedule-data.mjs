import { viewingDate, viewingDateLabel } from './core.mjs';

export const scheduleTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : '';
export const googleCalendarId = value => /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value || '') ? value : '';
export const scheduleLabel = (day, time) => `${viewingDateLabel(day)}${time ? ` · ${time} МСК` : ''}`;

export function scheduleEvent(value) {
  const { id, title, date, time, note } = value;
  return {
    id: String(id || crypto.randomUUID()),
    title: String(title || '').trim().slice(0, 120),
    date: viewingDate(date),
    time: scheduleTime(time),
    note: String(note || '').trim().slice(0, 240)
  };
}

export function checkSchedule(value) {
  if (!Array.isArray(value?.events)) throw new Error('Не удалось прочитать расписание.');
  return {
    googleCalendar: googleCalendarId(value.googleCalendar),
    events: value.events.map(scheduleEvent).filter(event => event.title && event.date)
  };
}

export function upcomingStreams(events, films, now = new Date()) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' }).format(now);
  return [...events, ...films.filter(item => item.status === 'planned' && item.plannedOn).map(item => ({
    id: item.id, title: item.title, date: item.plannedOn, time: item.plannedTime, film: true
  }))].filter(event => event.date >= today).sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time || '24:00').localeCompare(b.time || '24:00'));
}
