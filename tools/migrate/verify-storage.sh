#!/usr/bin/env bash
# Read-only check of the private attachments bucket (0017_librus_attachments_bucket.sql).
# Prints only the bucket id, its public flag and the names, commands and roles of the watcher policies.
# Usage: SUPABASE_DB_URL=... tools/migrate/verify-storage.sh
# The connection string comes from SUPABASE_DB_URL. The script never prints it. Nothing is written.
set -euo pipefail

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL is empty. Nothing to check."
  exit 0
fi

run() {
  PGOPTIONS="-c default_transaction_read_only=on" psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 -d "$SUPABASE_DB_URL" -c "$1"
}

if [ "$(run "select count(*) from pg_namespace where nspname = 'storage'")" = "0" ]; then
  echo "storage schema: missing (0017 did nothing)"
  exit 0
fi

bucket="$(run "select id || ' public=' || public from storage.buckets where id = 'librus-attachments'")"
echo "bucket: ${bucket:-missing}"
policies="$(run "select policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname like 'watcher_attachment%' order by policyname")"
echo "policies:"
printf '%s\n' "${policies:-none}"

ok=1
[ "$bucket" = "librus-attachments public=false" ] || ok=0
[ "$policies" = "$(printf '%s\n%s' 'watcher_attachment_insert INSERT automations_watcher' 'watcher_attachment_read SELECT automations_watcher')" ] || ok=0
if [ "$ok" = 1 ]; then echo "result: OK (private bucket, watcher select and insert only)"; else echo "result: NOT OK"; exit 1; fi
