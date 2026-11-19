import { element } from './core.mjs';

const statuses = { idea: 'Идея', playing: 'В процессе', finished: 'Пройдена' };
const sheetPaths = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/;
const keyOf = title => title.trim().toLocaleLowerCase('ru');

function xml(files, name, optional = false) {
  if (!files[name] && optional) return null;
  if (!files[name]) throw new Error('Не удалось прочитать структуру Excel.');
  const document = new DOMParser().parseFromString(new TextDecoder().decode(files[name]), 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Файл Excel повреждён.');
  return document;
}

async function importGames(file) {
  if (file.size > 5_000_000) throw new Error('Выбери файл XLSX размером до 5 МБ.');
  const { unzipSync } = await import('./fflate.mjs');
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: entry => entry.originalSize <= 6_000_000 && sheetPaths.test(entry.name)
  });
  const workbook = xml(files, 'xl/workbook.xml');
  const sheet = [...workbook.querySelectorAll('sheet')].find(item => item.getAttribute('name').trim().toLowerCase() === 'игры');
  if (!sheet) throw new Error('В файле нет листа «Игры».');
  const relationId = [...sheet.attributes].find(attribute => attribute.localName === 'id')?.value;
  const relations = xml(files, 'xl/_rels/workbook.xml.rels');
  const path = [...relations.querySelectorAll('Relationship')]
    .find(item => item.getAttribute('Id') === relationId)?.getAttribute('Target');
  if (!path) throw new Error('Не удалось открыть лист «Игры».');
  const worksheet = xml(files, path.startsWith('/') ? path.slice(1) : 'xl/' + path);
  const others = xml(files, 'xl/sharedStrings.xml', true);
  const strings = [...(others?.querySelectorAll('si') || [])].map(readText);
  const rows = [...worksheet.querySelectorAll('sheetData > row')].map(row => Object.fromEntries(
    [...row.querySelectorAll('c')].map(cell => {
      const value = cell.querySelector('v')?.textContent;
      const type = cell.getAttribute('t');
      const text = type === 's' ? strings[Number(value)] : type === 'inlineStr' ? readText(cell) : value;
      return [cell.getAttribute('r').replace(/\d+$/, ''), (text || '').trim()];
    })
  ));
  const header = rows.findIndex(row => keyOf(row.A || '') === 'название игры');
  if (header < 0) throw new Error('Не найден столбец «Название игры».');
  return rows.slice(header + 1).filter(row => row.A).map(row => ({
    title: row.A.slice(0, 160),
    status: keyOf(row.G || '') === 'да' ? 'finished' : keyOf(row.F || '') === 'да' ? 'playing' : 'idea'
  }));
}

function readText(cell) {
  return [...cell.querySelectorAll('t')].map(node => node.textContent).join('');
}

export function gamesAdmin(namespace, isOwner) {
  const key = namespace + ':games';
  const byId = id => document.getElementById(id);
  const list = byId('game-list');
  const search = byId('game-search');
  const filter = byId('game-filter');
  const file = byId('games-file');
  const form = byId('game-editor');
  const message = byId('games-message');
  let games = [];
  let session = 0;

  for (const [value, label] of Object.entries(statuses)) filter.add(new Option(label, value));

  function render() {
    const term = keyOf(search.value);
    const visible = games.filter(item => keyOf(item.title).includes(term) && (!filter.value || item.status === filter.value));
    byId('games-count').textContent = `${visible.length} из ${games.length}`;
    list.replaceChildren(...visible.map(item => {
      const row = element('li');
      const select = element('select');
      select.setAttribute('aria-label', 'Статус игры «' + item.title + '»');
      for (const [value, label] of Object.entries(statuses)) select.add(new Option(label, value));
      select.value = item.status;
      select.addEventListener('change', () => {
        save(games.map(game => game === item ? { ...game, status: select.value } : game));
        select.value = item.status;
      });
      row.append(element('strong', item.title), select);
      return row;
    }));
    if (!visible.length) list.append(element('li', games.length ? 'Ничего не найдено.' : 'Импортируй Excel или добавь игру вручную.', 'muted'));
  }

  function save(next) {
    if (!isOwner()) return false;
    try {
      localStorage.setItem(key, JSON.stringify(next));
      games = next;
      message.textContent = 'Сохранено в этом браузере.';
      render();
      return true;
    } catch {
      message.textContent = 'Не удалось сохранить список в браузере.';
      return false;
    }
  }

  search.oninput = filter.onchange = render;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const title = form.elements.title.value.trim();
    if (!title) return;
    if (games.some(game => keyOf(game.title) === keyOf(title))) {
      message.textContent = 'Эта игра уже в списке.';
      return;
    }
    if (save([...games, { title, status: 'idea' }])) form.reset();
  });
  file.addEventListener('change', async () => {
    const selected = file.files[0];
    const version = session;
    if (!selected || !isOwner()) return;
    file.disabled = true;
    try {
      const incoming = await importGames(selected);
      if (version !== session || !isOwner()) return;
      const merged = new Map(games.map(item => [keyOf(item.title), item]));
      for (const item of incoming) if (!merged.has(keyOf(item.title))) merged.set(keyOf(item.title), item);
      const added = merged.size - games.length;
      if (save([...merged.values()])) message.textContent = `Новых игр добавлено: ${added}.`;
    } catch (error) {
      if (version === session) message.textContent = error.message;
    } finally {
      file.value = '';
      file.disabled = false;
    }
  });

  return {
    show() {
      try { games = JSON.parse(localStorage.getItem(key) || '[]'); }
      catch { message.textContent = 'Не удалось прочитать сохранённые игры.'; }
      render();
    },
    reset() {
      session++;
      games = [];
      list.replaceChildren();
      search.value = filter.value = '';
      form.reset();
      file.value = '';
      byId('games-count').textContent = '';
      message.textContent = '';
    }
  };
}
