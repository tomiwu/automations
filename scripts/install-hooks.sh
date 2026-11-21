#!/usr/bin/env bash
#   GITLEAKS  gitleaks binary (default: gitleaks in PATH, else the cached download)
set -euo pipefail
GITLEAKS_VERSION=8.28.0
SHA256_x64=a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb
SHA256_arm64=eff65261156100e5d94a6b3dec313d532fddfe19ae1590bf7a2b4f2699128356

fail() { echo "install-hooks: FAILED $1" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "this directory is not in a git checkout"
cd "$ROOT"
for HOOK in pre-commit pre-push; do
  [ -x "scripts/hooks/$HOOK" ] || fail "this checkout has no scripts/hooks/$HOOK (a program file)"
done

git config --file "$(git rev-parse --path-format=absolute --git-common-dir)/config" core.hooksPath scripts/hooks
[ "$(git config --get core.hooksPath)" = scripts/hooks ] || fail "another git config sets core.hooksPath to $(git config --get core.hooksPath)"
echo "install-hooks: core.hooksPath is scripts/hooks (common config, all worktrees)"

download_gitleaks() {
  local dir="$1" arch sum file
  local no_download="gitleaks is not installed. Install gitleaks $GITLEAKS_VERSION and run this script again"
  [ "$(uname -s)" = Linux ] || fail "$no_download"
  case "$(uname -m)" in
    x86_64) arch=x64; sum="$SHA256_x64" ;;
    aarch64|arm64) arch=arm64; sum="$SHA256_arm64" ;;
    *) fail "$no_download" ;;
  esac
  file="gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"
  mkdir -p "$dir"
  curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/$file" -o "$dir/$file" || fail "the download of $file"
  if ! echo "$sum  $dir/$file" | sha256sum -c --quiet -; then rm -f "$dir/$file"; fail "the checksum of $file"; fi
  tar -xzf "$dir/$file" -C "$dir" gitleaks
  rm -f "$dir/$file"
}

CACHE="${XDG_CACHE_HOME:-${HOME:-}/.cache}/ci-local"
if [ -n "${GITLEAKS:-}" ]; then
  [ -x "$GITLEAKS" ] || fail "GITLEAKS is not a program: $GITLEAKS"
  BIN="$GITLEAKS"
elif command -v gitleaks >/dev/null; then
  BIN="$(command -v gitleaks)"
else
  BIN="$CACHE/gitleaks"
  [ -x "$BIN" ] || download_gitleaks "$CACHE"
fi
echo "install-hooks: gitleaks is $BIN"
