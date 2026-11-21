#!/usr/bin/env bash
# Usage: tools/migrate/apply.sh [migrations-dir]
# The connection string comes from SUPABASE_DB_URL. The script never prints it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dir="${1:-$root/supabase/migrations}"

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL is empty. Skip the migrations."
  exit 0
fi

run() {
  psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$SUPABASE_DB_URL" "$@"
}

run -c "
create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz default now()
);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public;
do \$\$
begin
  if exists (select 1 from pg_roles where rolname = 'automations_watcher') then
    revoke all on public.schema_migrations from automations_watcher;
  end if;
end
\$\$;"

applied=0
skipped=0
shopt -s nullglob
for file in "$dir"/*.sql; do
  name="$(basename "$file")"
  escaped="${name//\'/\'\'}"
  done_count="$(run -c "select count(*) from public.schema_migrations where name = '$escaped'")"
  if [ "$done_count" != "0" ]; then
    echo "skip $name"
    skipped=$((skipped + 1))
    continue
  fi
  echo "apply $name"
  run --single-transaction -f "$file" -c "insert into public.schema_migrations (name) values ('$escaped')"
  applied=$((applied + 1))
done

echo "done: applied $applied, skipped $skipped"
