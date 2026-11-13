# Task

You work on `automations`, issue #{{ISSUE}}, branch `{{BRANCH}}`. A check failed. Fix the cause so that all checks pass.

## Check output

<!-- inline-start: the check output (run the check again for the full log) -->
```
{{CHECK_LOG}}
```
<!-- inline-end -->

# Rules

- Fix the cause. Do not remove or weaken a test. Do not skip a check.
- CRAP 6 or more: make the function smaller or add tests.
- gitleaks or deny-list failure: remove the secret or the personal string. Use invented data.
- At the root run `npm ci`, `npm run typecheck`, `npm test` and `npm run crap`.
- Make one commit that starts with `RALPH: #{{ISSUE}} fix`, in English (ASD-STE100). If no commit has a `## Verification` section yet, add one with the command and its real output.
- The CI workflow is `.github/workflows/ci.yml`; the owner changes it, not you. The host pushes and merges. Do not edit `docs/PRD.md`, `.sandcastle/`, `.claude/` or `.github/`.

When you are done, output:

<promise>COMPLETE</promise>
