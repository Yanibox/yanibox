import { readFile } from 'node:fs/promises';
import { checkData } from '../core.mjs';

const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, YANIBOX_RATINGS_SYNC_KEY: syncKey } = process.env;
if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url) ||
    !/^sb_publishable_[\w-]+$/.test(key) || !/^[0-9a-f]{64}$/.test(syncKey)) {
  throw new Error('Film rating sync requires the Supabase URL, publishable key and Yanibox sync key.');
}
const { items } = checkData(JSON.parse(await readFile('dist/data/movies.json', 'utf8')));
const movieIds = items.filter(item => item.status === 'watched').map(item => item.id);
const response = await fetch(new URL('/rest/v1/rpc/sync_watched_films', url), {
  method: 'POST',
  headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ movie_ids: movieIds, sync_key: syncKey }),
  signal: AbortSignal.timeout(15000),
  redirect: 'error'
});
if (!response.ok) throw new Error(`Film rating sync failed (HTTP ${response.status}).`);
console.log(`Enabled viewer ratings for ${movieIds.length} watched films.`);
