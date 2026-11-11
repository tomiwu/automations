# dev-checks

Local checks before a push.

- `npm run check` (root, `scripts/check.sh`): `npm run typecheck`, `npm test`, `npm run crap`, `npm run privacy` (`tools/privacy-check`), then `gitleaks git --no-banner --redact --exit-code 1 .` when gitleaks is installed (otherwise one warning line). It stops at the first failure and prints `check: FAILED at step "<name>"`.
- `npm run crap:changed` (root, `src/cli.ts`): `npm run crap` only in the workspaces with a changed file against `origin/main`. Changed files are the commits since the base, the uncommitted changes and new files. A change in `package.json`, `package-lock.json` or `tsconfig.base.json` selects all workspaces. Workspaces without a `crap` script are skipped.
  - `npm run crap:changed -- --dry-run` prints the selected workspaces and runs nothing.
  - `npm run crap:changed -- --base <ref>` uses another base.
  - `--staged` uses the staged files and no base. `--script <name>` runs another script than `crap`. `scripts/hooks/pre-commit` uses `--staged --script typecheck`.
- `scripts/hooks/pre-push` (installed by `scripts/install-hooks.sh`): the full `scripts/ci-local.sh` for each commit of a push, in a temporary checkout of the commit. A red result stops the push. A branch delete does not run ci-local. A green commit SHA gets a stamp file in `ci-local-green` in the common git directory, so a second push of the same SHA does not run ci-local again. `--no-verify` is not allowed. `src/pre-push.test.ts` tests the hook with a stub ci-local and a bare repository on the disk as the remote.

The CI workflow does not use these commands. It runs each step itself.
