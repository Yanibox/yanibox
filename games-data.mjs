import { posterUrl } from './core.mjs';

export const gameStatuses = { idea: 'В планах', playing: 'В процессе', finished: 'Пройдена' };

export function gameKey(value) {
  return value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function positive(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function checkGames(data) {
  if (!Array.isArray(data?.items) || data.items.some(game => !game?.id || !game.title?.trim())) {
    throw new Error('Не удалось прочитать каталог игр.');
  }
  return data.items.map(game => ({
    id: String(game.id),
    title: game.title.trim().slice(0, 160),
    status: Object.hasOwn(gameStatuses, game.status) ? game.status : 'idea',
    poster: posterUrl(game.poster),
    twitchCategory: String(game.twitchCategory || game.title).trim(),
    hltbId: positive(game.hltbId),
    averageMinutes: positive(game.averageMinutes),
    ownMinutes: positive(game.ownMinutes)
  }));
}

export function gameDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  if (minutes < 1) return 'меньше 1 мин';
  const hours = Math.floor(minutes / 60);
  const rest = Math.floor(minutes % 60);
  return [hours && `${hours} ч`, rest && `${rest} мин`].filter(Boolean).join(' ');
}
