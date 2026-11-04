-- 0006_item_details: the content of each new Item. The rows are kept forever.
-- An updated Item adds a new row (another content_hash). The old row stays.
-- The watcher reads and inserts rows. It cannot update or delete them.
-- The migration can run more than once.

create table if not exists item_details (
  family_id uuid not null references families (id) on delete cascade,
  scope text not null,
  kind text not null check (kind in ('meeting', 'dayOff', 'trip', 'terminarz', 'announcement', 'message', 'grade')),
  child_id uuid not null,
  source_id text not null,
  content_hash text not null,
  date date,
  start_time time,
  end_time time,
  title text not null,
  text text not null,
  sender text,
  subject text,
  category text,
  source_updated_at timestamptz,
  first_seen timestamptz not null default now(),
  primary key (family_id, scope, source_id, content_hash)
);

create index if not exists item_details_child_date_idx on item_details (family_id, child_id, date);
create index if not exists item_details_first_seen_idx on item_details (family_id, first_seen);

revoke all on item_details from automations_watcher;
grant select, insert on item_details to automations_watcher;

alter table item_details enable row level security;

drop policy if exists watcher_read on item_details;
create policy watcher_read on item_details for select to automations_watcher using (true);

drop policy if exists watcher_insert on item_details;
create policy watcher_insert on item_details for insert to automations_watcher with check (true);

-- anon and authenticated (the public Supabase roles) get nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on item_details from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on item_details from authenticated;
  end if;
end
$$;
