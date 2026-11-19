begin;

create table public.yanibox_profiles (
  id uuid primary key,
  display_name text not null check (char_length(display_name) between 2 and 32),
  recovery_hash text not null unique,
  twitch_id text unique,
  twitch_login text,
  check ((twitch_id is null) = (twitch_login is null))
);

create table public.yanibox_passkeys (
  id text primary key,
  profile_id uuid not null unique references public.yanibox_profiles on delete cascade,
  public_key text not null,
  counter bigint not null check (counter >= 0),
  transports text[] not null default '{}'
);

create table public.yanibox_challenges (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('register', 'login', 'recover')),
  challenge text not null unique,
  profile_id uuid,
  display_name text,
  recovery_hash text,
  expires_at timestamptz not null default now() + interval '5 minutes'
);

create table public.yanibox_sessions (
  token_hash text primary key,
  profile_id uuid not null references public.yanibox_profiles on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days'
);

create table public.yanibox_link_codes (
  profile_id uuid primary key references public.yanibox_profiles on delete cascade,
  code_hash text not null unique,
  twitch_id text not null,
  expires_at timestamptz not null default now() + interval '5 minutes'
);

create table public.yanibox_request_limits (
  bucket text primary key,
  hits integer not null,
  expires_at timestamptz not null
);

create index on public.yanibox_sessions (profile_id);
create index on public.yanibox_sessions (expires_at);
create index on public.yanibox_challenges (expires_at);
create index on public.yanibox_link_codes (expires_at);
create index on public.yanibox_request_limits (expires_at);

alter table public.yanibox_profiles enable row level security;
alter table public.yanibox_passkeys enable row level security;
alter table public.yanibox_challenges enable row level security;
alter table public.yanibox_sessions enable row level security;
alter table public.yanibox_link_codes enable row level security;
alter table public.yanibox_request_limits enable row level security;

revoke all on public.yanibox_profiles, public.yanibox_passkeys, public.yanibox_challenges,
  public.yanibox_sessions, public.yanibox_link_codes, public.yanibox_request_limits from public, anon, authenticated;
grant select, insert, update, delete on public.yanibox_profiles, public.yanibox_passkeys, public.yanibox_challenges,
  public.yanibox_sessions, public.yanibox_link_codes, public.yanibox_request_limits to service_role;

