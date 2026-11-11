# privacy-check

The privacy gate of the repository. It finds personal data and tokens in the tracked files, in a diff, in the staged changes and in the full git history. It prints `place:line:category` for each finding. It never prints a value.

## Commands

- `npm run privacy` checks the tracked files (`--tree`, the default).
- `npm run privacy -- --diff origin/main` checks the lines that the branch adds.
- `npm run privacy -- --staged` checks the staged lines (the pre-commit hook uses it).
- `npm run privacy -- --history` checks every commit of every ref: the author and committer lines, the commit message and the added lines.
- `npm run privacy -- --repo <dir>` checks another repository. You can give more than one mode in one call.
- `npm run privacy:hash` writes `privacy/denylist.hashes.json` from the plain private word list.

Exit code: 0 for no finding, 1 for findings, 2 for a usage error.

`npm run check` and `scripts/ci-local.sh` (step `privacy`) run the same check.

## Private words (hashed deny-list)

The repository holds only salted hashes of the private words: `privacy/denylist.hashes.json`. The plain list stays on your computer.

1. Write the private words to `.privacy-denylist.txt` in the repository root (git-ignored), one entry for each line. A line that starts with `#` is a comment. You can also set `DENYLIST_FILE` or give `--in <file>`.
2. Run `npm run privacy:hash`. It prints only counts.
3. Commit `privacy/denylist.hashes.json`.

How the hash works:

- Each entry is normalized: lower case, Polish diacritics removed, camel case split, split on every character that is not a letter or a digit.
- An entry of one word gets the Polish case endings (`src/inflect.ts`). The heuristic gives many forms. If a form is missing (for example a diminutive), add it to the plain list as a new line.
- An entry of two or more words is one phrase. Add each form of the phrase as a line.
- The hash is HMAC-SHA256 with the salt of the file and the optional `PRIVACY_PEPPER`.
- The check hashes each token and each sequence of tokens (up to the longest entry) of each line. A match is a `private-word` finding. Tokens of less than 3 characters are ignored.

Limit: the salt is in the repository. A person who guesses a word can check the guess, and first names are easy to guess. For a public repository, set the secret `PRIVACY_PEPPER` (in the CI secrets and in your `.env`) before you run `npm run privacy:hash`. Then nobody can check a guess without the pepper. When the hashes need the pepper and it is not set, the check prints a warning and skips the private words. With `--require-words` it fails.

## Heuristics

| Category | What it finds | Allowed example values |
|---|---|---|
| `email` | E-mail addresses | `example.com`, `example.org`, `example.net`, `*.example`, `*.test`, `*.invalid`, `noreply@...`, `*@users.noreply.github.com`, the `git@github.com` URL user |
| `phone` | A number with a country code, or a national number in three groups of 3 digits | none |
| `iban` | An IBAN, or 26 digits (Polish account number), only with a valid mod-97 checksum | numbers with a wrong checksum |
| `private-ip` | Addresses in `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16` | loopback and the RFC 5737 ranges are not private ranges |
| `telegram-chat-id` | A number of 6 or more digits next to a `chat id`, `sender id` or `telegram id` key, and `-100` supergroup ids | `1000000` to `1000999` |
| `url-token` | A URL with `token`, `key`, `secret`, `signature`, `password` or `auth` in the query | placeholders (`<...>`, `${...}`, `example`, `your...`) and values of less than 8 characters |
| `telegram-bot-token`, `jwt`, `supabase-ref` | A bot token, a JSON Web Token, a Supabase project host | `example.supabase.co` and other short names |

`privacy/allowlist.json` holds the other documented example values:

- `paths`: files that the check skips (a path that ends with `/` is a directory). Now only `package-lock.json`.
- `values`: exact synthetic values that are allowed, for example the public example account number of the tests.

Do not add a real value to the allowlist. Change the fixture to a synthetic value.

## Pre-commit hook

```sh
scripts/install-hooks.sh
```

`scripts/install-hooks.sh` sets `core.hooksPath` to `scripts/hooks` for the clone and all its worktrees. `scripts/hooks/pre-commit` runs gitleaks on the staged changes, then `--staged`, then the typecheck of the workspaces with a staged file. A finding stops the commit. `--no-verify` is not allowed. `scripts/hooks/pre-push` runs the full `scripts/ci-local.sh` on each commit of a push. See `CONTRIBUTING.md`.

## Tests

`npm test -w @automations/privacy-check`. The positive samples are synthetic and the tests build them at run time, so the test files have no finding. The tests prove that the check fails when a synthetic private word, e-mail address, phone number or token is added, and that `scripts/clean-publish.sh` makes a repository with no finding in its tree and history. They prove that `scripts/hooks/pre-commit` stops a commit on a gitleaks finding, a privacy finding or a failed typecheck, and that `scripts/install-hooks.sh` makes the hook run in every worktree. The hook tests use a stub gitleaks program. The cases with the real gitleaks program run only on a computer that has it. They also prove that every tracked file in `examples/` is in the scope of the tree check, has no finding, and that `examples/README.md` names the rule for example values.
