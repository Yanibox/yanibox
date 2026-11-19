begin;

alter table public.yanibox_profiles
  alter column recovery_hash drop not null,
  add column login text unique check (login collate "C" ~ '^[a-zа-яё0-9_]{3,24}$'),
  add column password_hash text check (password_hash ~ '^argon2id-1:[a-f0-9]{32}:[a-f0-9]{64}$'),
  add constraint yanibox_password_credentials check ((login is null) = (password_hash is null));

create function public.yanibox_register_password(handle text, name text, verifier text, session_hash text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  account_id uuid;
begin
  insert into public.yanibox_profiles (id, display_name, login, password_hash)
  values (gen_random_uuid(), name, handle, verifier)
  on conflict (login) do nothing returning id into account_id;
  if not found then return false; end if;
  insert into public.yanibox_sessions (token_hash, profile_id) values (session_hash, account_id);
  return true;
end;
$$;

create function public.yanibox_login_password(handle text, verifier text, session_hash text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  insert into public.yanibox_sessions (token_hash, profile_id)
  select session_hash, id from public.yanibox_profiles
  where login = handle and password_hash = verifier for key share;
  return found;
end;
$$;

create function public.yanibox_upgrade_password(
  handle text, verifier text, new_session text, previous_session text, legacy_code text
)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  account_id uuid;
begin
  if (previous_session is null) = (legacy_code is null) then return false; end if;
  select profile.id into account_id from public.yanibox_profiles as profile
  where profile.login is null and (
    profile.recovery_hash = legacy_code or exists (
      select 1 from public.yanibox_sessions as session
      where session.token_hash = previous_session and session.profile_id = profile.id and session.expires_at > now()
    )
  ) for update;
  if not found then return false; end if;
  update public.yanibox_profiles set login = handle, password_hash = verifier, recovery_hash = null
  where id = account_id;
  delete from public.yanibox_sessions where profile_id = account_id;
  delete from public.yanibox_passkeys where profile_id = account_id;
  delete from public.yanibox_challenges where profile_id = account_id;
  insert into public.yanibox_sessions (token_hash, profile_id) values (new_session, account_id);
  return true;
end;
$$;

revoke all on function public.yanibox_register_password(text, text, text, text),
  public.yanibox_login_password(text, text, text), public.yanibox_upgrade_password(text, text, text, text, text)
from public, anon, authenticated;
grant execute on function public.yanibox_register_password(text, text, text, text),
  public.yanibox_login_password(text, text, text), public.yanibox_upgrade_password(text, text, text, text, text)
to service_role;

commit;
