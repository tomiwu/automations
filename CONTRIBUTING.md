# Contributing

Thank you for your help. This project is small. Keep changes small too.

## Before you start

- Read `CODING_STANDARDS.md` and `CONTEXT.md`. Use the words of `CONTEXT.md` in code and docs.
- Read the ADRs in `docs/adr/`. Open an issue first if your change does not agree with an ADR.
- Write code, comments, docs and commit messages in English (ASD-STE100 Simplified Technical English: short sentences, active voice).

## Setup

```sh
npm ci
npm run check
```

`npm run check` runs typecheck, the tests, the CRAP score check, the privacy check and gitleaks (when it is installed). The tests use fakes and synthetic fixtures. They need no account at a Service and no network.

## Rules for a change

- Write a failing test first. Then write the code.
- Every function has a CRAP score less than 6 (`npm run crap`).
- No personal data: no real names of people, schools or clubs, no e-mail addresses, no phone numbers, no account numbers, no Telegram chat IDs, no local paths. Use invented data (`Child One`, `Example School`, chat ID `1000001`, `example.com`).
- No secret values. Use secret NAMES only (`CHILD1_LIBRUS_LOGIN`).
- Never test against a live Service (Librus, ActiveNow, Edusky, Mondo), a real Supabase project or a real Telegram chat.
- Do not add a dependency if Node 22 can do the task.

## Privacy check

`npm run privacy` must print `no findings`. It prints places and categories, never values. If it finds a synthetic value of yours, change the value to a documented example value (see `tools/privacy-check/README.md`).

## Git hooks

Install the hooks one time for each clone:

```sh
scripts/install-hooks.sh
```

The script sets `git config core.hooksPath scripts/hooks` on the common repository config, so every worktree of the clone uses the hooks. It also makes sure that gitleaks 8.28.0 is available (gitleaks in the `PATH`, or a download into the cache that `scripts/ci-local.sh` uses). Only this download uses the network.

`scripts/hooks/pre-commit` runs on each commit, in seconds, on the staged changes only:

- gitleaks on the staged changes, with `--redact` and the `.gitleaksignore` of the repository.
- The privacy check on the staged lines.
- `npm run typecheck` in the workspaces with a staged file.

A finding stops the commit. The output shows places and categories, never a secret value. Correct the finding and commit again. Do not use `git commit --no-verify`: `--no-verify` is not allowed for this hook. The hook does not run the tests. Run `npm run check` before a push.

The Sandcastle loop runs `scripts/install-hooks.sh` at its start and in each new sandbox worktree.

## Pull requests

- One topic for each pull request. Say what changed and why.
- CI must be green.
- By sending a change you agree that it is under the MIT license (`LICENSE`).
