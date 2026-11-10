#!/usr/bin/env bash
# Start the shared Sandcastle loop in the background for one repository.
# Configuration comes from the environment. See scripts/sandcastle-loop/README.md.
#   LOOP_REPO     owner/name (default: the git repo in the current directory)
#   LOOP_LOG_DIR  log directory (default: /workspace/loops/<repo name>)
#   LOOP_IMAGE    sandbox image name (the script checks that it exists)
# Run the script from a checkout of the target repository.
#   REDACT_ENV_FILE  dotenv file whose values the loop masks in its output (default: .sandcastle/.env)
# The loop output goes through a redaction filter. Log files get mode 600.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${LOOP_REPO:-}" ]; then
  LOOP_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
export LOOP_REPO
REPO_NAME="${LOOP_REPO##*/}"
LOG_DIR="${LOOP_LOG_DIR:-/workspace/loops/$REPO_NAME}"
export LOOP_LOG_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
CHECK_SECRETS="$SCRIPT_DIR/sandcastle-loop/check-no-secrets.sh"

LOCK_FILE="$LOG_DIR/loop.lock"
PID_FILE="$LOG_DIR/loop.pid"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "The loop for $LOOP_REPO is already running (lock: $LOCK_FILE)." >&2
  exit 1
fi
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "The loop for $LOOP_REPO is already running (pid $(cat "$PID_FILE"))." >&2
  exit 1
fi

export XDG_RUNTIME_DIR=/tmp/xdg-runtime-loop
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if [ -n "${LOOP_IMAGE:-}" ] && ! podman image exists "$LOOP_IMAGE"; then
  echo "The image $LOOP_IMAGE does not exist. Build it first." >&2
  exit 1
fi

if ! "$CHECK_SECRETS" "$LOG_DIR"; then
  echo "A log in $LOG_DIR contains a token. Remove the token and start again." >&2
  exit 1
fi

LOG_FILE="$LOG_DIR/$(date +%Y%m%d-%H%M).log"
: >"$LOG_FILE"
ln -sfn "$LOG_FILE" "$LOG_DIR/current.log"

# The child must not keep the lock open (fd 9), so the next start can take it after the loop ends.
# The subshell runs the loop through the redaction filter, then checks the logs again.
setsid nohup bash -c '
  env -u GH_TOKEN -u GITHUB_TOKEN npx tsx "$1/sandcastle-loop/main.mts" 2>&1 \
    | npx tsx "$1/sandcastle-loop/redact-filter.mts" >>"$2"
  "$1/sandcastle-loop/check-no-secrets.sh" "$3" >>"$2" 2>&1 || true
' _ "$SCRIPT_DIR" "$LOG_FILE" "$LOG_DIR" >/dev/null 2>&1 9>&- &
echo $! >"$PID_FILE"
echo "Started the loop for $LOOP_REPO (pid $!). Log: $LOG_DIR/current.log"
