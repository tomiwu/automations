#!/usr/bin/env bash
# Recorder of the merge gate: runs the full scripts/ci-local.sh on one commit and records the result for its SHA.
#
# Usage:
#   scripts/ci-local-record.sh [COMMIT]     COMMIT is a SHA or a ref (default HEAD)
#
#   - ci-local runs in a temporary checkout of the commit (a detached worktree in TMPDIR). It checks the commit,
#     not the files of the working directory. The checkout runs its own scripts/ci-local.sh.
#   - Each run writes one record file: <common git dir>/ci-local-records/<full SHA>. All worktrees of the clone
#     use this directory. A new run for the same SHA replaces the record.
#   - The record has a header (sha, result, exit-code, recorded-at), a line `---`, then the full output of ci-local.
#     The result is GREEN only when ci-local exits with 0. All other runs write a RED record.
#   - scripts/ci-local-merge-gate.sh reads the record. The merge path of the loop must call the gate before a merge.
# Exit code: 0 for a GREEN record, 1 for a RED record, 2 when there is no record (bad argument or no checkout).
# The record contains only the output of ci-local. ci-local never prints a secret value.
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

# Runs the ci-local of the commit in the temporary checkout. The git variables of a caller hook must not go to it.
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

# Writes the record. The record goes to a temporary file first, so the gate never reads a record that is not complete.
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
  # A record that is not complete must not stay. An old record of the SHA is not valid after this run.
  rm -f "$tmp" "$RECORDS/$SHA"
  return 1
}

mkdir -p "$RECORDS" || exit 2
write_record || exit 2

echo "ci-local-record: $RESULT record for $SHA in $RECORDS/$SHA" >&2
[ "$RESULT" = GREEN ]
