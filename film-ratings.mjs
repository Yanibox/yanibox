import { element } from './core.mjs';
import { onViewerSession, openViewerAccount } from './viewer-account.mjs';

export function filmRatings(onChange) {
  let client;
  let viewerId;
  let ratings;
  let loadId = 0;

  async function loadRatings() {
    const id = ++loadId;
    let nextRatings = null;
    try {
      const { data, error } = await client.rpc('get_film_ratings');
      if (!error) nextRatings = data;
    } catch {
      // Keep the catalog usable when ratings cannot be loaded.
    }
    if (id !== loadId) return;
    ratings = nextRatings;
    onChange();
  }

  onViewerSession((nextClient, nextViewer) => {
    client = nextClient;
    viewerId = nextViewer;
    ratings = undefined;
    loadId++;
    onChange();
    // Supabase Auth holds its session lock while delivering this callback.
    setTimeout(() => void loadRatings(), 0);
  });

  function forMovie(item) {
    if (!client || item.status !== 'watched') return null;
    const block = element('div', null, 'viewer-rating');
    const current = ratings && Object.hasOwn(ratings, item.id) ? ratings[item.id] : null;
    const label = ratings === undefined ? 'Зрители: загружаем оценки…' :
      ratings === null ? 'Зрители: оценки временно недоступны' :
      current?.votes ? `Зрители: ${Number(current.average).toLocaleString('ru')} / 10 · голосов: ${current.votes}` :
      'Зрители: пока без оценок';
    block.append(element('p', label));
    if (!current) return block;

    if (!viewerId) {
      const button = element('button', 'Войти, чтобы оценить');
      button.type = 'button';
      button.addEventListener('click', openViewerAccount);
      block.append(button);
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
      const voter = viewerId;
      select.disabled = submit.disabled = true;
      result.textContent = '';
      try {
        const { data, error } = await client.rpc('set_film_rating', {
          movie_id: item.id, score: Number(select.value)
        });
        if (voter !== viewerId) return;
        if (error) throw error;
        if (ratings) ratings[item.id] = data;
        block.firstElementChild.textContent = `Зрители: ${Number(data.average).toLocaleString('ru')} / 10 · голосов: ${data.votes}`;
        submit.textContent = 'Изменить';
        result.textContent = 'Оценка сохранена.';
      } catch {
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
