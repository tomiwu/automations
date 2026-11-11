#!/usr/bin/env bash
# Makes a new, clean git repository from the tree of HEAD: one initial commit with a neutral author.
# The old history, the commit messages and the commit metadata do not go to the new repository.
#
# Usage:
#   scripts/clean-publish.sh <target-dir> [--source <repo-dir>]
#
# Steps: the privacy check on the source tree, a copy of the tracked files of HEAD (without the paths of
# privacy/publish-exclude.txt), `git init` and one commit, then the privacy check on the tree and the full history of
# the new repository, then gitleaks (when it is installed). A finding stops the script and removes the new repository.
#
# It does not add a remote and it does not push. The owner does the publish step.
#
# Environment:
#   PUBLISH_AUTHOR_NAME   author and committer name (default "The automations contributors")
#   PUBLISH_AUTHOR_EMAIL  author and committer address (default noreply@example.com)
#   PUBLISH_MESSAGE       commit message (default "Initial public release")
#   PRIVACY_PEPPER        the pepper of the private word hashes, when the hashes use one
#   GITLEAKS              gitleaks binary (default: gitleaks in PATH)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HERE"; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a directory}"; shift 2 ;;
    -*) echo "clean-publish: unknown argument: $1" >&2; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: scripts/clean-publish.sh <target-dir> [--source <repo-dir>]" >&2; exit 2; }

fail() { echo "clean-publish: FAILED $1" >&2; exit 1; }
privacy() { "$HERE/node_modules/.bin/tsx" "$HERE/tools/privacy-check/src/cli.ts" "$@"; }

[ -z "$(git -C "$SOURCE" status --porcelain)" ] || fail "the source has uncommitted changes. Commit or stash them first."
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET")" ]; then fail "the target directory is not empty: $TARGET"; fi

echo "clean-publish: privacy check on the source tree"
privacy --repo "$SOURCE" --tree || fail "the source tree has privacy findings. Nothing was made."

mkdir -p "$TARGET"
git -C "$SOURCE" archive HEAD | tar -x -C "$TARGET"

EXCLUDES="$SOURCE/privacy/publish-exclude.txt"
if [ -f "$EXCLUDES" ]; then
  while IFS= read -r path; do
    case "$path" in ""|"#"*) continue ;; /*|*..*) rm -rf "$TARGET"; fail "bad path in privacy/publish-exclude.txt: $path" ;; esac
    rm -rf "${TARGET:?}/$path"
    echo "clean-publish: left out $path"
  done < "$EXCLUDES"
fi

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="${PUBLISH_AUTHOR_NAME:-The automations contributors}"
export GIT_AUTHOR_EMAIL="${PUBLISH_AUTHOR_EMAIL:-noreply@example.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git init -q -b main "$TARGET"
git -C "$TARGET" add -A
git -C "$TARGET" commit -q --no-verify -m "${PUBLISH_MESSAGE:-Initial public release}"

echo "clean-publish: privacy check on the new tree and its full history"
if ! privacy --repo "$TARGET" --tree --history; then
  rm -rf "$TARGET"
  fail "the new repository has privacy findings. It was removed."
fi

GITLEAKS_BIN="${GITLEAKS:-$(command -v gitleaks || true)}"
if [ -n "$GITLEAKS_BIN" ]; then
  if ! (cd "$TARGET" && "$GITLEAKS_BIN" git --no-banner --redact --exit-code 1 .); then
    rm -rf "$TARGET"
    fail "gitleaks found a secret in the new repository. It was removed."
  fi
else
  echo "clean-publish: WARNING gitleaks is not installed, the secret scan did not run" >&2
fi

echo "clean-publish: ready at $TARGET ($(git -C "$TARGET" rev-list --count HEAD) commit, $(git -C "$TARGET" ls-files | wc -l) files)"
echo "clean-publish: nothing was published. The owner adds the remote and pushes."
