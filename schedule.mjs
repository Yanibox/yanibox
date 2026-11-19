import { element, loadCatalog } from './core.mjs';
import { checkSchedule, scheduleLabel, upcomingStreams } from './schedule-data.mjs';

const list = document.getElementById('schedule-list');
const message = document.getElementById('schedule-message');

async function loadSchedule() {
  const response = await fetch('./data/schedule.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Расписание недоступно.');
  return checkSchedule(await response.json());
}

function eventRow(event, next) {
  const row = element('li', null, 'schedule-event');
  const time = element('time', scheduleLabel(event.date, event.time));
  time.dateTime = event.time ? `${event.date}T${event.time}+03:00` : event.date;
  const body = element('div', null, 'schedule-event-body');
  const kind = element('span', event.film ? 'Кинопоказ' : 'Стрим', 'pill');
  const title = element('h2', event.title);
  body.append(kind, title);
  if (event.note) body.append(element('p', event.note, 'muted'));
  if (next) row.classList.add('schedule-next');
  row.append(time, body);
  return row;
}

const [streams, films] = await Promise.allSettled([loadSchedule(), loadCatalog()]);
const data = streams.value;
const upcoming = upcomingStreams(data?.events || [], films.value?.items || []);
list.replaceChildren(...upcoming.map((event, index) => eventRow(event, index === 0)));
message.textContent = data && films.value ? (upcoming.length ? '' : 'Ближайшие эфиры пока не объявлены.') :
  upcoming.length ? 'Часть расписания временно недоступна.' : 'Не удалось загрузить полное расписание.';

if (data?.googleCalendar) {
  const params = new URLSearchParams({ src: data.googleCalendar, ctz: 'Europe/Moscow', mode: 'AGENDA', hl: 'ru', showPrint: '0' });
  document.getElementById('calendar-frame').src = 'https://calendar.google.com/calendar/embed?' + params;
  document.getElementById('google-schedule').hidden = false;
}
