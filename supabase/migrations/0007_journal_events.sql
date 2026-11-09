-- 0007_journal_events: the append-only event journal (ADR 0006).
-- Each stream has numbered events (seq 1, 2, 3 ...). A row is never changed.
-- The watcher reads and inserts rows. A trigger rejects update, delete and
-- truncate for every role, also for the owner.
-- The migration can run more than once.

create table if not exists journal_events (
  family_id uuid not null references families (id) on delete restrict,
  child_id uuid not null,
  stream text not null,
  seq integer not null check (seq >= 1),
  kind text not null check (kind in ('lesson', 'homework', 'session', 'check',
    'meeting', 'dayOff', 'trip', 'terminarz', 'announcement', 'message', 'grade')),
  day date,
  event_type text not null,
  payload jsonb not null,
  content_hash text not null,
  recorded_at timestamptz not null default now(),
  source text not null,
  primary key (family_id, stream, seq)
);

create index if not exists journal_events_child_kind_day_idx on journal_events (family_id, child_id, kind, day);
create index if not exists journal_events_recorded_at_idx on journal_events (family_id, recorded_at);

create or replace function journal_events_reject_change() returns trigger
language plpgsql
as $$
begin
  raise exception 'journal_events is append-only';
end
$$;

revoke all on function journal_events_reject_change() from public;

drop trigger if exists journal_events_no_change on journal_events;
create trigger journal_events_no_change
  before update or delete on journal_events
  for each row execute function journal_events_reject_change();

drop trigger if exists journal_events_no_truncate on journal_events;
create trigger journal_events_no_truncate
  before truncate on journal_events
  for each statement execute function journal_events_reject_change();

-- The newest event of each stream.
create or replace view journal_heads with (security_invoker = true) as
  select distinct on (family_id, stream) *
  from journal_events
  order by family_id, stream, seq desc;

revoke all on journal_events, journal_heads from automations_watcher;
grant select, insert on journal_events to automations_watcher;
grant select on journal_heads to automations_watcher;

alter table journal_events enable row level security;

drop policy if exists watcher_read on journal_events;
create policy watcher_read on journal_events for select to automations_watcher using (true);

drop policy if exists watcher_insert on journal_events;
create policy watcher_insert on journal_events for insert to automations_watcher with check (true);

-- anon and authenticated (the public Supabase roles) get nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on journal_events, journal_heads from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on journal_events, journal_heads from authenticated;
  end if;
end
$$;
