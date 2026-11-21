#!/usr/bin/env bash
set -u

engine="${SQL_TEST_ENGINE:-}"
if [ -z "$engine" ]; then
  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1; then engine="$candidate"; break; fi
  done
fi
if [ -z "$engine" ] || ! command -v "$engine" >/dev/null 2>&1; then
  echo "test:sql:local: podman or docker is necessary, and neither is installed" >&2
  exit 2
fi

name="sql-tests-$$-$RANDOM"
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! "$engine" run -d --rm --name "$name" -e POSTGRES_PASSWORD=postgres -p 127.0.0.1::5432 docker.io/library/postgres:17 >/dev/null; then
  echo "test:sql:local: could not start postgres:17 with $engine" >&2
  exit 1
fi
port="$("$engine" port "$name" 5432/tcp | head -n 1 | sed 's/.*://')"

# -h 127.0.0.1: the image first starts a socket-only server for initdb; TCP is ready only on the final server.
ready=""
for _ in $(seq 1 60); do
  if "$engine" exec "$name" pg_isready -q -h 127.0.0.1 -U postgres; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "test:sql:local: postgres did not get ready in 60 s" >&2
  exit 1
fi

export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${port}/postgres"
${SQL_TEST_COMMAND:-npm test -w @automations/sql-tests}
