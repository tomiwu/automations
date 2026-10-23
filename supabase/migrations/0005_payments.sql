-- 0005_payments: fees and payments for the payments-watch package.
-- A fee is one recurring charge of one organizer for one child.
-- A payment is one fee for one month. Amounts are in grosze.
-- The watcher reads fees. It cannot change them: the owner uses the admin tool.
-- The watcher reads, inserts and updates payments. It cannot delete them.
-- The migration can run more than once.

create table if not exists fees (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  child_id uuid not null references children (id) on delete cascade,
  organizer text not null check (char_length(organizer) between 1 and 80),
  recipient_name text not null check (char_length(recipient_name) between 1 and 80),
  nip text check (nip ~ '^[0-9]{10}$'),
  account text not null check (account ~ '^[0-9]{26}$'),
  title text not null check (char_length(title) between 1 and 140),
  due_day integer not null check (due_day between 1 and 28),
  notify_day integer not null default 10 check (notify_day between 1 and 28),
  reminder_day integer not null default 14,
  amounts jsonb not null default '{}'::jsonb check (jsonb_typeof(amounts) = 'object'),
  source_url text,
  account_id uuid references accounts (id) on delete set null,
  enabled boolean not null default true,
  check (notify_day < due_day)
);

create index if not exists fees_family_idx on fees (family_id);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  fee_id uuid not null references fees (id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount integer not null check (amount > 0),
  amount_source text not null check (amount_source in ('page', 'config')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'skipped')),
  notified_at timestamptz,
  reminded_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz not null default now(),
  unique (fee_id, month)
);

create index if not exists payments_family_idx on payments (family_id);

revoke all on fees from automations_watcher;
grant select on fees to automations_watcher;
revoke all on payments from automations_watcher;
grant select, insert, update on payments to automations_watcher;

alter table fees enable row level security;
alter table payments enable row level security;

drop policy if exists watcher_read on fees;
create policy watcher_read on fees for select to automations_watcher using (true);

drop policy if exists watcher_read on payments;
create policy watcher_read on payments for select to automations_watcher using (true);

drop policy if exists watcher_insert on payments;
create policy watcher_insert on payments for insert to automations_watcher with check (true);

drop policy if exists watcher_update on payments;
create policy watcher_update on payments for update to automations_watcher
  using (true) with check (true);

-- anon and authenticated (the public Supabase roles) get nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on fees, payments from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on fees, payments from authenticated;
  end if;
end
$$;
