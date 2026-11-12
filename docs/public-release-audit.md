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
| F2 | Personal name and personal e-mail (owner), commit metadata | 121 commits and 3 commit trailers of the private history (133 commits on 2026-11-12) | Owner decided 2026-11-12: publish the current repo after a history rewrite to a neutral author. Until the rewrite, the private history is not published. Fallback: `scripts/clean-publish.sh` makes a repository with one initial commit and a neutral author; a test proves that its history has no finding (`tools/privacy-check/src/scripts.test.ts`). |
| F3 | Personal name (owner), history content | commits `49e8a7a`, `ab4b044` | The history rewrite of F2 replaces the lines. Until then, the private history is not published. |

## Owner decisions (not personal data)

| ID | Topic | Where | State |
|---|---|---|---|
| F2 | Single initial commit or a filtered history | `scripts/clean-publish.sh`, the history of this repository | Owner decided 2026-11-12: publish the current repo after a history rewrite (the author, committer and trailer lines become a neutral author; the F3 lines are replaced). The rewrite is not done yet and needs the owner's final confirmation before the force push. `scripts/clean-publish.sh` (single initial commit) stays as the fallback. |
| F4 | Owner handle in package names | npm scope `@tomiwu/*` and `kody:@tomiwu/*` imports in 49 files | The handle is public already. Keep the scope, or rename it before the publish step. |
| F5 | Owner-specific tooling and deploy | `.sandcastle/`, `scripts/sandcastle-loop/`, `.github/workflows/deploy-kody.yml` | No secret values. To leave a path out of the public repository, add it to `privacy/publish-exclude.txt`. |
| F6 | Bot / package name | `packages/kradziejka` and references (38 files) | Not a person name. Keep, or rename before the publish step. |
| F7 | Pepper for the private word hashes | `privacy/denylist.hashes.json` | Pepper set locally, hashes committed (2026-11-12, #252); CI secret pending with F8. The pepper is in the owner's git-ignored `.env` and in a file outside the repository; the plain list is in the git-ignored `.privacy-denylist.txt`. Hosted CI has no `PRIVACY_PEPPER` secret yet, so there the check prints a warning and skips the private words. |
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
- `--history` on the private repository reports the commit metadata of F2 (categories `email` and `private-word`) and the old line of F3 (`ab4b044`, category `private-word`). This is expected until the history rewrite of F2. After the rewrite, `--history` must give no finding. `scripts/clean-publish.sh` runs `--history` on the new repository and stops on a finding.

## Publish

See `docs/public-release.md`. The owner does the publish step.
