import { checkData, uploadedPoster } from './core.mjs';

const api = 'https://api.github.com';
const catalogPath = 'data/movies.json';

function endpoint(repo) {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo) || /\/(\.|\.\.)$/.test(repo)) {
    throw new Error('Укажи репозиторий в формате владелец/название.');
  }
  return `${api}/repos/${repo}/contents/${catalogPath}`;
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

export async function readGithub(repo, token, ref) {
  const file = new URL(endpoint(repo));
  if (ref) file.searchParams.set('ref', ref);
  const result = await request(file, token);
  if (result.encoding !== 'base64') throw new Error('GitHub не вернул содержимое файла фильмов.');
  const bytes = Uint8Array.from(atob(result.content), char => char.charCodeAt(0));
  return { data: checkData(JSON.parse(new TextDecoder().decode(bytes))), sha: result.sha };
}

function encodeCatalog(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(''));
}

export async function writeGithub(repo, token, draft, posters = {}) {
  const additions = [];
  for (const [path, dataUrl] of Object.entries(posters)) {
    const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!uploadedPoster(path) || !match || !draft.items.some(item => item.poster === path)) {
      throw new Error('Постер в черновике повреждён. Выбери файл заново.');
    }
    additions.push({ path, contents: match[1] });
  }
  const file = endpoint(repo);
  const hasImages = additions.length > 0;
  const head = hasImages ? (await request(`${api}/repos/${repo}/git/ref/heads/main`, token)).object.sha : undefined;
  const { data, sha } = await readGithub(repo, token, head);
  if (data.revision !== draft.revision) {
    if (JSON.stringify(data) === JSON.stringify({ ...draft, revision: data.revision })) return data.revision;
    throw new Error('На GitHub появилась другая версия списка. Черновик сохранён в этом браузере.');
  }
  const next = { ...draft, revision: crypto.randomUUID() };
  const content = encodeCatalog(next);
  const message = 'Обновить список фильмов';
  if (hasImages) {
    additions.push({ path: catalogPath, contents: content });
    const result = await request(`${api}/graphql`, token, {
      method: 'POST',
      body: JSON.stringify({
        query: 'mutation Publish($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
        variables: { input: {
          branch: { repositoryNameWithOwner: repo, refName: 'refs/heads/main' },
          expectedHeadOid: head,
          message: { headline: message },
          fileChanges: { additions }
        } }
      })
    });
    if (!result.data?.createCommitOnBranch?.commit?.oid) {
      const reason = result.errors?.[0]?.message;
      throw new Error(`GitHub не сохранил фильм с постером. ${reason || 'Повтори публикацию.'}`);
    }
  } else {
    await request(file, token, {
      method: 'PUT', body: JSON.stringify({ message, content, sha, branch: 'main' })
    });
  }
  return next.revision;
}
