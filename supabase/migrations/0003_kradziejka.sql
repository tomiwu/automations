-- 0003_kradziejka: registry of Grok bots for the kradziejka package.
-- Each row is one bot. The webhook key is ciphertext only (AES-256-GCM, format v1.<iv>.<data>).
-- The format is the same as the credentials table. The key is not in the database.
-- The package encrypts the key with the credential key from ./configure.
-- Each Family needs one row with slug "hub". The package does not insert that row:
-- the webhook URL and the key come from the owner.
-- The slug "create_new_bot" is reserved for routing. It is not a row.

create table if not exists kradziejka_bots (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{0,40}$' and slug <> 'create_new_bot'),
  name text not null check (char_length(name) between 1 and 80),
  description text not null check (char_length(description) between 1 and 500),
  active_hours text not null default 'always' check (char_length(active_hours) between 1 and 32),
  webhook_url text not null check (webhook_url ~ '^https://api2\.cursor\.sh/automations/webhook/[A-Za-z0-9_-]{1,128}$'),
  webhook_key_ciphertext text not null check (webhook_key_ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (family_id, slug)
);

create index if not exists kradziejka_bots_family_idx on kradziejka_bots (family_id);

revoke all on kradziejka_bots from automations_watcher;
grant select, insert, update on kradziejka_bots to automations_watcher;

alter table kradziejka_bots enable row level security;

drop policy if exists watcher_read on kradziejka_bots;
create policy watcher_read on kradziejka_bots for select to automations_watcher using (true);

drop policy if exists watcher_insert on kradziejka_bots;
create policy watcher_insert on kradziejka_bots for insert to automations_watcher with check (true);

drop policy if exists watcher_update on kradziejka_bots;
create policy watcher_update on kradziejka_bots for update to automations_watcher
  using (true) with check (true);

-- anon and authenticated (the public Supabase roles) get nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on kradziejka_bots from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on kradziejka_bots from authenticated;
  end if;
end
$$;
