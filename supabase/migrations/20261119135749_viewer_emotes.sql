begin;

create schema viewer_chat;
revoke all on schema viewer_chat from public, anon, authenticated;
grant usage on schema viewer_chat to authenticated, service_role;

create table viewer_chat.emote_totals (
  twitch_id text primary key,
  total bigint not null check (total > 0)
);

create table viewer_chat.counted_messages (
  id uuid primary key,
  received_at timestamptz not null default now()
);
create index on viewer_chat.counted_messages (received_at);

alter table viewer_chat.emote_totals enable row level security;
alter table viewer_chat.counted_messages enable row level security;

create function viewer_chat.record_twitch_emotes(message_id uuid, viewer_id text, emotes integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if viewer_id is null or viewer_id !~ '^[0-9]{1,25}$' or emotes is null or emotes not between 1 and 500 then
    raise exception 'Invalid Twitch emote count';
  end if;

  delete from viewer_chat.counted_messages where received_at < now() - interval '1 day';
  insert into viewer_chat.counted_messages (id) values (message_id)
  on conflict do nothing;
  if found then
    insert into viewer_chat.emote_totals as totals (twitch_id, total) values (viewer_id, emotes)
    on conflict (twitch_id) do update set total = totals.total + excluded.total;
  end if;
end;
$$;

create function viewer_chat.get_my_twitch_emotes()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select totals.total from viewer_chat.emote_totals as totals where totals.twitch_id = identity.provider_id),
    (select 0::bigint from viewer_chat.emote_totals limit 1)
  )
  from auth.identities as identity
  where identity.user_id = (select auth.uid()) and identity.provider = 'twitch'
    and (auth.jwt()->'app_metadata'->>'provider') = 'twitch'
  limit 1;
$$;

create function public.record_twitch_emotes(message_id uuid, viewer_id text, emotes integer)
returns void
language sql security invoker set search_path = ''
as $$ select viewer_chat.record_twitch_emotes(message_id, viewer_id, emotes); $$;

create function public.get_my_twitch_emotes()
returns bigint
language sql stable security invoker set search_path = ''
as $$ select viewer_chat.get_my_twitch_emotes(); $$;

revoke all on function viewer_chat.record_twitch_emotes(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.record_twitch_emotes(uuid, text, integer) from public, anon, authenticated;
grant execute on function viewer_chat.record_twitch_emotes(uuid, text, integer) to service_role;
grant execute on function public.record_twitch_emotes(uuid, text, integer) to service_role;
revoke all on function viewer_chat.get_my_twitch_emotes() from public, anon, authenticated;
revoke all on function public.get_my_twitch_emotes() from public, anon, authenticated;
grant execute on function viewer_chat.get_my_twitch_emotes() to authenticated;
grant execute on function public.get_my_twitch_emotes() to authenticated;

commit;
