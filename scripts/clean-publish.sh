#!/usr/bin/env bash
# Usage:
#   scripts/clean-publish.sh <target-dir> [--source <repo-dir>] [--filtered-history]
# --filtered-history keeps the history of HEAD in the new repository. `git filter-repo` rewrites a copy of it: the
# paths of privacy/publish-exclude.txt are left out of every commit, every author and committer becomes the neutral
# author, and the `Co-authored-by` and `Signed-off-by` trailers are removed. The commit messages stay, so the same
# checks run on the full new history. Without `git filter-repo` the script stops with exit code 2.
# Environment:
#   PUBLISH_AUTHOR_NAME   author and committer name (default "The automations contributors")
#   PUBLISH_AUTHOR_EMAIL  author and committer address (default noreply@example.com)
#   PUBLISH_MESSAGE       commit message of the one commit (default "Initial public release")
#   GIT_FILTER_REPO       git filter-repo program (default: git-filter-repo in PATH or in the git program directory)
#   PRIVACY_PEPPER        the pepper of the private word hashes, when the hashes use one
#   GITLEAKS              gitleaks binary (default: gitleaks in PATH)
set -euo pipefail

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
[ -n "$TARGET" ] || { echo "usage: scripts/clean-publish.sh <target-dir> [--source <repo-dir>] [--filtered-history]" >&2; exit 2; }

find_filter_repo() {
  local candidate
  for candidate in "$(command -v git-filter-repo || true)" "$(git --exec-path)/git-filter-repo"; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
}
if [ "$FILTERED" = 1 ]; then
  FILTER_REPO_BIN="${GIT_FILTER_REPO:-$(find_filter_repo)}"
  if [ ! -x "$FILTER_REPO_BIN" ]; then
    echo "clean-publish: --filtered-history needs git filter-repo, and it is not installed. Install it, or run the script without the option (one commit)." >&2
    exit 2
  fi
fi

fail() { echo "clean-publish: FAILED $1" >&2; exit 1; }
remove_and_fail() { rm -rf "$TARGET"; fail "$1"; }
privacy() { "$HERE/node_modules/.bin/tsx" "$HERE/tools/privacy-check/src/cli.ts" "$@"; }

[ -z "$(git -C "$SOURCE" status --porcelain)" ] || fail "the source has uncommitted changes. Commit or stash them first."
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET")" ]; then fail "the target directory is not empty: $TARGET"; fi

echo "clean-publish: privacy check on the source tree"
privacy --repo "$SOURCE" --tree || fail "the source tree has privacy findings. Nothing was made."

EXCLUDED=()
EXCLUDES="$SOURCE/privacy/publish-exclude.txt"
if [ -f "$EXCLUDES" ]; then
  while IFS= read -r path; do
    case "$path" in ""|"#"*) continue ;; /*|*..*) fail "bad path in privacy/publish-exclude.txt: $path" ;; esac
    EXCLUDED+=("$path")
  done < "$EXCLUDES"
fi

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="${PUBLISH_AUTHOR_NAME:-The automations contributors}"
export GIT_AUTHOR_EMAIL="${PUBLISH_AUTHOR_EMAIL:-noreply@example.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

one_commit() {
  local path
  git -C "$SOURCE" archive HEAD | tar -x -C "$TARGET"
  for path in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do rm -rf "${TARGET:?}/$path"; done
  git -C "$TARGET" add -A
  git -C "$TARGET" commit -q --no-verify -m "${PUBLISH_MESSAGE:-Initial public release}"
}

filtered_history() {
  local path
  local -a paths=()
  for path in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do paths+=(--path "$path"); done
  [ "${#paths[@]}" -eq 0 ] || paths+=(--invert-paths)
  git -C "$TARGET" fetch -q --no-tags --update-head-ok "$SOURCE" HEAD:refs/heads/main
  (cd "$TARGET" && "$FILTER_REPO_BIN" --force --quiet --replace-refs delete-no-add ${paths[@]+"${paths[@]}"} \
    --name-callback 'return os.environ["GIT_AUTHOR_NAME"].encode()' \
    --email-callback 'return os.environ["GIT_AUTHOR_EMAIL"].encode()' \
    --message-callback 'return re.sub(rb"\n+\Z", b"\n", re.sub(rb"(?im)^(co-authored-by|signed-off-by):.*\n?", b"", message))') \
    || remove_and_fail "git filter-repo failed. The new repository was removed."
  rm -rf "$TARGET/.git/FETCH_HEAD" "$TARGET/.git/filter-repo"
  git -C "$TARGET" reset -q --hard
}

mkdir -p "$TARGET"
git init -q -b main "$TARGET"
if [ "$FILTERED" = 1 ]; then filtered_history; else one_commit; fi
for path in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do echo "clean-publish: left out $path"; done

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
