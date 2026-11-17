import { minutes, posterUrl } from './core.mjs';

const languages = 'ru|en|mul';
const agent = 'YaniboxMovieCatalog/1.0 (https://github.com/Yanibox/yanibox)';
const wikidata = 'https://www.wikidata.org/w/api.php?';
const units = { Q7727: 1, Q11574: 1 / 60, Q25235: 60 };
const filmType = /\b(?:films?|movies?)\b|(?:фильм|кинолент)/iu;
const television = /\b(?:television|tv|miniseries)\s+(?:series|show)\b|сериал/iu;

function normalize(title) {
  return title.normalize('NFKC').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function splitTitle(title) {
  const suffix = title.match(/(?:\s+((?:18|19|20|21)\d{2})|\s*\(((?:18|19|20|21)\d{2})\))\s*$/u);
  const name = normalize(suffix ? title.slice(0, suffix.index) : title);
  return name ? { name, year: suffix?.[1] || suffix?.[2] || '' } : { name: normalize(title), year: '' };
}

export function movieKey(title) {
  const { name, year } = splitTitle(title);
  return name ? `${name}|${year}` : '';
}

export const runtimeLabel = value => value ? `${value} мин` : '';

export function movieDetails(item, records) {
  const match = records[movieKey(item.title)]?.info;
  return {
    poster: item.poster || posterUrl(match?.poster),
    runtime: item.runtime || minutes(match?.runtime),
    year: /^\d{4}$/.test(match?.year) ? match.year : ''
  };
}

async function query(parameters) {
  const browser = typeof window !== 'undefined';
  const url = wikidata + new URLSearchParams({ ...parameters, format: 'json', origin: '*' });
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    ...(browser ? {} : { headers: { 'User-Agent': agent } })
  });
  if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error('Wikidata не выполнила запрос.');
  return data;
}

function values(entity, property) {
  const ranked = (entity.claims?.[property] || []).filter(claim => claim.rank !== 'deprecated');
  const preferred = ranked.filter(claim => claim.rank === 'preferred');
  return [...preferred, ...ranked.filter(claim => claim.rank !== 'preferred')]
    .map(claim => claim.mainsnak?.datavalue?.value).filter(Boolean);
}

function candidate(entity, name, year) {
  if (!entity || entity.missing !== undefined) return null;
  const types = values(entity, 'P31').map(value => value.id);
  const descriptions = Object.values(entity.descriptions || {}).map(entry => entry.value);
  const kinoId = values(entity, 'P2603').find(value => /^\d+$/.test(value));
  if (descriptions.some(desc => television.test(desc)) ||
      !(types.some(type => ['Q11424', 'Q202866', 'Q24862'].includes(type)) ||
        (kinoId && descriptions.some(desc => filmType.test(desc))))) return null;

  const names = [...Object.values(entity.labels || {}), ...Object.values(entity.aliases || {}).flat()]
    .map(term => normalize(term.value));
  if (!names.includes(name)) return null;
  const years = values(entity, 'P577').map(value => value.time?.match(/^\+(\d{4})-/)?.[1]);
  if (year && !years.includes(year)) return null;

  const runtime = values(entity, 'P2047').map(value => {
    const unit = value.unit?.split('/').pop();
    return minutes(Math.round(Number(value.amount) * (units[unit] || 0)));
  }).find(Boolean) || null;
  return {
    id: entity.id,
    year: year || years.find(Boolean) || '',
    runtime,
    poster: kinoId ? `https://st.kp.yandex.net/images/film_big/${kinoId}.jpg` : '',
    popularity: Object.keys(entity.sitelinks || {}).length
  };
}

export async function findMovieInfo(title) {
  const { name, year } = splitTitle(title);
  if (!name) return null;
  const language = /[а-яё]/iu.test(name) ? 'ru' : 'en';
  const searches = await Promise.allSettled([
    query({ action: 'wbsearchentities', search: name, language, uselang: language, limit: '12' }),
    query({ action: 'query', list: 'search', srsearch: `"${name}" haswbstatement:P2603`, srlimit: '12' })
  ]);
  if (searches.every(result => result.status === 'rejected')) throw searches[0].reason;
  const ids = [...new Set([
    ...(searches[0].value?.search || []).map(item => item.id),
    ...(searches[1].value?.query?.search || []).map(item => item.title)
  ])].filter(id => /^Q\d+$/.test(id));
  if (!ids.length) return null;

  const entities = await query({
    action: 'wbgetentities', ids: ids.join('|'), languages,
    props: 'labels|aliases|descriptions|claims|sitelinks'
  });
  const matches = ids.map(id => candidate(entities.entities?.[id], name, year)).filter(Boolean)
    .sort((a, b) => b.popularity - a.popularity);
  const [best, other] = matches;
  if (!best || (other && best.popularity < 2 * Math.max(8, other.popularity))) return null;
  return { id: best.id, year: best.year, runtime: best.runtime, poster: best.poster };
}

export async function loadMovieInfo() {
  const response = await fetch(new URL('data/movie-info.json', import.meta.url), { cache: 'no-cache' });
  if (!response.ok) throw new Error('Сведения о фильмах недоступны.');
  return (await response.json()).records || {};
}
