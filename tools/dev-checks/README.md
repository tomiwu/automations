# dev-checks

Local checks before a push.

- `npm run check` (root, `scripts/check.sh`): `npm run typecheck`, `npm test`, `npm run crap`, `npm run privacy` (`tools/privacy-check`), then `gitleaks git --no-banner --redact --exit-code 1 .` when gitleaks is installed (otherwise one warning line). It stops at the first failure and prints `check: FAILED at step "<name>"`.
- `npm run crap:changed` (root, `src/cli.ts`): `npm run crap` only in the workspaces with a changed file against `origin/main`. Changed files are the commits since the base, the uncommitted changes and new files. A change in `package.json`, `package-lock.json` or `tsconfig.base.json` selects all workspaces. Workspaces without a `crap` script are skipped.
  - `npm run crap:changed -- --dry-run` prints the selected workspaces and runs nothing.
  - `npm run crap:changed -- --base <ref>` uses another base.

The CI workflow does not use these commands. It runs each step itself.
