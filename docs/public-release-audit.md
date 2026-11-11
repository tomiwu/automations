# Public release audit

Issue: #234, step 1 (audit). This file is the report only. It contains no real values: only file paths, line numbers, commit ids, counts and categories.

Date: 2026-11-11. Base: `main` at `93bd5b8`. Scope: all tracked files, all commit contents (`git log --all -p`, added lines), all commit messages and the commit metadata (author, committer, trailers).

## Method

- Secrets: `gitleaks` on the tree and on the full history (`scripts/ci-local.sh`, step "gitleaks (full history)"): 0 findings.
- Private words: the deny-list step of `scripts/ci-local.sh` with the local, git-ignored word list (`DENYLIST_FILE`), on the tree and on the full history: 0 findings. A second local list with more names (owner, children, teachers) found the matches in F1 and F3 only.
- Heuristics (a local scanner that prints only `path:line:category`): e-mail addresses, phone numbers, 26-digit account numbers (NRB / IBAN), IP addresses in private ranges, Telegram chat ids, URLs with a token in the query, Supabase project refs, JWTs. Documented example values are allowed (`example.com`, `example.org`, `example.test`, RFC 5737 addresses, loopback).
- The scanner is not in the repository yet. Step 4 of #234 adds the privacy gate with the same categories and hashed private words.

## Open findings

| ID | Category | Where | What | Fix (step of #234) |
|---|---|---|---|---|
| F1 | Personal name (owner) | `scripts/sandcastle-loop/src/config.ts:51` | The first name of the owner in a code comment. | Step 2: write "the owner". |
| F2 | Personal name and personal e-mail (owner), commit metadata | 121 commits (author name and a private e-mail address); 3 commit trailers (`Co-authored-by` with the same private e-mail) | Git metadata, not file content. | Step 3: the clean-publish script makes a new history with a neutral author (for example "The automations contributors" and a noreply address). Owner decision: single initial commit or a filtered history. |
| F3 | Personal name (owner), history content | commits `49e8a7a`, `ab4b044` (the line of F1 when it was added) | Same text as F1, in old commits. | Step 3 (the new public history does not contain it). |
| F4 | Owner handle in package names | npm scope `@tomiwu/*` and `kody:@tomiwu/*` imports in 49 files | The GitHub handle of the owner. It is public already, but it ties the project to one person. | Owner decision: keep the scope, or rename it (for example `@automations/*`) in step 2. |
| F5 | Owner-specific tooling and deploy | `.sandcastle/` (8 files), `scripts/sandcastle-loop/` (40 files), `.github/workflows/deploy-kody.yml` | The owner's agent loop (prompts, Containerfile, model order) and the deploy to the owner's Kody account. No secret values. | Step 5: keep as documented examples behind config, or leave them out of the public tree (owner decision). `.sandcastle/` is not changed by agents. |
| F6 | Bot / package name | `packages/kradziejka` and references (38 files) | A Polish nickname used as a bot and package name. It is not a person name, but it can be a private family word. | Owner decision: keep, or rename in step 2. |

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

## Next steps (sub-issues of #234)

1. Step 2, generic data: fix F1; owner decisions on F4 and F6.
2. Step 3, clean-publish script: a new repository from the cleaned tree with neutral commit metadata (F2, F3). Nothing is published by an agent.
3. Step 4, privacy gate: `scripts/privacy-check` with salted hashes of the private words, the heuristics above, a unit test with synthetic samples, a `privacy` step in `ci-local` and in `ci.yml`, and a pre-commit hook option.
4. Step 5, open source polish: README for other families, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, LICENSE check, F5.
