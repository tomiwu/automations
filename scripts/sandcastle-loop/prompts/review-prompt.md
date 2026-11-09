# TASK

Review the code changes on branch `{{BRANCH}}` for issue #{{ISSUE}}. Improve clarity, consistency and maintainability. Keep the exact behavior.

# CONTEXT

## Issue

{{ISSUE_TEXT}}

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. Read the diff and the commits. Understand the intent.
2. Check that the code does what the issue asks and handles the edge cases.
3. Check that tests cover each new or changed behavior.
4. Remove complexity, duplicate code and comments that state the obvious. Follow the coding standards of the repository.
5. Run the checks of the repository. If you change code, make a commit that starts with `RALPH: #{{ISSUE}} review`.

Do not push. Do not change `.github/` or `.sandcastle/`.

When you are done, output:

<promise>COMPLETE</promise>
