-- 0002_credentials: encrypted service credentials (logins and passwords of Librus and the Activity apps).
-- Only the ciphertext is stored: AES-256-GCM, format v1.<iv>.<data>, bound to (family_id, name).
-- The key is never in the database. The owner encrypts with `admin set-credential` on their own computer.

create table if not exists credentials (
  family_id uuid not null references families (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  ciphertext text not null check (ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),
  updated_at timestamptz not null default now(),
  primary key (family_id, name)
);

revoke all on credentials from automations_watcher;
grant select (family_id, name, ciphertext) on credentials to automations_watcher;

alter table credentials enable row level security;

drop policy if exists watcher_read on credentials;
create policy watcher_read on credentials for select to automations_watcher using (true);

-- anon and authenticated (the public Supabase roles) get nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on credentials from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on credentials from authenticated;
  end if;
end
$$;
