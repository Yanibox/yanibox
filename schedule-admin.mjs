import { element } from './core.mjs';
import { readSchedule, writeSchedule } from './github.mjs';
import { checkSchedule, googleCalendarId, scheduleEvent, scheduleLabel } from './schedule-data.mjs';

export function scheduleAdmin(repo, credential) {
  const byId = id => document.getElementById(id);
  const form = byId('stream-editor');
  const fields = form.elements;
  const calendar = byId('calendar-settings');
  const list = byId('stream-list');
  const message = byId('stream-message');
  const reload = byId('stream-reload');
  let current;
  let editing;
  let original;
  let busy = false;

  function controls() {
    for (const control of [form, calendar]) control.inert = busy || !current;
    reload.disabled = busy;
  }

  function edit(item) {
    form.reset();
    editing = item?.id;
    original = item;
    for (const name of ['title', 'date', 'time', 'note']) fields[name].value = item?.[name] || '';
    byId('stream-edit-title').textContent = item ? 'Редактировать стрим' : 'Добавить стрим';
    byId('stream-cancel').hidden = !item;
    if (item) fields.title.focus();
  }

  function render() {
    const events = [...current.data.events].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    list.replaceChildren(...events.map(item => {
      const row = element('li');
      const info = element('div');
      info.append(element('strong', item.title), element('p', scheduleLabel(item.date, item.time), 'hint'));
      const actions = element('div', null, 'film-meta');
      const change = element('button', 'Изменить');
      const remove = element('button', 'Удалить');
      for (const button of [change, remove]) button.type = 'button';
      change.onclick = () => { if (!busy) edit(item); };
      remove.onclick = () => {
        if (!busy && confirm(`Удалить стрим «${item.title}» из расписания?`)) void update({
          ...current.data, events: current.data.events.filter(event => event.id !== item.id)
        }, () => { if (editing === item.id) edit(); });
      };
      actions.append(change, remove);
      row.append(info, actions);
      return row;
    }));
    if (!events.length) list.append(element('li', 'Стримы пока не добавлены.', 'muted'));
    controls();
  }

  async function run(action) {
    const token = credential();
    if (busy || !token) return;
    busy = true;
    controls();
    message.textContent = 'Связываемся с GitHub…';
    try { await action(token); }
    catch (error) { if (token === credential()) message.textContent = error.message; }
    finally { busy = false; controls(); }
  }

  function load() {
    return run(async token => {
      const snapshot = await readSchedule(repo, token);
      if (token !== credential()) return;
      current = { data: checkSchedule(snapshot.data), sha: snapshot.sha };
      calendar.elements.calendarId.value = current.data.googleCalendar;
      if (editing && !current.data.events.some(event => event.id === editing)) edit();
      render();
      message.textContent = 'Расписание загружено.';
    });
  }

  function update(data, afterSave) {
    return run(async token => {
      const sha = await writeSchedule(repo, token, data, current.sha);
      if (token !== credential()) return;
      current = { data, sha };
      afterSave?.();
      render();
      message.textContent = 'Сохранено. Витрина обновится после публикации сайта.';
    });
  }

  reload.onclick = () => void load();
  byId('stream-cancel').onclick = () => edit();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!current) return;
    const item = scheduleEvent({ ...Object.fromEntries(new FormData(form)), id: editing });
    if (!item.title || !item.date) return;
    if (editing) {
      const latest = current.data.events.find(row => row.id === editing);
      if (JSON.stringify(latest) !== JSON.stringify(original)) {
        message.textContent = 'Этот эфир уже изменился. Открой его заново из списка.';
        return;
      }
    }
    const events = editing ? current.data.events.map(row => row.id === editing ? item : row) : [...current.data.events, item];
    void update({ ...current.data, events }, () => edit());
  });
  calendar.addEventListener('submit', event => {
    event.preventDefault();
    if (!current) return;
    const value = calendar.elements.calendarId.value.trim();
    const id = googleCalendarId(value);
    if (value && !id) {
      message.textContent = 'Вставь идентификатор из раздела «Интеграция календаря».';
      return;
    }
    void update({ ...current.data, googleCalendar: id });
  });

  return {
    show() { if (!current) void load(); },
    reset() {
      current = undefined;
      edit();
      calendar.reset();
      list.replaceChildren();
      message.textContent = '';
      controls();
    }
  };
}
