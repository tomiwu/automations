# Task

You work on `automations`, issue #{{ISSUE}}, branch `{{BRANCH}}`. The checks failed (local checks or GitHub Actions CI). Fix the code so that all checks pass. The CI workflow is `.github/workflows/ci.yml`. You must not change it.

## Check output

```
{{CHECK_LOG}}
```

# Rules

- Find the cause of each failure. Fix the cause. Do not remove or weaken tests to make them pass. Do not skip a check.
- If a function has CRAP 6 or more, make the function smaller or add tests to increase coverage.
- If gitleaks or the deny-list check fails, remove the secret or the personal string from the files. Use invented data.
- Follow `docs/PRD.md`, `CODING_STANDARDS.md` and `.sandcastle/CODING_STANDARDS.md`.
- At the repository root, run `npm ci`, `npm run typecheck`, `npm test` and `npm run crap`.
- Do not read or change Kody secrets. Do not publish or deploy to Kody. Do not change `.github/`.
- Make one commit. Start the message with `RALPH: #{{ISSUE}} fix`. Write it in English, in ASD-STE100 Simplified Technical English.
- Do not push. Do not open a PR. Do not close the issue.

When you are done, output:

<promise>COMPLETE</promise>
