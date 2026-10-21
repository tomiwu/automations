# Context

You work on `automations`. This repository is an npm workspaces monorepo with generic school and activity watchers that run on the Kody platform first. Packages are in `packages/*` and tools are in `tools/*`. The watchers report to Recipients on Telegram. The repository will become public, so it must contain no personal data.

## Your issue: #{{ISSUE}}

!`gh issue view {{ISSUE}} --json number,title,body,comments --jq '{number, title, body, comments: [.comments[].body]}'`

## Recent commits

!`git log --oneline -10`

# Task

Implement issue #{{ISSUE}} on branch `{{BRANCH}}`. Do only this issue.

1. Read the issue. Read `docs/PRD.md`, `CONTEXT.md`, `CODING_STANDARDS.md`, `.sandcastle/CODING_STANDARDS.md` and the ADRs in `docs/adr/` (if they exist). Follow them.
2. Read the `README.md` of each workspace that you change.
3. Use Red-Green-Refactor. Write a failing test first. Then write the code that makes the test pass.
4. At the repository root, run `npm ci` (or `npm install` if you add a dependency or a workspace), `npm run typecheck`, `npm test` and `npm run crap`. Fix all failures.
5. Make one git commit. Start the message with `RALPH: #{{ISSUE}}`. Write the task, the key decisions and the files changed. The host copies the commit messages into the PR description.

# Rules

- Write all code, comments and commit messages in English. Use ASD-STE100 Simplified Technical English.
- No personal data: no real names of people, schools or facilities, no e-mail addresses, no Telegram chat IDs, no local paths. Use invented data (`Child One`, `Example School`, chat ID `1000001`). Use generic secret names (`CHILD1_LIBRUS_LOGIN`).
- Do not read, write, list or change Kody secrets. Do not put a password, token or e-mail address in the code, the tests or a commit.
- Do not publish or deploy to Kody. Do not call the Kody API or the Kody CLI.
- Do not connect to a real Supabase project, Librus or a service app. Tests use fakes, or the Postgres service container in CI.
- Do not change `.github/`. If the CI must change, write a comment on the issue with `gh issue comment {{ISSUE}}` and describe the exact change. The owner changes the CI.
- Do not send a Telegram message, an e-mail or a calendar event.
- Do not push. Do not open a PR. Do not close the issue. The host does these steps after the checks pass.
- Do not edit `docs/PRD.md`, `docs/issues-draft.md` or `.sandcastle/`.
- A new workspace must have the scripts `typecheck`, `test` and `crap`, a `tsconfig.json` that extends `../../tsconfig.base.json`, and a `vitest.config.ts`. Update the root `package-lock.json`.
- Do not leave commented-out code or TODO comments.
- If you cannot continue, write a comment on the issue with `gh issue comment {{ISSUE}}`. Explain the problem.

When you are done, output:

<promise>COMPLETE</promise>

## Running tests
Always run tests as `npx vitest run --testTimeout=30000` (never watch mode). Tests must not make real network calls; use fakes.
