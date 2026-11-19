begin;

create schema if not exists viewer_ratings;

create table viewer_ratings.watched_films (
  id text primary key
);

create table viewer_ratings.votes (
  film_id text not null,
  voter_id uuid not null references auth.users(id) on delete cascade,
  score smallint not null check (score between 1 and 10),
  primary key (film_id, voter_id)
);

create index on viewer_ratings.votes (voter_id);
alter table viewer_ratings.watched_films enable row level security;
alter table viewer_ratings.votes enable row level security;
revoke all on schema viewer_ratings from public, anon, authenticated;

create function public.get_film_ratings()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(id, statistics), '{}'::jsonb)
  from (
    select film.id, jsonb_build_object(
      'average', round(avg(vote.score), 1),
      'votes', count(vote.score),
      'mine', max(vote.score) filter (where vote.voter_id = (select auth.uid()))
    ) as statistics
    from viewer_ratings.watched_films as film
    left join viewer_ratings.votes as vote on vote.film_id = film.id
    group by film.id
  ) as ratings;
$$;

create function public.set_film_rating(movie_id text, score smallint)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  voter uuid := auth.uid();
begin
  if voter is null or (auth.jwt()->'app_metadata'->>'provider') is distinct from 'twitch' then
    raise exception 'Twitch login required' using errcode = '42501';
  end if;
  if score is null or score not between 1 and 10 then
    raise exception 'Rating must be an integer from 1 to 10' using errcode = '22023';
  end if;

  perform 1 from viewer_ratings.watched_films where id = movie_id for key share;
  if not found then
    raise exception 'Film is not open for ratings' using errcode = '22023';
  end if;

  insert into viewer_ratings.votes (film_id, voter_id, score)
  values (movie_id, voter, score)
  on conflict (film_id, voter_id) do update set score = excluded.score;

  return (
    select jsonb_build_object('average', round(avg(vote.score), 1), 'votes', count(*),
      'mine', max(vote.score) filter (where vote.voter_id = voter))
    from viewer_ratings.votes as vote
    where vote.film_id = movie_id
  );
end;
$$;

create function public.sync_watched_films(movie_ids text[])
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  lock table viewer_ratings.watched_films in share row exclusive mode;
  delete from viewer_ratings.watched_films where not (id = any(movie_ids));
  insert into viewer_ratings.watched_films (id)
  select unnest(movie_ids)
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.get_film_ratings() from public, anon, authenticated;
revoke all on function public.set_film_rating(text, smallint) from public, anon, authenticated;
revoke all on function public.sync_watched_films(text[]) from public, anon, authenticated;
grant execute on function public.get_film_ratings() to anon, authenticated;
grant execute on function public.set_film_rating(text, smallint) to authenticated;
grant execute on function public.sync_watched_films(text[]) to service_role;

commit;
