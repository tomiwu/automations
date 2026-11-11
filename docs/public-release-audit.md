# Public release audit

Issue: #234. Step 1 was the audit. Steps 2 to 5 closed the findings. This file contains no real values: only file paths, line numbers, commit ids, counts and categories.

Date: 2026-11-11. Base: `main` at `93bd5b8`. Scope: all tracked files, all commit contents (`git log --all -p`, added lines), all commit messages and the commit metadata (author, committer, trailers).

## Method

- Secrets: `gitleaks` on the tree and on the full history (`scripts/ci-local.sh`, step "gitleaks (full history)"): 0 findings.
- Private words: the deny-list step of `scripts/ci-local.sh` with the local, git-ignored word list (`DENYLIST_FILE`), on the tree and on the full history: 0 findings. A second local list with more names (owner, children, teachers) found the matches in F1 and F3 only.
- Heuristics (a local scanner that prints only `path:line:category`): e-mail addresses, phone numbers, 26-digit account numbers (NRB / IBAN), IP addresses in private ranges, Telegram chat ids, URLs with a token in the query, Supabase project refs, JWTs. Documented example values are allowed (`example.com`, `example.org`, `example.test`, RFC 5737 addresses, loopback).
- The scanner is now `tools/privacy-check` (step 4 of #234), with the same categories and hashed private words.

## Open findings

None. `npm run privacy` (tree) gives no finding. The table "Closed findings" tells how each finding of step 1 was closed. The table "Owner decisions" lists the points that are not personal data and that only the owner can decide.

## Closed findings

| ID | Category | Where | How it was closed |
|---|---|---|---|
| F1 | Personal name (owner) | `scripts/sandcastle-loop/src/config.ts:51` | The comment now says "the owner". |
| F2 | Personal name and personal e-mail (owner), commit metadata | 121 commits and 3 commit trailers of the private history | `scripts/clean-publish.sh` makes the public repository with one initial commit and a neutral author. The private history is not published and not rewritten. A test proves that the new history has no finding (`tools/privacy-check/src/scripts.test.ts`). |
| F3 | Personal name (owner), history content | commits `49e8a7a`, `ab4b044` | Same as F2: the public history does not contain the old commits. |

## Owner decisions (not personal data)

| ID | Topic | Where | State |
|---|---|---|---|
| F2 | Single initial commit or a filtered history | `scripts/clean-publish.sh` | The script makes a single initial commit (`docs/public-release.md` gives the reason). |
| F4 | Owner handle in package names | npm scope `@tomiwu/*` and `kody:@tomiwu/*` imports in 49 files | The handle is public already. Keep the scope, or rename it before the publish step. |
| F5 | Owner-specific tooling and deploy | `.sandcastle/`, `scripts/sandcastle-loop/`, `.github/workflows/deploy-kody.yml` | No secret values. To leave a path out of the public repository, add it to `privacy/publish-exclude.txt`. |
| F6 | Bot / package name | `packages/kradziejka` and references (38 files) | Not a person name. Keep, or rename before the publish step. |
| F7 | Pepper for the private word hashes | `privacy/denylist.hashes.json` | The file has no hashes yet. The owner sets `PRIVACY_PEPPER`, runs `npm run privacy:hash` with the local plain list and commits the file (`tools/privacy-check/README.md`). |
| F8 | `privacy` step in the GitHub workflow | `.github/workflows/ci.yml` | Agents do not change `.github/`. The exact change is in a comment on issue #234. `scripts/ci-local.sh` has the step already. |

## Checked, no finding

| Category | Result |
|---|---|
| Names of children, spouse, teachers | 0 in the tree and in the history content. |
| Schools, preschools, classes, clubs, addresses | 0. Only service names (Librus, ActiveNow, Edusky "My School", Mondo) as integration targets, and `*.example.*` hosts. |
| Phone numbers | 0. |
| E-mail addresses | 1 distinct value in the tree: the generic `git@github.com` URL rewrite in `.sandcastle/Containerfile:33-34`. Not personal. |
| Account numbers (26 digits) | 4 distinct values, all synthetic (sequences or repeated digits), in tests, `packages/librus-data/src/fixtures.ts` and `examples/seed.example.json`. |
| Telegram chat ids | 6 distinct values, all synthetic, in tests and fixtures. |
| Private IP addresses, internal host names | 0 (only `127.0.0.1`). |
| URLs with tokens, JWTs, Supabase project refs | 0 (only `example.supabase.co`, `x.supabase.co`, `project.example.test`). |
| Real Librus or payment data in fixtures | 0. The fixtures use invented ids (all-zero UUIDs), invented names ("Child One", "Example Club") and invented amounts. |
| Polish private notes | 0. Polish text in the tree is product text only: calendar status tokens (`[ODWOŁANA]`, `[usunięte?]`), Telegram texts in `packages/shared/src/i18n.ts`, the ZBP character set. |
| Secrets | 0 (gitleaks, tree and full history). |

## Privacy gate (step 4)

- `tools/privacy-check` has the categories of this audit: hashed private words, e-mail addresses, phone numbers, account numbers, private IP addresses, Telegram chat ids, URLs with tokens, bot tokens, JWTs and Supabase project refs.
- `scripts/ci-local.sh` (step `privacy`), `npm run check` and the pre-commit hook (`scripts/hooks/pre-commit`) run it.
- `--history` on the private repository reports the commit metadata of F2 (category `email`). This is expected: the private history is not published. `scripts/clean-publish.sh` runs `--history` on the new repository and stops on a finding.

## Publish

See `docs/public-release.md`. The owner does the publish step.
