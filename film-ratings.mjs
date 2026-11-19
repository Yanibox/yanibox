import { element } from './core.mjs';
import { session, settings, viewerRequest, publicRatings, onSessionChange } from './viewer-account.mjs?v=passkeys';

export function filmRatings(onChange) {
  let configured;
  let linked;
  let ratings;
  let loadId = 0;

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
    const label = ratings === undefined ? 'Зрители: загружаем оценки…' :
      ratings === null ? 'Зрители: оценки временно недоступны' :
      current?.votes ? `Зрители: ${Number(current.average).toLocaleString('ru')} / 10 · голосов: ${current.votes}` :
      'Зрители: пока без оценок';
    block.append(element('p', label));
    if (!current) return block;

    if (!linked) {
      const link = element('a', session() ? 'Привязать Twitch для оценки' : 'Войти, чтобы оценить', 'button');
      link.href = 'profile.html';
      block.append(link);
      return block;
    }

    const form = element('form', null, 'viewer-vote');
    const select = element('select');
    select.required = true;
    select.setAttribute('aria-label', 'Твоя оценка: ' + item.title);
    select.add(new Option('Оценка', ''));
    for (let score = 1; score <= 10; score++) select.add(new Option(`${score} / 10`, String(score)));
    select.value = current.mine == null ? '' : String(current.mine);
    const submit = element('button', current.mine == null ? 'Оценить' : 'Изменить');
    const result = element('p', '', 'hint');
    result.setAttribute('role', 'status');
    submit.type = 'submit';
    form.append(select, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const voter = session();
      select.disabled = submit.disabled = true;
      result.textContent = '';
      try {
        const { rating: data } = await viewerRequest('vote', {
          movie: item.id, score: Number(select.value)
        });
        if (voter !== session()) return;
        if (ratings) ratings[item.id] = data;
        block.firstElementChild.textContent = `Зрители: ${Number(data.average).toLocaleString('ru')} / 10 · голосов: ${data.votes}`;
        submit.textContent = 'Изменить';
        result.textContent = 'Оценка сохранена.';
      } catch (error) {
        if (error.message === 'session' || error.message === 'link-required') void loadRatings();
        result.textContent = 'Не удалось сохранить оценку. Попробуй ещё раз.';
      } finally {
        select.disabled = submit.disabled = false;
      }
    });
    block.append(form, result);
    return block;
  }

  return { forMovie };
}
