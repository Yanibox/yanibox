import { readFile } from 'node:fs/promises';
import { checkData } from '../core.mjs';

const { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = process.env;
if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url) || !/^sb_secret_[\w-]+$/.test(key)) {
  throw new Error('Film rating sync requires SUPABASE_URL and a Supabase secret key.');
}
const { items } = checkData(JSON.parse(await readFile('dist/data/movies.json', 'utf8')));
const movieIds = items.filter(item => item.status === 'watched').map(item => item.id);
const response = await fetch(new URL('/rest/v1/rpc/sync_watched_films', url), {
  method: 'POST',
  headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ movie_ids: movieIds }),
  signal: AbortSignal.timeout(15000),
  redirect: 'error'
});
if (!response.ok) throw new Error(`Film rating sync failed (HTTP ${response.status}).`);
console.log(`Enabled viewer ratings for ${movieIds.length} watched films.`);