create function public.yanibox_limit(bucket_key text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  total integer;
begin
  delete from public.yanibox_request_limits where expires_at <= now();
  delete from public.yanibox_challenges where expires_at <= now();
  delete from public.yanibox_sessions where expires_at <= now();
  delete from public.yanibox_link_codes where expires_at <= now();
  insert into public.yanibox_request_limits as limits values (bucket_key, 1, now() + interval '15 minutes')
  on conflict (bucket) do update set hits = limits.hits + 1 where limits.hits < 30
  returning hits into total;
  return total is not null;
end;
$$;

create function public.yanibox_save_passkey(
  account_id uuid, name text, previous_recovery text, next_recovery text, key_id text,
  key_bytes text, key_counter bigint, key_transports text[], session_hash text
)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if previous_recovery is null then
    insert into public.yanibox_profiles (id, display_name, recovery_hash)
    values (account_id, name, next_recovery);
  else
    update public.yanibox_profiles set recovery_hash = next_recovery
    where id = account_id and recovery_hash = previous_recovery;
    if not found then return false; end if;
    delete from public.yanibox_sessions where profile_id = account_id;
    delete from public.yanibox_passkeys where profile_id = account_id;
    delete from public.yanibox_link_codes where profile_id = account_id;
  end if;
  insert into public.yanibox_passkeys values (key_id, account_id, key_bytes, key_counter, key_transports);
  insert into public.yanibox_sessions (token_hash, profile_id) values (session_hash, account_id);
  return true;
end;
$$;

create function public.yanibox_finish_login(key_id text, key_bytes text, previous_counter bigint, next_counter bigint, session_hash text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  account_id uuid;
begin
  update public.yanibox_passkeys set counter = next_counter
  where id = key_id and public_key = key_bytes and counter = previous_counter returning profile_id into account_id;
  if not found then return false; end if;
  insert into public.yanibox_sessions (token_hash, profile_id) values (session_hash, account_id);
  return true;
end;
$$;

create function public.yanibox_confirm_twitch(digest text, sender_id text, sender_login text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  account_id uuid;
begin
  if sender_id !~ '^[0-9]{1,25}$' or sender_login !~ '^[a-z0-9_]{1,25}$' then return false; end if;
  select code.profile_id into account_id from public.yanibox_link_codes as code
  where code.code_hash = digest and code.twitch_id = sender_id and code.expires_at > now();
  if not found then return false; end if;

  perform 1 from public.yanibox_profiles where id = account_id and twitch_id is null for update;
  if not found or exists (select 1 from public.yanibox_profiles where twitch_id = sender_id) then return false; end if;
  delete from public.yanibox_link_codes
  where profile_id = account_id and code_hash = digest and twitch_id = sender_id and expires_at > now();
  if not found then return false; end if;
  update public.yanibox_profiles set twitch_id = sender_id, twitch_login = sender_login where id = account_id;
  return true;
exception when unique_violation then
  return false;
end;
$$;

create function public.yanibox_start_link(account_id uuid, digest text, target_twitch_id text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  perform 1 from public.yanibox_profiles where id = account_id and twitch_id is null for update;
  if not found or exists (select 1 from public.yanibox_profiles where twitch_id = target_twitch_id) then return false; end if;
  insert into public.yanibox_link_codes (profile_id, code_hash, twitch_id)
  values (account_id, digest, target_twitch_id)
  on conflict (profile_id) do update
  set code_hash = excluded.code_hash, twitch_id = excluded.twitch_id, expires_at = excluded.expires_at;
  return true;
end;
$$;

grant usage on schema viewer_ratings, viewer_chat to service_role;
grant select on viewer_chat.emote_totals to service_role;

-- Copy verified legacy votes by Twitch ID. Abort if the old data cannot all be transferred.
lock table viewer_ratings.votes in share row exclusive mode;
create table viewer_ratings.twitch_votes (
  film_id text not null,
  twitch_id text not null check (twitch_id ~ '^[0-9]{1,25}$'),
  score smallint not null check (score between 1 and 10),
  primary key (film_id, twitch_id)
);
create index on viewer_ratings.twitch_votes (twitch_id);
alter table viewer_ratings.twitch_votes enable row level security;
grant select, insert, update, delete on viewer_ratings.twitch_votes to service_role;
grant select, update on viewer_ratings.watched_films to service_role;
insert into viewer_ratings.twitch_votes
select vote.film_id, identity.provider_id, vote.score
from viewer_ratings.votes as vote
join auth.identities as identity on identity.user_id = vote.voter_id and identity.provider = 'twitch';
do $$
begin
  if (select count(*) from viewer_ratings.twitch_votes) <> (select count(*) from viewer_ratings.votes) then
    raise exception 'Could not map legacy film ratings to Twitch';
  end if;
end;
$$;

create function viewer_ratings.twitch_rating_summary(owner_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(id, statistics), '{}'::jsonb)
  from (
    select film.id, jsonb_build_object(
      'average', round(avg(vote.score), 1),
      'votes', count(vote.score),
      'mine', max(vote.score) filter (where vote.twitch_id = owner_id)
    ) as statistics
    from viewer_ratings.watched_films as film
    left join viewer_ratings.twitch_votes as vote on vote.film_id = film.id
    group by film.id
  ) as ratings;
$$;

revoke all on function viewer_ratings.twitch_rating_summary(text) from public, anon, authenticated;
grant execute on function viewer_ratings.twitch_rating_summary(text) to service_role;

create or replace function viewer_ratings.get_film_ratings()
returns jsonb
language sql stable security definer set search_path = ''
as $$ select viewer_ratings.twitch_rating_summary(null); $$;

drop function public.set_film_rating(text, smallint);
drop function viewer_ratings.set_film_rating(text, smallint);
revoke execute on function public.get_my_twitch_emotes(), viewer_chat.get_my_twitch_emotes() from authenticated;

create function public.yanibox_private_ratings(account_id uuid)
returns jsonb
language sql stable set search_path = ''
as $$
  select viewer_ratings.twitch_rating_summary(
    (select twitch_id from public.yanibox_profiles where id = account_id)
  );
$$;

create function public.yanibox_vote(account_id uuid, movie_id text, rating smallint)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  voter text;
begin
  select twitch_id into voter from public.yanibox_profiles where id = account_id for share;
  if voter is null then return null; end if;
  perform 1 from viewer_ratings.watched_films where id = movie_id for key share;
  if not found then return null; end if;
  insert into viewer_ratings.twitch_votes (film_id, twitch_id, score)
  values (movie_id, voter, rating)
  on conflict (film_id, twitch_id) do update set score = excluded.score;
  return (
    select jsonb_build_object('average', round(avg(score), 1), 'votes', count(*), 'mine', rating)
    from viewer_ratings.twitch_votes where film_id = movie_id
  );
end;
$$;

create function public.yanibox_emotes(account_id uuid)
returns bigint
language sql stable set search_path = ''
as $$
  select total.total from public.yanibox_profiles as profile
  join viewer_chat.emote_totals as total on total.twitch_id = profile.twitch_id
  where profile.id = account_id;
$$;

create function public.yanibox_remove_link(account_id uuid, delete_profile boolean)
returns void
language plpgsql set search_path = ''
as $$
declare
  linked_id text;
begin
  select twitch_id into linked_id from public.yanibox_profiles where id = account_id for update;
  delete from viewer_ratings.twitch_votes where twitch_id = linked_id;
  if delete_profile then
    delete from public.yanibox_profiles where id = account_id;
  else
    delete from public.yanibox_link_codes where profile_id = account_id;
    update public.yanibox_profiles set twitch_id = null, twitch_login = null where id = account_id;
  end if;
end;
$$;

revoke all on function public.yanibox_limit(text),
  public.yanibox_save_passkey(uuid, text, text, text, text, text, bigint, text[], text),
  public.yanibox_finish_login(text, text, bigint, bigint, text), public.yanibox_confirm_twitch(text, text, text),
  public.yanibox_start_link(uuid, text, text), public.yanibox_private_ratings(uuid),
  public.yanibox_vote(uuid, text, smallint), public.yanibox_emotes(uuid), public.yanibox_remove_link(uuid, boolean)
from public, anon, authenticated;
grant execute on function public.yanibox_limit(text),
  public.yanibox_save_passkey(uuid, text, text, text, text, text, bigint, text[], text),
  public.yanibox_finish_login(text, text, bigint, bigint, text), public.yanibox_confirm_twitch(text, text, text),
  public.yanibox_start_link(uuid, text, text), public.yanibox_private_ratings(uuid),
  public.yanibox_vote(uuid, text, smallint), public.yanibox_emotes(uuid), public.yanibox_remove_link(uuid, boolean)
to service_role;

commit;
