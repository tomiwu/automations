#!/usr/bin/env bash
# Usage:
#   scripts/ci-local-merge-gate.sh <full commit SHA of the PR head>
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
HEADER="$(sed '/^---$/,$d' "$RECORD")"
grep -qx "sha: $SHA" <<<"$HEADER" || refuse "the record of $SHA is for a different SHA"
grep -qx "result: GREEN" <<<"$HEADER" || refuse "the ci-local record for $SHA is not green"

echo "ci-local-merge-gate: ALLOWED green ci-local record for $SHA ($(grep -m1 '^recorded-at: ' <<<"$HEADER"))"
exit 0
