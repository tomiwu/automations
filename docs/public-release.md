# Public release

> Owner decision of 2026-11-12 (F2): the current repository becomes public after a history rewrite (see `docs/public-release-audit.md`). The rewrite needs the owner's final confirmation. The script below stays as the fallback.

This page tells the owner how to make the public repository. An agent never does the publish step.

## Why a new repository

The history of the private repository has personal commit metadata (author name and address) and one old line with a first name (see `docs/public-release-audit.md`, F2 and F3). The history of the private repository is not rewritten. The public repository starts with one initial commit that has a neutral author.

A filtered history is possible, but every commit, message and author line must then pass the privacy check. One initial commit has no such risk, so the script makes one commit by default. The option `--filtered-history` makes the other choice possible (see below). The owner decides (F2).

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

## Option: keep a filtered history

```sh
npm run clean-publish -- ../automations-public --filtered-history
```

This option needs [`git filter-repo`](https://github.com/newren/git-filter-repo). If it is not installed, the script stops with exit code 2 and makes nothing. Set `GIT_FILTER_REPO` if the program is not in the `PATH`.

With the option, steps 3 and 4 change:

- The script copies the commits of `HEAD` to the new repository. Other branches, tags and remotes are not copied. The source repository is only read.
- `git filter-repo` rewrites the copy. It removes the paths of `privacy/publish-exclude.txt` from every commit. It sets the author and the committer of every commit to `PUBLISH_AUTHOR_NAME` and `PUBLISH_AUTHOR_EMAIL`. It removes the `Co-authored-by` and `Signed-off-by` trailers from every commit message.
- A commit that changed only excluded paths is not in the new history. The branch of the new repository is `main`.

These things stay: the commit messages, the commit dates and every old version of every file that is not excluded. Thus step 5 is the important one: the privacy check and gitleaks run on the full new history, and a finding removes the new repository. The script does not correct a finding. If the old history has a finding (F3 is one), remove its cause from the history copy yourself, or use the default mode.

## Publish (owner only)

1. Look at the new repository: `git -C ../automations-public log --format=fuller` and the file list.
2. Make an empty repository on the host. Add it as a remote and push `main`.
3. Add the CI secrets of the public repository (`PRIVACY_PEPPER`, and `DENYLIST` if you keep the old deny-list step).
4. Later changes: work in the public repository, or run the script again (default mode) to a new directory and copy the tree as one new commit.
