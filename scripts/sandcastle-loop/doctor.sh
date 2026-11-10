#!/usr/bin/env bash
# Preflight doctor of the shared Sandcastle loop. No agent starts when a check fails.
#
# Usage:
#   doctor.sh            host checks, then the container checks in a throwaway container of LOOP_IMAGE
#   doctor.sh host       host checks only
#   doctor.sh container  container checks only (run as the agent user inside the image)
#
# On a failure it prints one line `DOCTOR FAIL: <check> -> fix: <command>` and exits 1.
# It never prints a token: the output of `gh auth status` is not shown.
#
# Environment:
#   LOOP_REPO          owner/name for the gh check (optional)
#   LOOP_IMAGE         sandbox image (optional; without it the container part is skipped)
#   LOOP_MODELS        provider:model list; the agent CLI of each provider must exist in the container
#   LOOP_GH            gh command or wrapper (default: gh)
#   LOOP_STORAGE_CONF  podman storage config (exported as CONTAINERS_STORAGE_CONF)
#   LOOP_DOCTOR_EXTRA  extra shell command that runs in the container checks (for example toolchain checks)
#   LOOP_AGENT_USER    user of the throwaway container (default: agent)
#   DOCTOR_TMP         directory of the /tmp checks (default: /tmp; tests change it)
set -uo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/$(basename "${BASH_SOURCE[0]:-$0}")"
ROOT="${LOOP_ROOT:-$(cd "$(dirname "$SCRIPT_PATH")/../.." 2>/dev/null && pwd)}"
GH="${LOOP_GH:-gh}"
TMP_DIR="${DOCTOR_TMP:-/tmp}"
if [ -n "${LOOP_STORAGE_CONF:-}" ]; then export CONTAINERS_STORAGE_CONF="$LOOP_STORAGE_CONF"; fi

fail() {
  echo "DOCTOR FAIL: $1 -> fix: $2"
  exit 1
}

ok() { echo "doctor ok: $1"; }

# The CLI of each provider in LOOP_MODELS. claude -> claude, cursor -> agent (Cursor Agent CLI).
agent_clis() {
  local models="${LOOP_MODELS:-claude:default}" entry provider
  local IFS=','
  for entry in $models; do
    provider="${entry%%:*}"
    case "$provider" in
      claude) echo claude ;;
      cursor) echo agent ;;
    esac
  done | sort -u
}

host_checks() {
  [ -d "$ROOT/node_modules/@ai-hero/sandcastle" ] || fail "host node_modules/@ai-hero/sandcastle" "cd $ROOT && npm ci"
  ok "node_modules/@ai-hero/sandcastle"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-loop}"
  podman info >/dev/null 2>&1 || fail "podman info (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR)" "mkdir -p -m 700 $XDG_RUNTIME_DIR && podman system migrate"
  ok "podman info"
  if [ -n "${LOOP_IMAGE:-}" ]; then
    podman image exists "$LOOP_IMAGE" || fail "podman image exists $LOOP_IMAGE" "scripts/sandcastle-loop/build-image.sh"
    ok "image $LOOP_IMAGE"
  fi
  env -u GH_TOKEN -u GITHUB_TOKEN $GH auth status >/dev/null 2>&1 || fail "gh auth status" "$GH auth login"
  if [ -n "${LOOP_REPO:-}" ]; then
    env -u GH_TOKEN -u GITHUB_TOKEN $GH repo view "$LOOP_REPO" --json name >/dev/null 2>&1 \
      || fail "gh repo view $LOOP_REPO" "$GH auth login (an account with access to $LOOP_REPO)"
  fi
  ok "gh auth"
}

container_checks() {
  local probe="$HOME/.doctor-write-test" cli
  (touch "$probe" && rm -f "$probe") 2>/dev/null || fail "\$HOME ($HOME) writable" "chown -R \$AGENT_UID:\$AGENT_GID /home/agent in the Containerfile"
  [ "$(stat -c %a "$TMP_DIR" 2>/dev/null)" = "1777" ] || fail "$TMP_DIR mode 1777" "install -d -m 1777 /tmp in the Containerfile"
  mkdir -p "$TMP_DIR/claude-$(id -u)" 2>/dev/null || fail "mkdir $TMP_DIR/claude-$(id -u)" "install -d -m 1777 /tmp in the Containerfile"
  for cli in git node gh; do
    "$cli" --version >/dev/null 2>&1 || fail "$cli --version" "install $cli in the Containerfile"
  done
  for cli in $(agent_clis); do
    "$cli" --version >/dev/null 2>&1 || fail "agent CLI $cli --version" "install the $cli CLI in the Containerfile"
  done
  if [ -n "${LOOP_DOCTOR_EXTRA:-}" ]; then
    bash -c "$LOOP_DOCTOR_EXTRA" >/dev/null 2>&1 || fail "LOOP_DOCTOR_EXTRA ($LOOP_DOCTOR_EXTRA)" "fix the repo toolchain in the Containerfile"
  fi
  ok "container"
}

# Runs the container part of this script in a throwaway container as the agent user.
container_in_image() {
  [ -n "${LOOP_IMAGE:-}" ] || { echo "doctor: LOOP_IMAGE is not set; skip the container checks"; return 0; }
  podman run --rm -i --user "${LOOP_AGENT_USER:-agent}" --entrypoint bash \
    -e LOOP_MODELS="${LOOP_MODELS:-}" -e LOOP_DOCTOR_EXTRA="${LOOP_DOCTOR_EXTRA:-}" \
    "$LOOP_IMAGE" -s container <"$SCRIPT_PATH" || exit 1
}

case "${1:-all}" in
  host) host_checks ;;
  container) container_checks ;;
  all) host_checks; container_in_image ;;
  *) echo "Usage: doctor.sh [host|container|all]" >&2; exit 2 ;;
esac
