#!/usr/bin/env bash
# Build the sandbox image of the shared loop in one command and print its tag for LOOP_IMAGE.
#   scripts/sandcastle-loop/build-image.sh
# The tag is sandcastle:<repo>-<short sha of the Containerfile>. The build output goes to stderr;
# stdout has only the tag.
#
# Environment:
#   LOOP_REPO           owner/name (default: the name in the origin URL, else the name of the top directory;
#                       a worktree directory name such as automations-170 is not the repo name)
#   LOOP_CONTAINERFILE  Containerfile (default: Containerfile in this directory; another repo sets its own)
#   LOOP_BUILD_CONTEXT  build context (default: the directory of the Containerfile)
#   LOOP_IMAGE_NAME     image name (default: sandcastle)
#   LOOP_MODELS         passed as a build arg, so the build checks the agent CLIs of these providers
#   LOOP_STORAGE_CONF   podman storage config (exported as CONTAINERS_STORAGE_CONF)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERFILE="${LOOP_CONTAINERFILE:-$SCRIPT_DIR/Containerfile}"
CONTEXT="${LOOP_BUILD_CONTEXT:-$(dirname "$CONTAINERFILE")}"
NAME="${LOOP_IMAGE_NAME:-sandcastle}"
if [ -n "${LOOP_STORAGE_CONF:-}" ]; then export CONTAINERS_STORAGE_CONF="$LOOP_STORAGE_CONF"; fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-loop}"

if [ -n "${LOOP_REPO:-}" ]; then
  REPO="${LOOP_REPO##*/}"
else
  ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
  if [ -n "$ORIGIN" ]; then ORIGIN="${ORIGIN%.git}"; REPO="${ORIGIN##*[/:]}"; else REPO="$(basename "$(git rev-parse --show-toplevel)")"; fi
fi
[ -f "$CONTAINERFILE" ] || { echo "The Containerfile $CONTAINERFILE does not exist." >&2; exit 1; }
SHA="$(git hash-object "$CONTAINERFILE" | cut -c1-7)"
TAG="$NAME:$REPO-$SHA"

args=(build -t "$TAG" -f "$CONTAINERFILE" --build-arg "AGENT_UID=$(id -u)" --build-arg "AGENT_GID=$(id -g)")
if [ -n "${LOOP_MODELS:-}" ]; then args+=(--build-arg "LOOP_MODELS=$LOOP_MODELS"); fi
podman "${args[@]}" "$CONTEXT" >&2
echo "$TAG"
