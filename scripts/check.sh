#!/usr/bin/env bash
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

step() {
  local name="$1"; shift
  echo "check: $name"
  if ! "$@"; then
    echo "check: FAILED at step \"$name\"" >&2
    exit 1
  fi
}

step typecheck npm run typecheck
step test npm test
step crap npm run crap
step privacy npm run --silent privacy
if command -v gitleaks >/dev/null 2>&1; then
  step gitleaks gitleaks git --no-banner --redact --exit-code 1 .
else
  echo "check: WARNING gitleaks is not installed, the secret scan did not run" >&2
fi
echo "check: all steps passed"
