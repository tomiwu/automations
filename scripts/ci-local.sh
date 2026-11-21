#!/usr/bin/env bash
# Runs every job of .github/workflows on this machine, so a change can be proven green without GitHub runners.
#
# Usage:
#   scripts/ci-local.sh [--out FILE.md] [--host-node]   run all local steps (from the repository root of a checkout)
#   scripts/ci-local.sh --check-parity                  only check that every workflow step has a local step
#
# Jobs and their local steps:
#   ci.yml build       npm ci, npm run typecheck, npm test, npm run crap (Node 22, like actions/setup-node)
#   ci.yml sql         npm test -w @automations/sql-tests against a throwaway postgres:17 container (podman)
#   ci.yml secrets     gitleaks git --redact --verbose --exit-code 1 . ; deny-list check (DENYLIST or DENYLIST_FILE)
#   privacy            gitleaks on the full history (it contains the tree and the diff of the branch), then
#                      tools/privacy-check: hashed private words and heuristics on the tracked files and on the
#                      lines that the branch adds against origin/main. It prints places and categories only.
#   migrate.yml        tools/migrate/apply.sh on a scratch database, two times (the second run applies nothing)
#   deploy-kody.yml    tools/kody-stage/stage.mjs for each package of the matrix (the Kody API steps are SKIP)
#   sandbox-image.yml  podman build of the sandbox Containerfile and the smoke test, only when the branch changes a
#                      file of its `paths` filter (like the pull_request trigger), or with CI_LOCAL_SANDBOX_IMAGE=1
#
# Environment:
#   CI_LOCAL_MIN_FREE_GB  stop when less disk is free (default 6)
#   CI_LOCAL_WORKFLOWS    workflow directory (default .github/workflows; tests change it)
#   CI_LOCAL_NODE         Node major version (default 22). --host-node uses the node in PATH.
#   CI_LOCAL_PG_IMAGE     Postgres image (default docker.io/library/postgres:17)
#   DENYLIST / DENYLIST_FILE  personal strings, one for each line. Values are never printed.
#   PRIVACY_PEPPER        the pepper of the private word hashes, when privacy/denylist.hashes.json uses one
#   GITLEAKS              gitleaks binary (default: gitleaks in PATH, else a cached v8.28.0)
# It never prints a secret value. It calls no Kody, Supabase or GitHub API.
set -uo pipefail

WORKFLOWS="${CI_LOCAL_WORKFLOWS:-.github/workflows}"

# Every step name of the workflows, with what this script does for it. A workflow step that is not here fails the
# parity check, so a new CI step cannot be forgotten.
STEP_MAP='
ci.yml|Install the dependencies|npm-ci
ci.yml|Check the types|typecheck
ci.yml|Run the tests|test
ci.yml|Check the CRAP score (fails if a function has CRAP >= 6)|crap
ci.yml|Run the SQL tests against Postgres|sql
ci.yml|Scan the full history with gitleaks|gitleaks
ci.yml|Check for personal strings (deny-list from the DENYLIST secret)|deny
ci.yml|Run the privacy check (hashed private words and heuristics)|privacy
migrate.yml|Install psql|migrate
migrate.yml|Apply the migrations|migrate
migrate.yml|Verify the attachments bucket (read only)|migrate
deploy-kody.yml|Decide the mode|skip: GitHub vars only
deploy-kody.yml|Stage the package|kody-stage
deploy-kody.yml|Check that the token is set|skip: needs the Kody secret
deploy-kody.yml|Run the Kody publish checks (saves nothing)|skip: Kody API call
deploy-kody.yml|Push the staged tree to the Kody package repo|skip: deploy
deploy-kody.yml|Publish on Kody|skip: deploy
deploy-kody.yml|Report a package that was not deployed|skip: deploy
sandbox-image.yml|Build the image (the last RUN is doctor.sh container)|sandbox-image
sandbox-image.yml|Smoke test as the agent user|sandbox-image
'

