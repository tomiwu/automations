# Shared Sandcastle loop

One loop for all repositories of the owner. It takes the next open issue with a label and runs these steps: implement, review, checks, PR, CI, squash-merge, close the issue. The host reads the issue text and gives it to the agents. A sandbox token needs no access to the repository.

The loop never edits `.sandcastle/`. The prompts of this loop are in `prompts/`.

## Start

```sh
cd /path/to/target-repo-checkout
LOOP_REPO=owner/name /path/to/automations/scripts/sandcastle-loop.sh
```

`sandcastle-loop.sh` takes a lock and a pid file per repository, sets `XDG_RUNTIME_DIR=/tmp/xdg-runtime-loop`, checks `LOOP_IMAGE`, and starts `main.mts` with `setsid nohup`. It removes `GH_TOKEN` and `GITHUB_TOKEN` from the environment of the loop. The log is `<LOOP_LOG_DIR>/<YYYYMMDD-HHMM>.log`. The link `current.log` points to the newest log.

## Sandbox image

Rebuild the image in one command and use the printed tag:

```sh
export LOOP_IMAGE="$(LOOP_REPO=tomiwu/automations scripts/sandcastle-loop/build-image.sh)"
```

- `build-image.sh` builds `Containerfile` in this directory and tags it `sandcastle:<repo>-<short sha of the Containerfile>`. Only the tag goes to stdout; the build output goes to stderr.
- The last root steps of the Containerfile are `install -d -m 1777 /tmp` and `chown -R $AGENT_UID:$AGENT_GID /home/agent` (numeric: the group of the renamed user is still `node`). The last `RUN` is `doctor.sh container` as the agent user, so the build fails when the image is broken.
- Another repository keeps its own Containerfile (for example extra toolchains) and sets `LOOP_CONTAINERFILE`, `LOOP_BUILD_CONTEXT` (put `doctor.sh` in it) and `LOOP_IMAGE_NAME`. `LOOP_STORAGE_CONF` selects the podman storage. `LOOP_MODELS` is passed as a build arg, so the build checks the agent CLIs.
- The box wrapper switches to this image after the merge (owner step). `.sandcastle/Containerfile` stays for the current loop.

- CI: the workflow `.github/workflows/sandbox-image.yml` ("sandbox image build") builds this Containerfile and runs the container doctor. It runs on PRs and pushes to main that change `Containerfile`, `doctor.sh`, `build-image.sh` or the workflow itself, weekly (Monday 03:17 UTC), and by hand. It uses no secret and pushes no image.

## Preflight doctor

`doctor.sh` runs before the loop starts (`sandcastle-loop.sh`) and before iteration 1 (`main.mts`, skipped when the start script ran it). When a check fails it prints `DOCTOR FAIL: <check> -> fix: <command>`, exits 1, and no agent starts.

- Host: `node_modules/@ai-hero/sandcastle` exists, `podman info` works with `XDG_RUNTIME_DIR`, `podman image exists $LOOP_IMAGE`, `gh auth status` and `gh repo view $LOOP_REPO` (the output is not shown, so no token is printed).
- Container (a throwaway container of `LOOP_IMAGE` as the agent user): `$HOME` is writable, `/tmp` has mode 1777, `mkdir /tmp/claude-$(id -u)` works, `git`, `node`, `gh` and the agent CLI of each provider in `LOOP_MODELS` (`claude`, Cursor `agent`) answer `--version`, then `LOOP_DOCTOR_EXTRA`.
- `doctor.sh host` and `doctor.sh container` run one part only.

## Model fallback

The order is Claude -> Cursor CLI Composer 2.5 -> Grok in the Cursor CLI. Only local CLIs run; the loop never calls a Cursor cloud agent.

- The Grok id is `GROK_CURSOR_MODEL` in `src/config.ts` (`grok-4.5-high`, the id that the e1003-firmware loop uses). **UNVERIFIED**: this id was not run yet. Check it with `agent --list-models` when the Cursor key works, and change it there or in `LOOP_MODELS`.
- On a limit error of any agent (credit, quota, usage or rate limit, "hit your ... limit", "5-hour limit", "resets"), the loop changes to the next model, runs the same phase again and logs `MODEL SWITCH <from> -> <to> (<reason>)`.
- When all models are limited, the loop logs `ALL MODELS LIMITED. Wait N min`, sleeps until the earliest reset time in the errors ("resets 4:30am", "resets at 16:05", or an ISO time; else 30 minutes), then starts again with the first model. It does not exit.

## Empty queue

There is always something to do. When no issue is ready and `LOOP_IDLE=groom`:

