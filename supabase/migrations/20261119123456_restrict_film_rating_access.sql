begin;

-- Keep privileged functions out of the schemas served by the Data API.
alter function public.get_film_ratings() set schema viewer_ratings;
alter function public.set_film_rating(text, smallint) set schema viewer_ratings;
alter function public.sync_watched_films(text[]) set schema viewer_ratings;
revoke all on function viewer_ratings.sync_watched_films(text[]) from service_role;
grant usage on schema viewer_ratings to anon, authenticated;

create table viewer_ratings.sync_config (
  singleton boolean primary key default true check (singleton),
  key_hash bytea not null check (octet_length(key_hash) = 32)
);
alter table viewer_ratings.sync_config enable row level security;

create function viewer_ratings.sync_watched_films_with_key(movie_ids text[], sync_key text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  configured_hash bytea;
begin
  select key_hash into configured_hash from viewer_ratings.sync_config where singleton;
  if configured_hash is null or sync_key is null
    or sync_key !~ '^[0-9a-f]{64}$'
    or sha256(convert_to(sync_key, 'UTF8')) <> configured_hash then
    raise exception 'Film sync credentials required' using errcode = '42501';
  end if;
  if movie_ids is null or array_position(movie_ids, null) is not null then
    raise exception 'Invalid list of films' using errcode = '22023';
  end if;
  perform viewer_ratings.sync_watched_films(movie_ids);
end;
$$;

create function public.get_film_ratings()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$ select viewer_ratings.get_film_ratings(); $$;

create function public.set_film_rating(movie_id text, score smallint)
returns jsonb
language sql security invoker
set search_path = ''
as $$ select viewer_ratings.set_film_rating(movie_id, score); $$;

create function public.sync_watched_films(movie_ids text[], sync_key text)
returns void
language sql security invoker
set search_path = ''
as $$ select viewer_ratings.sync_watched_films_with_key(movie_ids, sync_key); $$;

revoke all on function viewer_ratings.sync_watched_films_with_key(text[], text) from public, anon, authenticated;
revoke all on function public.get_film_ratings() from public, anon, authenticated;
revoke all on function public.set_film_rating(text, smallint) from public, anon, authenticated;
revoke all on function public.sync_watched_films(text[], text) from public, anon, authenticated;
grant execute on function viewer_ratings.sync_watched_films_with_key(text[], text) to anon;
grant execute on function public.get_film_ratings() to anon, authenticated;
grant execute on function public.set_film_rating(text, smallint) to authenticated;
grant execute on function public.sync_watched_films(text[], text) to anon;

commit;
