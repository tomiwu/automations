-- 0015_outbox_document: text and document Outbox entries (#263).
-- The migration can run more than once.

alter table outbox add column if not exists kind text not null default 'text'
  check (kind in ('text', 'document'));
alter table outbox add column if not exists storage_path text;
alter table outbox add column if not exists file_name text;