# Prints "file|step name" for each named step under `jobs:` of each workflow file.
workflow_steps() {
  local file
  for file in "$WORKFLOWS"/*.yml; do
    [ -e "$file" ] || continue
    awk -v f="$(basename "$file")" '/^jobs:/{j=1} j && /^ +- name:/{sub(/^ +- name: */,""); gsub(/^["\x27]|["\x27]$/,""); print f "|" $0}' "$file"
  done
}

# The packages of the deploy matrix (`package: [a, b]`).
matrix_packages() {
  [ -e "$WORKFLOWS/deploy-kody.yml" ] || return 0
  sed -n 's/^ *package: *\[\(.*\)\]/\1/p' "$WORKFLOWS/deploy-kody.yml" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sed '/^$/d'
}

check_parity() {
  local missing=0 line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! grep -qF -- "$line|" <<<"$STEP_MAP"; then echo "PARITY FAIL: workflow step has no local step: $line"; missing=1; fi
  done < <(workflow_steps)
  [ "$missing" = 0 ] && echo "parity ok: $(workflow_steps | wc -l) workflow steps mapped"
  return "$missing"
}

if [ "${1:-}" = "--check-parity" ]; then check_parity; exit $?; fi

OUT=""; HOST_NODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --host-node) HOST_NODE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2
LOG="$(mktemp -d)"; PG=""; STAGE="$(mktemp -d)"
cleanup() { [ -n "$PG" ] && podman rm -f "$PG" >/dev/null 2>&1; rm -rf "$LOG" "$STAGE"; }
trap cleanup EXIT

free_gb() { df -Pk "$ROOT" | awk 'NR==2 {print int($4/1048576)}'; }
MIN_FREE="${CI_LOCAL_MIN_FREE_GB:-6}"
if [ "$(free_gb)" -lt "$MIN_FREE" ]; then echo "DISK FAIL: $(free_gb) GB free, need $MIN_FREE GB. Nothing was run."; exit 3; fi

# Node of the CI version: a cached official tarball, checked with its SHASUMS256.
use_node() {
  local want="${CI_LOCAL_NODE:-22}" cache="${XDG_CACHE_HOME:-$HOME/.cache}/ci-local" base sums file dir
  [ "$HOST_NODE" = 1 ] && return 0
  [ "$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')" = "$want" ] && return 0
  dir="$(ls -d "$cache"/node-v"$want".*-linux-x64 2>/dev/null | sort -V | tail -1)"
  if [ -z "$dir" ]; then
    mkdir -p "$cache"; base="https://nodejs.org/dist/latest-v$want.x"
    sums="$(curl -fsSL "$base/SHASUMS256.txt")" || return 1
    file="$(printf '%s\n' "$sums" | awk '/linux-x64.tar.xz$/ {print $2}')"
    curl -fsSL "$base/$file" -o "$cache/$file" || return 1
    (cd "$cache" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c --quiet -) || { rm -f "$cache/$file"; return 1; }
    tar -xJf "$cache/$file" -C "$cache" && rm -f "$cache/$file"
    dir="$cache/${file%.tar.xz}"
  fi
  export PATH="$dir/bin:$PATH"
}

ROWS=(); FAILED=0
step() { # step <name> <key> <command...>
  local name="$1" key="$2" t0 rc res; shift 2
  if [ "$(free_gb)" -lt "$MIN_FREE" ]; then ROWS+=("| $name | FAIL | disk: $(free_gb) GB free, need $MIN_FREE GB | 0s |"); FAILED=1; return 0; fi
  t0=$(date +%s); "$@" >"$LOG/$key.log" 2>&1; rc=$?
  res=PASS; [ "$rc" -ne 0 ] && { res="FAIL (exit $rc)"; FAILED=1; }
  ROWS+=("| $name | $res | $(detail "$key" "$rc") | $(( $(date +%s) - t0 ))s |")
}
skip() { ROWS+=("| $1 | SKIP | $2 | 0s |"); }

