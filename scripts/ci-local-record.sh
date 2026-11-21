#!/usr/bin/env bash
# Usage:
#   scripts/ci-local-record.sh [COMMIT]     COMMIT is a SHA or a ref (default HEAD)
# Exit code: 0 for a GREEN record, 1 for a RED record, 2 when there is no record (bad argument or no checkout).
set -u
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" || exit 2
RECORDS="$COMMON/ci-local-records"
WORK=""

cleanup() {
  [ -n "$WORK" ] || return 0
  git worktree remove --force "$WORK/tree" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ $# -gt 1 ]; then echo "usage: scripts/ci-local-record.sh [COMMIT]" >&2; exit 2; fi
REF="${1:-HEAD}"
if ! SHA="$(git rev-parse --verify --quiet "$REF^{commit}")"; then
  echo "ci-local-record: $REF is not a commit. No record was written." >&2
  exit 2
fi

run_ci_local() {
  if [ ! -f "$WORK/tree/scripts/ci-local.sh" ]; then
    echo "ci-local-record: the commit $SHA has no scripts/ci-local.sh"
    return 1
  fi
  (
    unset $(git rev-parse --local-env-vars)
    cd "$WORK/tree" && bash scripts/ci-local.sh
  ) </dev/null
}

WORK="$(mktemp -d)" || exit 2
if ! git worktree add --quiet --detach "$WORK/tree" "$SHA"; then
  echo "ci-local-record: cannot make a checkout of $SHA. No record was written." >&2
  exit 2
fi

echo "ci-local-record: the full scripts/ci-local.sh runs on $SHA. This takes minutes." >&2
run_ci_local > "$WORK/log" 2>&1
RC=$?
cat "$WORK/log"
RESULT=RED
[ "$RC" -eq 0 ] && RESULT=GREEN

write_record() {
  local tmp="$RECORDS/.$SHA.$$"
  {
    echo "sha: $SHA"
    echo "result: $RESULT"
    echo "exit-code: $RC"
    echo "recorded-at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "---"
    cat "$WORK/log"
  } > "$tmp" && mv -f "$tmp" "$RECORDS/$SHA" && return 0
  rm -f "$tmp" "$RECORDS/$SHA"
  return 1
}

mkdir -p "$RECORDS" || exit 2
write_record || exit 2

echo "ci-local-record: $RESULT record for $SHA in $RECORDS/$SHA" >&2
[ "$RESULT" = GREEN ]
