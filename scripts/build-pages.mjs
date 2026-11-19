import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { checkData, uploadedPoster } from '../core.mjs';
import { findMovieInfo, movieKey } from '../movie-info.mjs';
import { buildWatchtime } from './watchtime.mjs';
import { publishWatchtimeHistory } from './watchtime-history.mjs';

const publicFiles = [
  '.nojekyll', 'index.html', 'films.html', 'admin.html', 'style.css', 'core.mjs',
  'admin.mjs', 'catalog.mjs', 'film-ratings.mjs', 'github.mjs', 'twitch.mjs', 'movie-info.mjs',
  'data/movies.json', 'watchtime.html', 'watchtime.mjs', 'watchtime-period.mjs', 'showcase.css', 'home.css'
];
const watchtime = buildWatchtime(process.env.WATCHTIME_CACHE_URL);
const { items } = checkData(JSON.parse(await readFile('data/movies.json', 'utf8')));
const posters = [...new Set(items.map(item => item.poster).filter(uploadedPoster))];
const previous = {};
const cacheUrl = process.env.MOVIE_CATALOG_CACHE_URL;
if (cacheUrl && items.length) {
  try {
    const response = await fetch(cacheUrl, { signal: AbortSignal.timeout(8000) });
    if (response.ok) Object.assign(previous, (await response.json()).records);
  } catch {
    console.log('Previous metadata unavailable; rebuilding from Wikidata.');
  }
}

const titles = new Map(items.filter(item => !(item.poster || item.autoPoster) || !item.runtime)
  .map(item => [movieKey(item.title), item.title]).filter(([key]) => key));
const records = Object.fromEntries([...titles.keys()].filter(key => Object.hasOwn(previous, key))
  .map(key => [key, previous[key]]));
const hour = 60 * 60 * 1000;
const now = Date.now();
const pending = [...titles].filter(([key]) => {
  const earlier = records[key];
  const maxAge = earlier?.info?.poster && earlier?.info?.runtime ? 30 * 24 * hour : 6 * hour;
  return !earlier || now - earlier.checkedAt >= maxAge;
}).sort(([a], [b]) => (records[a]?.checkedAt || 0) - (records[b]?.checkedAt || 0)).slice(0, 24);

for (const [key, title] of pending) {
  try {
    const info = await findMovieInfo(title);
    records[key] = { info, checkedAt: now };
  } catch {
    // Keep previously published details and retry this title at the next build.
    console.log('A metadata request failed; it will be retried.');
  }
}

await mkdir('dist/data', { recursive: true });
if (posters.length) await mkdir('dist/data/posters', { recursive: true });
await Promise.all([...publicFiles, ...posters].map(path => copyFile(path, 'dist/' + path)));
await writeFile('dist/data/movie-info.json', JSON.stringify({ records }) + '\n');
const { SUPABASE_URL: ratingsUrl, SUPABASE_PUBLISHABLE_KEY: ratingsKey } = process.env;
if (ratingsUrl || ratingsKey) {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(ratingsUrl) ||
      !/^sb_publishable_[\w-]+$/.test(ratingsKey)) {
    throw new Error('Set SUPABASE_URL and a Supabase publishable key for film ratings.');
  }
  await copyFile('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'dist/supabase.js');
  await writeFile('dist/data/rating-config.json', JSON.stringify({ url: ratingsUrl, key: ratingsKey }) + '\n');
} else {
  await writeFile('dist/data/rating-config.json', 'null\n');
}
const watchtimeSnapshot = await watchtime;
watchtimeSnapshot.days = await publishWatchtimeHistory(process.env.WATCHTIME_HISTORY_DIR, watchtimeSnapshot.periods.global);
await writeFile('dist/data/watchtime.json', JSON.stringify(watchtimeSnapshot) + '\n');
console.log(`Prepared Pages artifact for ${items.length} films; checked ${pending.length} titles.`);
