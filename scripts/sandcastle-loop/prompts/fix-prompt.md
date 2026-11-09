# Task

You work on issue #{{ISSUE}}, branch `{{BRANCH}}`. The checks failed (local checks or CI). Fix the code so that all checks pass.

## Issue

{{ISSUE_TEXT}}

## Check output

```
{{CHECK_LOG}}
```

# Rules

- Find the cause of each failure. Fix the cause. Do not remove or weaken tests. Do not skip a check.
- Follow the coding standards of the repository.
- Run the checks of the repository again.
- Do not change `.github/` or `.sandcastle/`. Do not put a secret value or personal data in a file.
- Make one commit. Start the message with `RALPH: #{{ISSUE}} fix`. Write it in English, in ASD-STE100 Simplified Technical English.
- Do not push. Do not open a PR. Do not close the issue.

When you are done, output:

<promise>COMPLETE</promise>
