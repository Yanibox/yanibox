import { element } from './core.mjs';
import { session, settings, viewerRequest, publicRatings, onSessionChange } from './viewer-account.mjs?v=passkeys';

export function filmRatings(onChange) {
  let configured;
  let linked;
  let ratings;
  let loadId = 0;
  const dialog = document.getElementById('vote-dialog');
  const form = dialog.querySelector('form');
  const select = form.elements.score;
  const submit = form.querySelector('[type="submit"]');
  const result = document.getElementById('vote-message');
  let active;
  for (let score = 1; score <= 10; score++) select.add(new Option(`${score} / 10`, String(score)));

  form.addEventListener('submit', async event => {
    if (event.submitter?.formMethod === 'dialog') return;
    event.preventDefault();
    if (!active || submit.disabled) return;
    const { item, label, button } = active;
    const voter = session();
    select.disabled = submit.disabled = true;
    result.textContent = 'Сохраняем…';
    try {
      const { rating: data } = await viewerRequest('vote', { movie: item.id, score: Number(select.value) });
      if (voter !== session()) return;
      if (ratings) ratings[item.id] = data;
      label.textContent = scoreLabel(data);
      button.textContent = 'Изменить оценку';
      result.textContent = 'Оценка сохранена.';
      if (!button.isConnected) onChange();
    } catch (error) {
      if (error.message === 'session' || error.message === 'link-required') void loadRatings();
      result.textContent = 'Не удалось сохранить оценку. Попробуй ещё раз.';
    } finally {
      select.disabled = submit.disabled = false;
    }
  });

  function scoreLabel(value) {
    return value?.votes ? `Зрители · ${Number(value.average).toLocaleString('ru')}/10 · ${value.votes} гол.` :
      'Зрители · пока без оценок';
  }

  async function loadRatings() {
    const id = ++loadId;
    const config = await settings();
    if (!config || id !== loadId) return;
    configured = true;
    linked = false;
    ratings = undefined;
    onChange();
    const token = session();
    let profile;
    let nextRatings = null;
    try {
      if (token) profile = await viewerRequest('profile');
      if (profile?.twitch) ({ ratings: nextRatings } = await viewerRequest('ratings'));
    } catch {}
    if (!nextRatings) {
      try { nextRatings = await publicRatings(config); } catch {}
    }
    if (id !== loadId) return;
    linked = Boolean(profile?.twitch) && session() === token;
    ratings = nextRatings;
    onChange();
  }

  onSessionChange(() => void loadRatings());
  void loadRatings();

  function forMovie(item) {
    if (!configured || item.status !== 'watched') return null;
    const block = element('div', null, 'viewer-rating');
    const current = ratings && Object.hasOwn(ratings, item.id) ? ratings[item.id] : null;
    const label = element('p', ratings === undefined ? 'Загружаем оценки…' :
      ratings === null ? 'Оценки временно недоступны' : scoreLabel(current));
    block.append(label);
    if (!current) return block;

    if (!linked) {
      const link = element('a', session() ? 'Привязать Twitch для оценки' : 'Войти, чтобы оценить', 'button');
      link.href = 'profile.html';
      block.append(link);
      return block;
    }

    const button = element('button', current.mine == null ? 'Оценить' : 'Изменить оценку');
    button.type = 'button';
    button.addEventListener('click', () => {
      if (submit.disabled) return;
      active = { item, label, button };
      dialog.querySelector('h2').textContent = item.title;
      const mine = ratings?.[item.id]?.mine;
      select.value = mine == null ? '' : String(mine);
      result.textContent = '';
      dialog.showModal();
    });
    block.append(button);
    return block;
  }

  return { forMovie };
}
