# kody-deploy

Helper scripts of `.github/workflows/deploy-kody.yml`.

- `kody-check.mjs <check.json> <result.json>` runs the Kody publish checks (saves nothing) with the durable flow of `@kodycodes/cli` 3.46.0 and newer. Kody answers HTTP 426 `upgrade_required` to the old inline `POST /v1/packages/check` with `files`.
  - Input `check.json`: `{ "files": { path: utf8 }, "binary_contents": { path: base64 } }` (`binary_contents` is optional). Paths are relative to the package root.
  - Flow: `POST /v1/packages/check-uploads` gives an `upload_id`. `POST /v1/packages/check` with `{ upload_id }` answers `dispatched` with a `workflow_id`. `GET /v1/packages/runs/{workflow_id}` (`package:read`) is read until `result` is an object. The `result` (`ok`, `package_name`, `checks`, `notices`) goes to `result.json`.
  - It retries each request on HTTP 5xx, 429, network errors and timeouts (`KODY_CHECK_DELAYS_MS`, default `5000,15000`; `KODY_CHECK_TIMEOUT_MS`, default 120000). A 4xx fails at once.
  - Poll interval `KODY_CHECK_POLL_MS` (default 1500). Limit for the whole script, retries and requests included, `KODY_CHECK_WAIT_MS` (default 540000). It is less than the 10 min timeout of the workflow step, so a deploy gets exit 3 and not a killed step.
  - Exit codes: 0 when the checks pass, 1 when they fail or a request is refused (4xx), 3 when Kody did not answer (also: the run ended `errored`, `terminated` or `cancelled` without a result, or the wait limit was reached).
  - In a deploy the workflow goes on after exit 3 with a warning, because publish runs the same checks. A dry run fails.
  - The token comes only from `KODY_API_TOKEN` and is never printed.
- `kody-api.mjs` has the HTTP helpers of the two scripts (request, retry rules, token redaction).
- `kody-publish.mjs <@owner/name>` publishes one package (Open API `packageList` and `packagePublishExternalPush`, the same as `kody package publish`) and waits until it is done.
  - Kody always answers `dispatched` with a `workflow_id`. The script reads `packageRunResult` (`GET /v1/packages/runs/{workflow_id}`, token scope `package:read`) every 10 s (`KODY_PUBLISH_POLL_MS`). It does not use `workflowRunList`, so the deploy token does not need `job:read`.
  - A `result` with `published` or `already_published` ends with exit 0. An answer `published` or `already_published` in the first reply also ends at once.
  - A refusal (`checks_failed`, `locked`, `approval_required`, `not_fast_forward`) ends the run `errored` with the reason in `last_error`. The script prints it and exits 1. A 4xx fails at once and 5xx, 429 and network errors are tried again.
  - It waits at most 5 minutes (`KODY_PUBLISH_WAIT_MS`). Kody dedupes an active publish.

## Local CI (`scripts/ci-local.sh`)

`scripts/ci-local.sh [--out FILE.md]` runs every job of `.github/workflows` on the box: build (Node 22), sql (postgres:17 in podman), secrets (gitleaks, deny-list from `DENYLIST` or `DENYLIST_FILE`), migrate (`apply.sh` two times on a scratch database) and the `kody-stage` part of the deploy. `sandbox-image.yml` (podman build + smoke test) runs only when the branch changes a file of its `paths` filter, or with `CI_LOCAL_SANDBOX_IMAGE=1`. The Kody API steps are SKIP. `--check-parity` fails when a workflow step has no local step; `src/ci-local.test.ts` checks this. It stops when less than `CI_LOCAL_MIN_FREE_GB` (6) is free.