clean() { sed 's/\x1b\[[0-9;]*m//g' "$LOG/$1.log"; }
sum_of() { clean "$1" | grep -E "^ +Tests " | grep -oE "[0-9]+ $2" | awk '{s+=$1} END {print s+0}'; }
detail() {
  case "$1" in
    parity) tail -1 "$LOG/parity.log" ;;
    node) node -v ;;
    test) echo "$(sum_of test passed) passed, $(sum_of test failed) failed, in $(clean test | grep -E '^ +Test Files' | grep -oE '[0-9]+ passed' | awk '{s+=$1} END {print s+0}') test files" ;;
    sql) echo "$(sum_of sql passed) passed, $(sum_of sql skipped) skipped" ;;
    crap) clean crap | grep -h "CI failed:" | paste -sd ';' | sed 's/^$/every function has CRAP < 6/' ;;
    gitleaks) clean gitleaks | grep -oE "[0-9]+ commits scanned|no leaks found|leaks found: [0-9]+" | paste -sd ',' ;;
    deny|privacy|migrate|kody-stage|sandbox-image) tail -1 "$LOG/$1.log" ;;
    *) [ "$2" -ne 0 ] && tail -1 "$LOG/$1.log" | cut -c1-120 ;;
  esac
}

start_pg() {
  local port i
  PG="ci-local-pg-$$"; port=$(( 20000 + RANDOM % 20000 ))
  podman run -d --rm --name "$PG" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:$port:5432" "${CI_LOCAL_PG_IMAGE:-docker.io/library/postgres:17}" >/dev/null || return 1
  for i in $(seq 1 60); do podman exec "$PG" pg_isready -q -U postgres && break; sleep 1; done
  sleep 2; echo "$port" > "$LOG/pg.port"
}
sql_tests() {
  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:$(cat "$LOG/pg.port")/postgres" npm test -w @automations/sql-tests
}
migrate() {
  local url="postgresql://postgres:postgres@127.0.0.1:$(cat "$LOG/pg.port")/migrate_check" first second
  podman exec "$PG" psql -q -U postgres -c "create database migrate_check" >/dev/null || return 1
  first="$(SUPABASE_DB_URL="$url" bash tools/migrate/apply.sh supabase/migrations 2>&1)" || { printf '%s\n' "$first"; return 1; }
  second="$(SUPABASE_DB_URL="$url" bash tools/migrate/apply.sh supabase/migrations 2>&1)" || { printf '%s\n' "$second"; return 1; }
  printf '%s\n' "$first" "$second"
  echo "first run: $(printf '%s' "$first" | tail -1); second run: $(printf '%s' "$second" | tail -1)"
}
gitleaks_scan() {
  local bin="${GITLEAKS:-}" cache="${XDG_CACHE_HOME:-$HOME/.cache}/ci-local"
  [ -z "$bin" ] && command -v gitleaks >/dev/null && bin="$(command -v gitleaks)"
  if [ -z "$bin" ]; then
    mkdir -p "$cache"; bin="$cache/gitleaks"
    [ -x "$bin" ] || curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz | tar -xz -C "$cache" gitleaks || return 1
  fi
  "$bin" git --redact --verbose --exit-code 1 .
}
deny() {
  local list; list="$(mktemp)"
  if [ -n "${DENYLIST:-}" ]; then printf '%s\n' "$DENYLIST" > "$list"; elif [ -n "${DENYLIST_FILE:-}" ]; then cat "$DENYLIST_FILE" > "$list"; fi
  sed -i '/^[[:space:]]*$/d' "$list"
  if [ ! -s "$list" ]; then rm -f "$list"; echo "SKIP: DENYLIST and DENYLIST_FILE are empty (CI skips too)"; return 0; fi
  if git grep -n -i -F -f "$list" -- . ':!package-lock.json' | cut -d: -f1,2 > "$LOG/deny.hits"; then
    rm -f "$list"; cat "$LOG/deny.hits"; echo "personal strings found in $(wc -l < "$LOG/deny.hits") lines (values hidden)"; return 1
  fi
  if git log --all -p --format= | grep -q -i -F -f "$list"; then rm -f "$list"; echo "personal strings found in the git history (values hidden)"; return 1; fi
  rm -f "$list"; echo "no personal strings found ($(git rev-list --all | wc -l) commits, values hidden)"
}
privacy() {
  local base; base="$(git merge-base HEAD origin/main 2>/dev/null)"
  npx --no-install tsx tools/privacy-check/src/cli.ts --tree ${base:+--diff "$base"}
}
kody_stage() {
  local pkg n=0
  for pkg in $(matrix_packages); do node tools/kody-stage/stage.mjs "packages/$pkg" "$STAGE/$pkg" || { echo "stage failed: $pkg"; return 1; }; n=$((n + 1)); done
  echo "staged $n packages: $(matrix_packages | paste -sd ' ')"
}