1. A read-only groomer agent (`prompts/groom-prompt.md`) reads the repository, the open issue titles and the last 80 lines of `current.log`, and outputs at most 3 proposals in a `<proposals>[...]</proposals>` block. Its commits are never pushed.
2. The host drops a proposal with the title of an open issue, a string of `LOOP_DENYLIST_FILE`, a secret value of the environment or a token shape. It opens the rest (at most 3) with only the label `LOOP_TRIAGE_LABEL`. The owner bot or the owner adds the loop label to accept one.
3. The loop sleeps `LOOP_IDLE_MINUTES` and checks the queue again. An idle step does not use an iteration.

## Network errors

Each host `gh` call and each `git push`, `pull` and `fetch` is retried (`LOOP_RETRY_DELAYS`). A log line `RETRY <command>: attempt N failed, retry in Ns` shows each retry. A failed CI is re-run one time before the fixer gets the log.

## Secrets in logs

- All output of the loop goes through `redact-filter.mts`. It masks every value of `REDACT_ENV_FILE` (default `.sandcastle/.env`), the value of every environment variable with a name that ends in `_TOKEN`, `_KEY` or `_SECRET`, the patterns `sk-ant-`, `ghp_`, `gho_`, `ghs_`, `github_pat_`, and the value of `<NAME>_TOKEN=` and `<NAME>_KEY=`. The mask is `[REDACTED]`. This also covers the `podman run` command that Sandcastle prints when the command fails.
- `sandcastle-loop.sh` sets `umask 077`: log files have mode 600, the log directory has mode 700.
- `check-no-secrets.sh <dir>` exits 1 when a `*.log` file in `<dir>` matches a token pattern. It prints only the file path and the number of matches. The start script runs it before the loop starts (a match stops the start) and after the loop ends (the result is added to the log).
- Pass secrets to the loop by environment inheritance, never as arguments in a command line.

To see the next issue and run no agent: `DRY_RUN=1 npx tsx scripts/sandcastle-loop/main.mts`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOOP_REPO` | the current git repository | `owner/name` of the repository |
| `LOOP_LABEL` | `Sandcastle` | Label of the issues to work on |
| `LOOP_MODELS` | `claude:claude-sonnet-5-5,cursor:composer-2.5,cursor:grok-4.5-high` | Ordered list `provider:model`. Providers: `claude` (Claude Code CLI), `cursor` (local Cursor `agent` CLI). See "Model fallback". |
| `LOOP_LOG_DIR` | `/workspace/loops/<repo name>` | Directory for the logs, the lock and the pid file |
| `LOOP_CHECKS` | `npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run crap` | Command that runs in the sandbox. Exit code 0 means the checks pass. |
| `LOOP_IMAGE` | the Sandcastle default | Name of the Podman image for the sandbox |
| `LOOP_SORT` | `priority,number` | Queue order. See below. |
| `LOOP_PROMPT_DIR` | `prompts/` in this directory | Directory with `implement-prompt.md`, `review-prompt.md` and `fix-prompt.md` |
| `MAX_ITERATIONS` | `10` | Maximum number of issues per run |
| `MAX_FIX_ATTEMPTS` | `3` | Fix attempts for the checks and for the CI |
| `SKIP_ISSUES` | empty | Comma-separated issue numbers to ignore |
| `DRY_RUN` | unset | Print the next issue and stop |
| `LOOP_IDLE` | `groom` | Empty queue: `groom` proposes issues, sleeps and checks again; `stop` stops the loop |
| `LOOP_IDLE_MINUTES` | `30` | Sleep between two idle checks |
| `LOOP_TRIAGE_LABEL` | `needs-triage` | Label of the groomer proposals (not the loop label) |
| `LOOP_DENYLIST_FILE` | unset | Personal strings, one for each line (same list as the CI `DENYLIST`). A proposal with one of them is not opened. |
| `LOOP_DOCTOR` | `doctor.sh` in this directory | Preflight doctor. Empty: no doctor. |
| `LOOP_DOCTOR_EXTRA` | empty | Extra shell command of the container checks (for example toolchain checks of the repo) |
| `LOOP_SANDBOX_READY` | `npm ci --no-audit --no-fund` | Sandbox-ready hook. A failure stops the sandbox. Empty: no hook. |
| `LOOP_GH`, `LOOP_GIT` | `gh`, `git` | Host commands or wrappers for GitHub and git |
| `LOOP_RETRY_DELAYS` | `5,15,45,90` | Seconds between the attempts of a host `gh` call and of `git push`/`pull`/`fetch` (5 attempts) |
| `LOOP_STORAGE_CONF` | unset | Podman storage config of the repo. The start script and the doctor export it as `CONTAINERS_STORAGE_CONF`. |
| `LOOP_CHECKS_LOCK` | unset | Box-wide lock file around `LOOP_CHECKS` (`flock`), so only one heavy check runs at a time |
| `LOOP_CI_RERUN` | `1` | Re-run the failed CI jobs one time before the CI fixer runs. `0` turns it off. |
| `LOOP_CI_LOG_FILTER` | unset | Shell filter (stdin to stdout) for the failed CI log, for example to remove download noise |

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
