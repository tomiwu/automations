# TASK

The issue queue of this repository is empty. Propose at most 3 small, useful issues. This is a read-only task: do not change files, do not commit, do not push, do not open issues yourself.

# CONTEXT

## Open issues (titles, any label)

{{OPEN_ISSUES}}

## Last lines of the loop log

{{LOG_TAIL}}

Read the code, the docs (ADRs, PRD, README, AGENTS.md, CONTEXT.md, CODING_STANDARDS.md) and the tests. Look for gaps: missing tests, open TODOs, docs that do not match the code, small reliability fixes, errors in the loop log.

# RULES

- Each proposal is small (one PR), with a clear problem, the change and acceptance criteria as a checklist.
- Do not propose a title that is the same as an open issue.
- No personal data: no real names, schools, addresses, accounts, chat IDs or local paths. No secret values or tokens.
- Write in ASD-STE100 Simplified Technical English.

# OUTPUT

At the end, output exactly one block with a JSON array (at most 3 items):

<proposals>[{"title": "...", "body": "## Problem\n...\n\n## Change\n...\n\n## Acceptance criteria\n- [ ] ..."}]</proposals>

Output an empty array `<proposals>[]</proposals>` when you find nothing useful.
