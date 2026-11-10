#!/usr/bin/env bash
# Usage: check-no-secrets.sh <dir>
# Exit 1 when a log file in <dir> matches a token pattern. Print only the file path and the count,
# never the matched value.
set -euo pipefail

DIR="${1:?Usage: check-no-secrets.sh <dir>}"
PATTERN='sk-ant-[A-Za-z0-9_-]+|gh[pos]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|[A-Za-z][A-Za-z0-9_]*_(TOKEN|KEY)=[^[:space:]]+'

found=0
while IFS= read -r -d '' file; do
  count="$(grep -E -o -- "$PATTERN" "$file" | grep -c -v -E -- '=\[REDACTED\]$' || true)"
  if [ "$count" -gt 0 ]; then
    echo "$file: $count match(es)"
    found=1
  fi
done < <(find "$DIR" -type f -name '*.log' -print0)

exit "$found"
