#!/usr/bin/env bash
# Merge gate: allows a merge only when scripts/ci-local-record.sh wrote a GREEN record for the exact PR head SHA.
#
# Usage:
#   scripts/ci-local-merge-gate.sh <full commit SHA of the PR head>
#
#   - The merge path of the Sandcastle loop must call this script immediately before the merge command. It is not
#     a Git hook, so `git commit --no-verify` and `git push --no-verify` cannot skip it.
#   - It reads <common git dir>/ci-local-records/<SHA>. The header of the record must have the same SHA and the
#     line `result: GREEN`. A record of a different SHA is not valid. After a sync with origin/main the head SHA
#     is new: run scripts/ci-local-record.sh on the new SHA, then call the gate again.
#   - A stamp file of the pre-push hook (ci-local-green) is not a record. The gate does not read it.
#   - The gate only reads the record. It runs no check, merges nothing and uses no network.
# Exit code: 0 the merge is allowed, 1 the merge is refused, 2 wrong arguments. It prints the header of the record,
# never the log.
set -u
if [ $# -ne 1 ] || ! [[ "$1" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "usage: scripts/ci-local-merge-gate.sh <full commit SHA of the PR head>" >&2
  exit 2
fi
SHA="$1"
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" || exit 2
RECORD="$COMMON/ci-local-records/$SHA"

refuse() {
  echo "ci-local-merge-gate: REFUSED $1. Do not merge. Run scripts/ci-local-record.sh $SHA, then call the gate again."
  exit 1
}

[ -f "$RECORD" ] || refuse "no ci-local record for $SHA"
# The header is all lines before the first `---` line. The log after it cannot change the result.
HEADER="$(sed '/^---$/,$d' "$RECORD")"
grep -qx "sha: $SHA" <<<"$HEADER" || refuse "the record of $SHA is for a different SHA"
grep -qx "result: GREEN" <<<"$HEADER" || refuse "the ci-local record for $SHA is not green"

echo "ci-local-merge-gate: ALLOWED green ci-local record for $SHA ($(grep -m1 '^recorded-at: ' <<<"$HEADER"))"
exit 0
