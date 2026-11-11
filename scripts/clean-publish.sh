#!/usr/bin/env bash
# Makes a new, clean git repository from HEAD of the source repository. The author and the committer are neutral.
# Default: one initial commit. The old history, the commit messages and the commit metadata do not go to the new
# repository.
# With --filtered-history: the history of HEAD stays, but without the excluded paths, with the neutral author and
# committer on every commit, and without the `Co-authored-by` and `Signed-off-by` trailers. The commit messages stay.
# This mode needs `git filter-repo`. If it is not installed, the script stops with exit code 2.
#
# Usage:
#   scripts/clean-publish.sh <target-dir> [--source <repo-dir>] [--filtered-history]
#
# Steps: the privacy check on the source tree, a copy of HEAD (without the paths of privacy/publish-exclude.txt) as
# one commit or as a filtered history, then the privacy check on the tree and the full history of the new repository,
# then gitleaks (when it is installed). A finding stops the script and removes the new repository.
#
# It does not change the source repository. It does not add a remote and it does not push. The owner does the publish
# step.
#
# Environment:
#   PUBLISH_AUTHOR_NAME   author and committer name (default "The automations contributors")
#   PUBLISH_AUTHOR_EMAIL  author and committer address (default noreply@example.com)
#   PUBLISH_MESSAGE       commit message of the one commit (default "Initial public release")
#   PRIVACY_PEPPER        the pepper of the private word hashes, when the hashes use one
#   GITLEAKS              gitleaks binary (default: gitleaks in PATH)
#   GIT_FILTER_REPO       git-filter-repo program (default: git-filter-repo in PATH)
set -euo pipefail

USAGE="usage: scripts/clean-publish.sh <target-dir> [--source <repo-dir>] [--filtered-history]"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HERE"; TARGET=""; FILTERED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a directory}"; shift 2 ;;
    --filtered-history) FILTERED=1; shift ;;
    -*) echo "clean-publish: unknown argument: $1" >&2; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "$USAGE" >&2; exit 2; }

fail() { echo "clean-publish: FAILED $1" >&2; exit 1; }
# Removes the new repository, then fails.
remove_and_fail() { rm -rf "$TARGET"; fail "$1"; }
privacy() { "$HERE/node_modules/.bin/tsx" "$HERE/tools/privacy-check/src/cli.ts" "$@"; }

FILTER_REPO_BIN="${GIT_FILTER_REPO:-$(command -v git-filter-repo || true)}"
if [ "$FILTERED" = 1 ] && { [ -z "$FILTER_REPO_BIN" ] || [ ! -x "$FILTER_REPO_BIN" ]; }; then
  echo "clean-publish: --filtered-history needs git filter-repo, and it is not installed. Install it (https://github.com/newren/git-filter-repo), or run the script without the option to make one commit." >&2
  exit 2
fi

SOURCE="$(cd "$SOURCE" && pwd)"
[ -z "$(git -C "$SOURCE" status --porcelain)" ] || fail "the source has uncommitted changes. Commit or stash them first."
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET")" ]; then fail "the target directory is not empty: $TARGET"; fi

# The paths that do not go to the new repository.
EXCLUDED=()
EXCLUDES="$SOURCE/privacy/publish-exclude.txt"
if [ -f "$EXCLUDES" ]; then
  while IFS= read -r path; do
    case "$path" in ""|"#"*) continue ;; /*|*..*) fail "bad path in privacy/publish-exclude.txt: $path" ;; esac
    EXCLUDED+=("$path")
  done < "$EXCLUDES"
fi

echo "clean-publish: privacy check on the source tree"
privacy --repo "$SOURCE" --tree || fail "the source tree has privacy findings. Nothing was made."

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="${PUBLISH_AUTHOR_NAME:-The automations contributors}"
export GIT_AUTHOR_EMAIL="${PUBLISH_AUTHOR_EMAIL:-noreply@example.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# Makes the new repository with one commit: the tracked files of HEAD without the excluded paths.
one_commit() {
  git -C "$SOURCE" archive HEAD | tar -x -C "$TARGET"
  for path in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do rm -rf "${TARGET:?}/$path"; done
  git init -q -b main "$TARGET"
  git -C "$TARGET" add -A
  git -C "$TARGET" commit -q --no-verify -m "${PUBLISH_MESSAGE:-Initial public release}"
}

# Makes the new repository with the history of HEAD. git filter-repo rewrites the copy, not the source: it removes
# the excluded paths, sets the neutral name and address on each commit, and removes the trailers. Then no object,
# reflog or file of the old history stays in the new repository.
filtered_history() {
  local paths=() path
  for path in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do paths+=(--path "$path"); done
  [ ${#paths[@]} -eq 0 ] || paths+=(--invert-paths)
  git init -q -b main "$TARGET"
  git -C "$TARGET" fetch -q --no-tags --update-head-ok "$SOURCE" HEAD:refs/heads/main
  rm -f "$TARGET/.git/FETCH_HEAD"
  (cd "$TARGET" && "$FILTER_REPO_BIN" --force --quiet ${paths[@]+"${paths[@]}"} \
    --name-callback 'return os.environb[b"GIT_AUTHOR_NAME"]' \
    --email-callback 'return os.environb[b"GIT_AUTHOR_EMAIL"]' \
    --message-callback 'return re.sub(rb"(?im)^(co-authored-by|signed-off-by):.*\n?", b"", message).rstrip() + b"\n"') \
    || remove_and_fail "git filter-repo failed. The new repository was removed."
  rm -rf "$TARGET/.git/filter-repo"
  git -C "$TARGET" rev-parse -q --verify HEAD >/dev/null || remove_and_fail "the filtered history has no commit. The new repository was removed."
}

mkdir -p "$TARGET"
for path in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do echo "clean-publish: left out $path"; done
if [ "$FILTERED" = 1 ]; then filtered_history; else one_commit; fi

echo "clean-publish: privacy check on the new tree and its full history"
privacy --repo "$TARGET" --tree --history || remove_and_fail "the new repository has privacy findings. It was removed."

GITLEAKS_BIN="${GITLEAKS:-$(command -v gitleaks || true)}"
if [ -n "$GITLEAKS_BIN" ]; then
  (cd "$TARGET" && "$GITLEAKS_BIN" git --no-banner --redact --exit-code 1 .) || remove_and_fail "gitleaks found a secret in the new repository. It was removed."
else
  echo "clean-publish: WARNING gitleaks is not installed, the secret scan did not run" >&2
fi

echo "clean-publish: ready at $TARGET ($(git -C "$TARGET" rev-list --count HEAD) commit(s), $(git -C "$TARGET" ls-files | wc -l) files)"
echo "clean-publish: nothing was published. The owner adds the remote and pushes."
