-- 0001_init: schema, RLS and the restricted role "automations_watcher".
-- This migration is idempotent. Run it in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- Tables

create table if not exists families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'UTC',
  default_language text not null default 'en' check (default_language in ('pl', 'en'))
);

create table if not exists children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  name text not null,
  has_librus boolean not null default false,
  calendar_id text
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  child_id uuid not null references children (id) on delete cascade,
  service text not null check (service in ('librus', 'activenow', 'edusky', 'mondo')),
  origin text,
  "group" text,
  login_secret text not null,
  password_secret text not null,
  enabled boolean not null default true
);

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  child_id uuid not null references children (id) on delete cascade,
  account_id uuid references accounts (id) on delete set null,
  name text not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  place text,
  enabled boolean not null default true
);

create table if not exists recipients (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  telegram_chat_id text not null,
  language text not null check (language in ('pl', 'en')),
  child_ids uuid[] not null default '{}'
);

create table if not exists items (
  family_id uuid not null references families (id) on delete cascade,
  watcher text not null,
  id text not null,
  first_seen timestamptz not null default now(),
  primary key (family_id, watcher, id)
);

create table if not exists outbox (
  key text primary key,
  family_id uuid not null references families (id) on delete cascade,
  chat_id text not null,
  text text not null,
  queued_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists children_family_idx on children (family_id);
create index if not exists accounts_family_idx on accounts (family_id);
create index if not exists activities_family_idx on activities (family_id);
create index if not exists recipients_family_idx on recipients (family_id);
create index if not exists outbox_pending_idx on outbox (queued_at) where delivered_at is null;
create index if not exists outbox_delivered_idx on outbox (delivered_at) where delivered_at is not null;

-- Role

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'automations_watcher') then
    create role automations_watcher nologin noinherit;
  end if;
  -- On Supabase, PostgREST switches to the role of the JWT through "authenticator".
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant automations_watcher to authenticator;
  end if;
end
$$;

grant usage on schema public to automations_watcher;

revoke all on families, children, accounts, activities, recipients, items, outbox
  from automations_watcher;

grant select on families, children, accounts, activities, recipients
  to automations_watcher;
grant select, insert on items to automations_watcher;
grant select, insert, delete on outbox to automations_watcher;
grant update (delivered_at) on outbox to automations_watcher;

-- Row level security

alter table families enable row level security;
alter table children enable row level security;
alter table accounts enable row level security;
alter table activities enable row level security;
alter table recipients enable row level security;
alter table items enable row level security;
alter table outbox enable row level security;

drop policy if exists watcher_read on families;
create policy watcher_read on families for select to automations_watcher using (true);

drop policy if exists watcher_read on children;
create policy watcher_read on children for select to automations_watcher using (true);

drop policy if exists watcher_read on accounts;
create policy watcher_read on accounts for select to automations_watcher using (true);

drop policy if exists watcher_read on activities;
create policy watcher_read on activities for select to automations_watcher using (true);

drop policy if exists watcher_read on recipients;
create policy watcher_read on recipients for select to automations_watcher using (true);

drop policy if exists watcher_read on items;
create policy watcher_read on items for select to automations_watcher using (true);

drop policy if exists watcher_insert on items;
create policy watcher_insert on items for insert to automations_watcher with check (true);

drop policy if exists watcher_read on outbox;
create policy watcher_read on outbox for select to automations_watcher using (true);

drop policy if exists watcher_insert on outbox;
create policy watcher_insert on outbox for insert to automations_watcher with check (true);

-- The column grant limits the update to delivered_at.
drop policy if exists watcher_update on outbox;
create policy watcher_update on outbox for update to automations_watcher
  using (true) with check (true);

-- Purge: only delivered rows older than 30 days.
drop policy if exists watcher_purge on outbox;
create policy watcher_purge on outbox for delete to automations_watcher
  using (delivered_at is not null and delivered_at < now() - interval '30 days');
