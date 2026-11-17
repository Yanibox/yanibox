import { checkData } from './core.mjs';

function endpoint(repo) {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo) || /\/(\.|\.\.)$/.test(repo)) {
    throw new Error('Укажи репозиторий в формате владелец/название.');
  }
  return `https://api.github.com/repos/${repo}/contents/data/movies.json`;
}

async function request(url, token, options = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers, cache: 'no-store', redirect: 'error' });
  if (response.ok) return response.json();
  if (response.status === 409 || response.status === 422) throw new Error('GitHub не принял изменение. Проверь, не обновился ли файл.');
  throw new Error(`GitHub ответил ${response.status}. Проверь репозиторий, токен и права записи.`);
}

export async function checkOwner(repo, token) {
  const user = await request('https://api.github.com/user', token);
  if (user.login?.toLowerCase() !== repo.split('/')[0].toLowerCase()) {
    throw new Error('Вход доступен только аккаунту Yanibox.');
  }
  const repository = await request('https://api.github.com/repos/' + repo, token);
  if (!repository.permissions?.push) throw new Error('В токене нужен доступ на запись в репозиторий сайта.');
}

export async function readGithub(repo, token) {
  const result = await request(endpoint(repo), token);
  if (result.encoding !== 'base64') throw new Error('GitHub не вернул содержимое файла фильмов.');
  const bytes = Uint8Array.from(atob(result.content), char => char.charCodeAt(0));
  return { data: checkData(JSON.parse(new TextDecoder().decode(bytes))), sha: result.sha };
}

export async function writeGithub(repo, token, draft) {
  const { data, sha } = await readGithub(repo, token);
  if (data.revision !== draft.revision) {
    throw new Error('На GitHub появилась другая версия. Черновик сохранён в этом браузере.');
  }
  const next = { ...draft, revision: crypto.randomUUID() };
  const bytes = new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n');
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  const content = btoa(chunks.join(''));
  await request(endpoint(repo), token, {
    method: 'PUT',
    body: JSON.stringify({ message: 'Обновить список фильмов', content, sha })
  });
  return next.revision;
}
