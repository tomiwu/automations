# kody-deploy

Helper scripts of `.github/workflows/deploy-kody.yml`.

- `kody-check.mjs <check.json> <result.json>` runs the Kody publish checks (`POST /v1/packages/check`, saves nothing).
  - It retries on HTTP 5xx, 429, network errors and timeouts (`KODY_CHECK_DELAYS_MS`, default `5000,15000`; `KODY_CHECK_TIMEOUT_MS`, default 120000). A 4xx fails at once.
  - Exit codes: 0 when the checks pass, 1 when they fail or the request is refused, 3 when Kody did not answer.
  - In a deploy the workflow goes on after exit 3 with a warning, because publish runs the same checks. A dry run fails.
  - The token comes only from `KODY_API_TOKEN` and is never printed.
- `kody-publish.mjs <@owner/name>` publishes one package (Open API `packageList` and `packagePublishExternalPush`, the same as `kody package publish`) and waits until it is done.
  - `published` or `already_published` ends at once with exit 0.
  - `dispatched` (Kody moved the publish to a background job): it reads the job status with `workflowRunList` every 10 s (`KODY_PUBLISH_POLL_MS`) until `complete`. A failed job gets one more publish.
  - `workflowRunList` needs the token scope `job:read`. The deploy token does not have it (Kody answers `insufficient_scope`). The script then stops reading the status at once and publishes again every 10 s. Kody dedupes an active publish, and a finished one answers `already_published`. So a done package ends in less than 1 minute.
  - It waits at most 5 minutes (`KODY_PUBLISH_WAIT_MS`). It fails at once on a refusal (`checks_failed`, `locked`, `approval_required`, `not_fast_forward`) or a 4xx, and tries again on 5xx.

## Local CI (`scripts/ci-local.sh`)

`scripts/ci-local.sh [--out FILE.md]` runs every job of `.github/workflows` on the box: build (Node 22), sql (postgres:17 in podman), secrets (gitleaks, deny-list from `DENYLIST` or `DENYLIST_FILE`), migrate (`apply.sh` two times on a scratch database) and the `kody-stage` part of the deploy. `sandbox-image.yml` (podman build + smoke test) runs only when the branch changes a file of its `paths` filter, or with `CI_LOCAL_SANDBOX_IMAGE=1`. The Kody API steps are SKIP. `--check-parity` fails when a workflow step has no local step; `src/ci-local.test.ts` checks this. It stops when less than `CI_LOCAL_MIN_FREE_GB` (6) is free.
