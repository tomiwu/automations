# kody-deploy

Helper scripts of `.github/workflows/deploy-kody.yml`.

- `kody-check.mjs <check.json> <result.json>` runs the Kody publish checks (`POST /v1/packages/check`, saves nothing).
  - It retries on HTTP 5xx, 429, network errors and timeouts (`KODY_CHECK_DELAYS_MS`, default `5000,15000`; `KODY_CHECK_TIMEOUT_MS`, default 120000). A 4xx fails at once.
  - Exit codes: 0 when the checks pass, 1 when they fail or the request is refused, 3 when Kody did not answer.
  - In a deploy the workflow goes on after exit 3 with a warning, because publish runs the same checks. A dry run fails.
  - The token comes only from `KODY_API_TOKEN` and is never printed.

## Local CI (`scripts/ci-local.sh`)

`scripts/ci-local.sh [--out FILE.md]` runs every job of `.github/workflows` on the box: build (Node 22), sql (postgres:17 in podman), secrets (gitleaks, deny-list from `DENYLIST` or `DENYLIST_FILE`), migrate (`apply.sh` two times on a scratch database) and the `kody-stage` part of the deploy. The Kody API steps are SKIP. `--check-parity` fails when a workflow step has no local step; `src/ci-local.test.ts` checks this. It stops when less than `CI_LOCAL_MIN_FREE_GB` (6) is free.
