begin;

create table viewer_chat.webhook_config (
  singleton boolean primary key default true check (singleton),
  broadcaster_id text not null check (broadcaster_id ~ '^[0-9]{1,25}$'),
  vault_id uuid not null unique
);
alter table viewer_chat.webhook_config enable row level security;

create function public.yanibox_chat_prepare(owner_id text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  key_value text;
  key_id uuid;
begin
  lock table viewer_chat.webhook_config in share row exclusive mode;
  select config.vault_id into key_id from viewer_chat.webhook_config as config where singleton and broadcaster_id = owner_id;
  if found then
    select decrypted_secret into key_value from vault.decrypted_secrets where id = key_id;
    return key_value;
  end if;
  key_value := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  key_id := vault.create_secret(key_value, 'yanibox-eventsub-signing-key', 'Verifies signed Twitch chat events');
  insert into viewer_chat.webhook_config (broadcaster_id, vault_id) values (owner_id, key_id);
  return key_value;
end;
$$;

create function public.yanibox_chat_config()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('broadcaster', config.broadcaster_id, 'secret', secret.decrypted_secret)
  from viewer_chat.webhook_config as config
  join vault.decrypted_secrets as secret on secret.id = config.vault_id
  where config.singleton;
$$;

revoke all on function public.yanibox_chat_prepare(text), public.yanibox_chat_config() from public, anon, authenticated;
grant execute on function public.yanibox_chat_prepare(text), public.yanibox_chat_config() to service_role;

commit;
