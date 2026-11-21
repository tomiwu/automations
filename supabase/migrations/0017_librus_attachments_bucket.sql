-- 0017_librus_attachments_bucket: private bucket for Librus message files (#263).
-- Objects live at <family_id>/<message_id>/<attachment_id>. The watcher role
-- can read and insert only under its family prefix from the JWT claim family_id.
-- The migration can run more than once.

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id bigserial primary key,
  bucket_id text not null references storage.buckets (id),
  name text not null
);

create or replace function storage.foldername(path text)
returns text[]
language sql
immutable
as $$
  select string_to_array(path, '/');
$$;

revoke all on storage.buckets, storage.objects from public;
grant usage on schema storage to automations_watcher;
grant select on storage.buckets to automations_watcher;
grant select, insert on storage.objects to automations_watcher;

alter table storage.objects enable row level security;

create schema if not exists auth;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), '{}')::jsonb;
$$;

revoke all on function auth.jwt() from public;
grant execute on function auth.jwt() to automations_watcher;

insert into storage.buckets (id, name, public)
values ('librus-attachments', 'librus-attachments', false)
on conflict (id) do update set public = false;

drop policy if exists watcher_attachment_read on storage.objects;
create policy watcher_attachment_read on storage.objects
  for select to automations_watcher
  using (
    bucket_id = 'librus-attachments'
    and (storage.foldername(name))[1] = auth.jwt() ->> 'family_id'
  );

drop policy if exists watcher_attachment_insert on storage.objects;
create policy watcher_attachment_insert on storage.objects
  for insert to automations_watcher
  with check (
    bucket_id = 'librus-attachments'
    and (storage.foldername(name))[1] = auth.jwt() ->> 'family_id'
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on storage.objects from anon;
  end if;
end
$$;