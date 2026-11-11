# Public release

This page tells the owner how to make the public repository. An agent never does the publish step.

## Why a new repository

The history of the private repository has personal commit metadata (author name and address) and one old line with a first name (see `docs/public-release-audit.md`, F2 and F3). The history of the private repository is not rewritten. The public repository starts with one initial commit that has a neutral author.

A filtered history is possible, but every commit, message and author line must then pass the privacy check. One initial commit has no such risk, so the script makes one commit.

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

The script adds no remote and does not push.

## Publish (owner only)

1. Look at the new repository: `git -C ../automations-public log --format=fuller` and the file list.
2. Make an empty repository on the host. Add it as a remote and push `main`.
3. Add the CI secrets of the public repository (`PRIVACY_PEPPER`, and `DENYLIST` if you keep the old deny-list step).
4. Later changes: work in the public repository, or run the script again to a new directory and copy the tree as one new commit.
