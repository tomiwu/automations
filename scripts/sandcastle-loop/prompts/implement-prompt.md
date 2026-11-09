# Context

You work on the repository in the current directory. Read `README.md`, `CONTEXT.md`, `CODING_STANDARDS.md`, `.sandcastle/CODING_STANDARDS.md`, `docs/PRD.md` and the ADRs in `docs/adr/`, if they exist. Follow them.

## Your issue: #{{ISSUE}}

The host read the issue. This is the issue as JSON (number, title, body, comments):

{{ISSUE_TEXT}}

## Recent commits

!`git log --oneline -10`

# Task

Implement issue #{{ISSUE}} on branch `{{BRANCH}}`. Do only this issue.

1. Read the issue and the project documents above.
2. Use Red-Green-Refactor. Write a failing test first. Then write the code that makes the test pass.
3. Run the checks of the repository (for example `npm ci`, `npm run typecheck`, `npm test`). Fix all failures.
4. Make one git commit. Start the message with `RALPH: #{{ISSUE}}`. Write the task, the key decisions and the files changed. The host copies the commit messages into the PR description.

# Rules

- Write all code, comments and commit messages in English. Use ASD-STE100 Simplified Technical English.
- Do not put a secret value, a real personal name, an e-mail address or a local path in the code, the tests or a commit. Use invented data.
- Do not change `.github/` or `.sandcastle/`. If the CI must change, write a comment on the issue with `gh issue comment {{ISSUE}}` and describe the exact change.
- Do not leave commented-out code or TODO comments.
- Do not push. Do not open a PR. Do not close the issue. The host does these steps after the checks pass.
- If you cannot continue, write a comment on the issue with `gh issue comment {{ISSUE}}`. Explain the problem.

When you are done, output:

<promise>COMPLETE</promise>

## Running tests
Run tests in a way that does not use watch mode. Tests must not make real network calls; use fakes.
