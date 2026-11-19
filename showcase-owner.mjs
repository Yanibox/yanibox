import { element, film, statuses } from './core.mjs';
import { checkOwner, readGithub, writeGithub } from './github.mjs';

const repo = 'Yanibox/yanibox';
const editable = ['status', 'plannedOn', 'plannedTime', 'rating'];

export function ownerTools(onChange, onSave) {
  const toggle = document.getElementById('owner-toggle');
  const dialog = document.getElementById('owner-dialog');
  const title = document.getElementById('owner-title');
  const message = document.getElementById('owner-message');
  const login = document.getElementById('owner-login');
  const editor = document.getElementById('owner-editor');
  const plan = document.getElementById('owner-plan');
  const fields = editor.elements;
  let token = '';
  let active;
  let busy = false;

  for (const [value, label] of Object.entries(statuses)) fields.status.add(new Option(label, value));
  function updatePlan() {
    plan.hidden = fields.status.value !== 'planned';
    fields.plannedOn.required = !plan.hidden;
    fields.plannedOn.disabled = fields.plannedTime.disabled = plan.hidden;
  }
  fields.status.addEventListener('change', updatePlan);

  function open(item) {
    active = item;
    title.textContent = item?.title || 'Режим владельца';
    message.textContent = '';
    login.hidden = Boolean(item);
    editor.hidden = !item;
    if (item) {
      for (const field of editable) fields[field].value = item[field] ?? '';
      updatePlan();
    }
    dialog.showModal();
  }

  toggle.addEventListener('click', () => {
    if (busy) return;
    if (!token) return open();
    token = '';
    active = undefined;
    toggle.textContent = 'Режим владельца';
    onChange();
  });

  async function run(event, action) {
    if (event.submitter?.formMethod === 'dialog') return;
    event.preventDefault();
    if (busy) return;
    const submit = event.currentTarget.querySelector('[type="submit"]');
    busy = submit.disabled = true;
    message.textContent = 'Подождите…';
    try { await action(); }
    catch (error) { message.textContent = error.message; }
    finally { busy = submit.disabled = false; }
  }

  login.addEventListener('submit', event => void run(event, async () => {
    const credential = login.elements.credential;
    const candidate = credential.value.trim();
    credential.value = '';
    await checkOwner(repo, candidate);
    if (!dialog.open) return;
    token = candidate;
    toggle.textContent = 'Выйти из режима владельца';
    dialog.close();
    onChange();
  }));

  editor.addEventListener('submit', event => void run(event, async () => {
    if (!token || !active) return;
    const values = Object.fromEntries(new FormData(editor));
    const { data } = await readGithub(repo, token, 'main');
    const latest = data.items.find(item => item.id === active.id);
    if (!latest) throw new Error('Фильм удалён. Обнови витрину.');
    if (editable.some(field => active[field] !== latest[field])) {
      onSave(latest);
      active = latest;
      for (const field of editable) fields[field].value = latest[field] ?? '';
      updatePlan();
      throw new Error('Данные уже изменились. Проверь свежие значения и повтори сохранение.');
    }
    const updated = film({ ...latest, ...values }, latest);
    if (editable.some(field => latest[field] !== updated[field])) {
      await writeGithub(repo, token, { ...data, items: data.items.map(item => item.id === updated.id ? updated : item) });
    }
    active = updated;
    onSave(updated);
    message.textContent = 'Сохранено. Изменения появятся у зрителей после публикации сайта.';
  }));

  return {
    forMovie(item) {
      if (!token) return null;
      const button = element('button', 'Править карточку', 'quiet-button');
      button.type = 'button';
      button.addEventListener('click', () => { if (!busy) open(item); });
      return button;
    }
  };
}
