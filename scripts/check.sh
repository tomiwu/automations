#!/usr/bin/env bash
# npm run check: the checks of CI on this computer, in order. It stops at the first failure and names it.
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
if command -v gitleaks >/dev/null 2>&1; then
  step gitleaks gitleaks git --no-banner --redact --exit-code 1 .
else
  echo "check: WARNING gitleaks is not installed, the secret scan did not run" >&2
fi
echo "check: all steps passed"
