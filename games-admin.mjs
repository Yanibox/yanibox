import { element, posterUrl } from './core.mjs';
import { checkGames, gameKey, gameStatuses } from './games-data.mjs';
import { readGames, writeGames } from './github.mjs';

export function gamesAdmin(repo, credential) {
  const byId = id => document.getElementById(id);
  const list = byId('game-list');
  const search = byId('game-search');
  const form = byId('game-editor');
  const fields = form.elements;
  const message = byId('games-message');
  const reload = byId('games-reload');
  const editable = ['title', 'status', 'poster', 'twitchCategory', 'hltbId', 'averageMinutes', 'ownMinutes'];
  let current;
  let selected;
  let busy = false;

  for (const [value, label] of Object.entries(gameStatuses)) fields.status.add(new Option(label, value));

  function edit(game) {
    form.reset();
    selected = game;
    if (game) for (const name of editable) fields[name].value = game[name] ?? '';
    byId('game-edit-title').textContent = game ? 'Редактировать игру' : 'Добавить игру';
    byId('game-cancel').hidden = !game;
    if (game) fields.title.focus();
  }

  function render() {
    const games = current?.items || [];
    const key = gameKey(search.value);
    const visible = games.filter(game => gameKey(game.title).includes(key));
    byId('games-count').textContent = current ? `${visible.length} из ${games.length}` : '';
    list.replaceChildren(...visible.map(game => {
      const row = element('li');
      const details = element('div');
      const change = element('button', 'Изменить');
      change.type = 'button';
      change.setAttribute('aria-label', 'Изменить «' + game.title + '»');
      change.onclick = () => { if (!busy) edit(game); };
      details.append(element('strong', game.title), element('p', gameStatuses[game.status], 'hint'));
      row.append(details, change);
      return row;
    }));
    if (current && !visible.length) list.append(element('li', 'Игры не найдены.', 'muted'));
  }

  async function run(action) {
    const token = credential();
    if (!token || busy) return;
    busy = reload.disabled = form.inert = true;
    message.textContent = 'Связываемся с GitHub…';
    try { await action(token); }
    catch (error) { if (token === credential()) message.textContent = error.message; }
    finally {
      busy = reload.disabled = false;
      form.inert = !current;
    }
  }

  function load() {
    return run(async token => {
      const snapshot = await readGames(repo, token);
      if (token !== credential()) return;
      current = { items: checkGames(snapshot.data), sha: snapshot.sha };
      edit();
      render();
      message.textContent = '';
    });
  }

  reload.onclick = () => void load();
  search.oninput = render;
  byId('game-cancel').onclick = () => edit();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !current) return;
    const values = Object.fromEntries(new FormData(form));
    values.title = values.title.trim();
    if (!values.title) return;
    if (values.poster && !posterUrl(values.poster)) {
      message.textContent = 'Для обложки нужна прямая ссылка HTTPS.';
      return;
    }
    if (current.items.some(game => game.id !== selected?.id && gameKey(game.title) === gameKey(values.title))) {
      message.textContent = 'Игра уже есть в каталоге.';
      return;
    }
    const [game] = checkGames({ items: [{ ...selected, ...values, id: selected?.id || crypto.randomUUID() }] });
    const items = selected ? current.items.map(item => item.id === game.id ? game : item) : [...current.items, game];
    void run(async token => {
      const sha = await writeGames(repo, token, { items }, current.sha);
      if (token !== credential()) return;
      current = { items, sha };
      edit();
      render();
      message.textContent = 'Сохранено. Изменения появятся у зрителей после публикации сайта.';
    });
  });

  return {
    show() { if (!current) void load(); },
    reset() {
      current = undefined;
      edit();
      search.value = '';
      message.textContent = '';
      form.inert = true;
      render();
    }
  };
}
