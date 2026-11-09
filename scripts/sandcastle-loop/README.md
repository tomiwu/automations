# Shared Sandcastle loop

One loop for all repositories of the owner. It takes the next open issue with a label and runs these steps: implement, review, checks, PR, CI, squash-merge, close the issue. The host reads the issue text and gives it to the agents. A sandbox token needs no access to the repository.

The loop never edits `.sandcastle/`. The prompts of this loop are in `prompts/`.

## Start

```sh
cd /path/to/target-repo-checkout
LOOP_REPO=owner/name /path/to/automations/scripts/sandcastle-loop.sh
```

`sandcastle-loop.sh` takes a lock and a pid file per repository, sets `XDG_RUNTIME_DIR=/tmp/xdg-runtime-loop`, checks `LOOP_IMAGE`, and starts `main.mts` with `setsid nohup`. It removes `GH_TOKEN` and `GITHUB_TOKEN` from the environment of the loop. The log is `<LOOP_LOG_DIR>/<YYYYMMDD-HHMM>.log`. The link `current.log` points to the newest log.

To see the next issue and run no agent: `DRY_RUN=1 npx tsx scripts/sandcastle-loop/main.mts`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOOP_REPO` | the current git repository | `owner/name` of the repository |
| `LOOP_LABEL` | `Sandcastle` | Label of the issues to work on |
| `LOOP_MODELS` | `claude:claude-sonnet-5-5,cursor:composer-2.5` | Ordered list `provider:model`. Providers: `claude`, `cursor`. On a credit or limit error the loop changes to the next model. |
| `LOOP_LOG_DIR` | `/workspace/loops/<repo name>` | Directory for the logs, the lock and the pid file |
| `LOOP_CHECKS` | `npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run crap` | Command that runs in the sandbox. Exit code 0 means the checks pass. |
| `LOOP_IMAGE` | the Sandcastle default | Name of the Podman image for the sandbox |
| `LOOP_SORT` | `priority,number` | Queue order. See below. |
| `LOOP_PROMPT_DIR` | `prompts/` in this directory | Directory with `implement-prompt.md`, `review-prompt.md` and `fix-prompt.md` |
| `MAX_ITERATIONS` | `10` | Maximum number of issues per run |
| `MAX_FIX_ATTEMPTS` | `3` | Fix attempts for the checks and for the CI |
| `SKIP_ISSUES` | empty | Comma-separated issue numbers to ignore |
| `DRY_RUN` | unset | Print the next issue and stop |

The prompt files can use `{{ISSUE}}`, `{{BRANCH}}`, `{{ISSUE_TEXT}}` (the issue as JSON) and `{{CHECK_LOG}}` (fix prompt only).

## Queue order

An issue is ready when it has no open `Blocked by #N` issue. `LOOP_SORT` is a comma-separated list of keys. The loop compares the keys in order.

- `priority`: labels `priority: critical`, `high`, `medium`, `low`, in this order. No label means medium.
- `number`: lowest issue number first.
- `-number`: highest issue number first.
- `label:<name>`: issues with this label first.

If the list has no `number` key, the loop adds it at the end. The default `priority,number` is the order of the Kalendarz repository.

## How another repository adopts the loop

1. Add the label (default `Sandcastle`) to the issues.
2. Keep a thin wrapper on the box (for example in `/workspace/bin`). It sets the variables and calls the script:

   ```sh
   #!/usr/bin/env bash
   export LOOP_REPO=owner/name
   export LOOP_MODELS=claude:claude-sonnet-5-5
   export LOOP_IMAGE=example-sandbox-image
   cd /path/to/checkout
   exec /path/to/automations/scripts/sandcastle-loop.sh
   ```
3. If the repository needs its own prompts or checks, set `LOOP_PROMPT_DIR` and `LOOP_CHECKS`.
