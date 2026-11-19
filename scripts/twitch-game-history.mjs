import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameKey } from '../games-data.mjs';

const units = { week: 604800, day: 86400, hour: 3600, minute: 60, second: 1 };
const maxGap = 25 * 60;

export function uptimeSeconds(value) {
  if (value === 'offline') return null;
  return value.split(', ').reduce((total, part) => {
    const match = /^(\d+) (week|day|hour|minute|second)s?$/.exec(part);
    if (!match) throw new Error('Unrecognized Twitch uptime response');
    return total + Number(match[1]) * units[match[2]];
  }, 0);
}

export function recordSample(state, sample, now) {
  if (sample === null && state.startedAt && !state.last) return state;
  const iso = new Date(now * 1000).toISOString();
  const next = { ...state, startedAt: state.startedAt || iso, last: null };
  if (!sample) return next;
  const category = gameKey(sample.category);
  if (!category || !Number.isInteger(sample.uptime) || sample.uptime < 0) throw new Error('Invalid Twitch sample');
  next.last = { category, at: now, uptime: sample.uptime };
  const last = state.last;
  if (!last) return next;
  const elapsed = now - last.at;
  if (elapsed <= 0) return state;
  const uptimeChange = sample.uptime - last.uptime;
  if (category === last.category && elapsed <= maxGap && Math.abs(uptimeChange - elapsed) <= 35) {
    const counts = state.seconds || {};
    const previous = Object.hasOwn(counts, category) ? counts[category] : 0;
    next.seconds = { ...counts, [category]: previous + elapsed };
    next.updatedAt = iso;
  }
  return next;
}

export async function readGameHistory(directory) {
  if (!directory) return {};
  try {
    return JSON.parse(await readFile(resolve(directory, 'twitch-games.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function readTwitch(path) {
  const response = await fetch('https://decapi.me/twitch/' + path, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Twitch data unavailable (${response.status})`);
  return (await response.text()).trim();
}

async function main(directory) {
  const state = await readGameHistory(directory);
  const uptime = uptimeSeconds(await readTwitch('uptime/yanibox?offline_msg=offline'));
  const now = Math.floor(Date.now() / 1000);
  const category = uptime === null ? '' : await readTwitch('game/yanibox');
  if (uptime !== null && (!category || /^\[|error|offline|not found|no game/i.test(category))) {
    throw new Error('Twitch category unavailable');
  }
  const next = recordSample(state, uptime === null ? null : { category, uptime }, now);
  if (next !== state) await writeFile(resolve(directory, 'twitch-games.json'), JSON.stringify(next, null, 2) + '\n');
  console.log(uptime === null ? 'Yanibox is offline.' : 'Twitch category sampled.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
