-- 0017_librus_attachments_bucket: private Storage bucket for Librus message files (#263).
-- Objects live at <family_id>/<message_id>/<attachment_id>. One Family per project: the watcher role
-- (automations_watcher, the role claim of the watcher key) may read and add objects in the whole bucket.
-- No update and no delete: stored files are kept (owner decision 2026-11-21).
-- Platform objects (the storage and auth schemas, their tables and functions) are never created or replaced here. Without a `storage` schema
-- (plain Postgres, the migrate.yml scratch database) the migration does nothing.
-- The migration can run more than once.

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice '0017: no storage schema, skipped';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('librus-attachments', 'librus-attachments', false)
  on conflict (id) do update set public = false;

  execute 'grant usage on schema storage to automations_watcher';
  execute 'grant select on storage.buckets to automations_watcher';
  execute 'grant select, insert on storage.objects to automations_watcher';

  execute 'drop policy if exists watcher_attachment_read on storage.objects';
  execute $p$create policy watcher_attachment_read on storage.objects
    for select to automations_watcher
    using (bucket_id = 'librus-attachments')$p$;

  execute 'drop policy if exists watcher_attachment_insert on storage.objects';
  execute $p$create policy watcher_attachment_insert on storage.objects
    for insert to automations_watcher
    with check (bucket_id = 'librus-attachments')$p$;
end
$$;
