# Public release

This page tells the owner how to make the public repository. An agent never does the publish step.

## Why a new repository

The history of the private repository has personal commit metadata (author name and address) and one old line with a first name (see `docs/public-release-audit.md`, F2 and F3). The history of the private repository is not rewritten. The public repository starts with one initial commit that has a neutral author.

A filtered history is possible with the option `--filtered-history` (see below). But every commit, message and author line must then pass the privacy check. One initial commit has no such risk, so one commit is the default. The owner decides the mode (audit finding F2).

## Before the publish step

1. Write your private words to `.privacy-denylist.txt` and run `npm run privacy:hash` (see `tools/privacy-check/README.md`). Set `PRIVACY_PEPPER` first: the public repository must not hold hashes that a person can check with a guess.
2. Decide the paths that stay private and write them to `privacy/publish-exclude.txt` (for example the agent loop, audit finding F5).
3. Run `scripts/ci-local.sh`. All steps must be green.

## Make the clean repository

```sh
npm run clean-publish -- ../automations-public
```

`scripts/clean-publish.sh` does these steps:

1. It stops if the source has uncommitted changes or the target directory is not empty.
2. It runs the privacy check on the source tree. A finding stops the script.
3. It copies the tracked files of `HEAD` and removes the paths of `privacy/publish-exclude.txt`.
4. It makes a new repository with one commit. Author and committer come from `PUBLISH_AUTHOR_NAME` and `PUBLISH_AUTHOR_EMAIL` (default: `The automations contributors`, a no-reply example address). Your git configuration is not used.
5. It runs the privacy check on the tree and on the full history of the new repository, then gitleaks when it is installed. A finding removes the new repository.

The script adds no remote and does not push. It does not change the source repository.

## Option: a filtered history

```sh
npm run clean-publish -- ../automations-public --filtered-history
```

With `--filtered-history`, the new repository keeps the history of `HEAD`. Steps 1, 2 and 5 are the same. Steps 3 and 4 change:

- The script copies the commits of `HEAD` to the new repository (branch `main`). Other branches and tags are not copied.
- `git filter-repo` rewrites the copy. It removes the paths of `privacy/publish-exclude.txt` from every commit. It sets the author and the committer of every commit to the neutral name and address. It removes each `Co-authored-by` and `Signed-off-by` trailer. A commit that becomes empty is removed.
- The commit messages and the old file contents stay. The privacy check and gitleaks of step 5 examine them in the full new history. A finding removes the new repository. Then correct the cause, or use the default mode.

This mode needs [`git filter-repo`](https://github.com/newren/git-filter-repo) in the `PATH` (or set `GIT_FILTER_REPO` to the program). If it is not installed, the script stops with exit code 2 and makes nothing.

## Publish (owner only)

1. Look at the new repository: `git -C ../automations-public log --format=fuller` and the file list. For a filtered history, read the commit messages too.
2. Make an empty repository on the host. Add it as a remote and push `main`.
3. Add the CI secrets of the public repository (`PRIVACY_PEPPER`, and `DENYLIST` if you keep the old deny-list step).
4. Later changes: work in the public repository, or run the script again to a new directory and copy the tree as one new commit.
