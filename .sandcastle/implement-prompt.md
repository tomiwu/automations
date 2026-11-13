# Context

You work on `automations`, issue #{{ISSUE}}, branch `{{BRANCH}}`. Do only this issue. npm workspaces monorepo: `packages/*`, `tools/*`. The repository will become public.

The host writes the full issue (body and comments) to `.sandcastle/context/issue.json` (git-ignored). If the text below is cut, read that file.

<!-- inline-start: .sandcastle/context/issue.json -->
!`mkdir -p .sandcastle/context && printf '*\n' > .sandcastle/context/.gitignore && gh issue view {{ISSUE}} --json number,title,body,comments --jq '{number, title, body, comments: [.comments[].body]}' > .sandcastle/context/issue.json && head -c 15000 .sandcastle/context/issue.json && echo && echo "[Full issue: .sandcastle/context/issue.json ($(wc -c < .sandcastle/context/issue.json) bytes).]"`
<!-- inline-end -->

## Recent commits

!`git log --oneline -10`

# Task

1. Read the issue and its acceptance criteria. Read only the `docs/PRD.md` sections and ADRs (`docs/adr/`) that the issue names. Read `CODING_STANDARDS.md` and the `README.md` of each workspace that you change.
2. Use Red-Green-Refactor: a failing test first, then the code.
3. At the repository root run `npm ci` (or `npm install` for a new dependency or workspace), `npm run typecheck`, `npm test` and `npm run crap`. Fix all failures. Run tests as `npx vitest run --testTimeout=30000` (never watch mode).
4. Make one commit. Start the message with `RALPH: #{{ISSUE}}`. Write the task, the key decisions and the files changed.
5. End the commit message with `## Verification`: the exact command, and a fenced block with the last lines of its real output (copy them, do not write them). For a performance issue add a before/after table with the measured numbers.

# Facts that the code does not show

- No personal data: no real names of people, schools or facilities, no e-mail addresses, no Telegram chat IDs, no local paths. Use invented data (`Child One`, `Example School`, chat ID `1000001`) and generic secret names (`CHILD1_LIBRUS_LOGIN`).
- Never touch Kody secrets, the Kody API or CLI, a real Supabase project, Librus or a service app. Do not send Telegram, e-mail or calendar messages. Tests use fakes or the CI Postgres container.
- If the CI must change, describe the exact change with `gh issue comment {{ISSUE}}`. The owner changes `.github/`.
- A new workspace needs the scripts `typecheck`, `test` and `crap`, a `tsconfig.json` that extends `../../tsconfig.base.json`, a `vitest.config.ts`, and an updated root `package-lock.json`.
- The host pushes, opens the PR and merges. Do not edit `docs/PRD.md`, `docs/issues-draft.md`, `.sandcastle/`, `.claude/` or `.github/`.
- If you cannot continue, write the reason with `gh issue comment {{ISSUE}}`.

When you are done, output:

<promise>COMPLETE</promise>