# The `paths` of the pull_request trigger of sandbox-image.yml.
sandbox_paths() {
  [ -e "$WORKFLOWS/sandbox-image.yml" ] || return 0
  awk '/^  pull_request:/{p=1; next} p && /^  [a-z_]+:/{p=0} p && /^ +- /{sub(/^ +- */,""); print}' "$WORKFLOWS/sandbox-image.yml"
}
sandbox_image() {
  local changed base
  base="$(git merge-base HEAD origin/main 2>/dev/null)"
  changed="$( [ -n "$base" ] && git diff --name-only "$base" HEAD -- $(sandbox_paths) )"
  if [ "${CI_LOCAL_SANDBOX_IMAGE:-}" != 1 ] && [ -z "$changed" ]; then echo "SKIP: no file of the sandbox-image.yml paths changed"; return 0; fi
  podman build -q -f scripts/sandcastle-loop/Containerfile \
    --build-arg AGENT_UID="$(id -u)" --build-arg AGENT_GID="$(id -g)" \
    --build-arg LOOP_MODELS=claude:default,cursor:default \
    -t sandcastle-ci:check scripts/sandcastle-loop || return 1
  podman run --rm --entrypoint sh sandcastle-ci:check -c \
    'id -un && git --version && gh --version | head -1 && command -v claude && command -v agent && test "$(stat -c %a /tmp)" = 1777' || return 1
  echo "built sandcastle-ci:check and the smoke test passed (changed: $(printf '%s' "$changed" | paste -sd ' '))"
}

step "workflow parity" parity check_parity
step "node ${CI_LOCAL_NODE:-22}" node use_node
step "npm ci" npm-ci npm ci --no-audit --no-fund
step "npm run typecheck" typecheck npm run typecheck
step "npm test" test npm test
step "npm run crap" crap npm run crap
step "postgres:17 (podman)" pg start_pg
step "npm test -w @automations/sql-tests" sql sql_tests
step "migrate.yml: apply.sh x2 (scratch db)" migrate migrate
step "gitleaks (full history)" gitleaks gitleaks_scan
step "deny-list" deny deny
step "privacy: hashed private words + heuristics (tree, diff)" privacy privacy
step "deploy-kody.yml: kody-stage" kody-stage kody_stage
step "sandbox-image.yml: build + smoke" sandbox-image sandbox_image
skip "deploy-kody.yml: Kody check, push, publish" "needs the Kody API and the deploy secret (not run locally)"
if command -v actionlint >/dev/null; then step "actionlint (extra)" actionlint actionlint "$WORKFLOWS"/*.yml; fi

REPORT="$(mktemp)"
{
  echo "ci-local.sh on \`$(git rev-parse HEAD)\` ($(git rev-parse --abbrev-ref HEAD)), $(TZ=Europe/Warsaw date '+%Y-%m-%d %H:%M %Z') Europe/Warsaw, result: $([ "$FAILED" = 0 ] && echo GREEN || echo RED)"
  echo
  echo "| Step | Result | Details | Time |"
  echo "|---|---|---|---|"
  printf '%s\n' "${ROWS[@]}"
} > "$REPORT"
cat "$REPORT"
[ -n "$OUT" ] && cp "$REPORT" "$OUT"
rm -f "$REPORT"
exit "$FAILED"
