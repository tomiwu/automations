# Coding standards for the Sandcastle agents

Read `CODING_STANDARDS.md` in the repository root first. These rules add to it.

- Write all code, comments and commit messages in English. Use ASD-STE100 Simplified Technical English: short sentences, active voice, one instruction in each sentence.
- Use the words in `CONTEXT.md` (Family, Child, Account, Watcher, Item, Outbox, Notifier, Recipient). Do not use the words in the "Avoid" line.
- Follow the ADRs in `docs/adr/`. If a change does not agree with an ADR, stop and write a comment on the issue.
- The repository uses npm workspaces with one root `package-lock.json`. Each workspace has its own `package.json`, `tsconfig.json` and `vitest.config.ts`, and the scripts `typecheck`, `test` and `crap`.
- Every function must have a CRAP score less than 6 (`npm run crap`). Keep functions small and tested.
- Tests do not use the network. Use fakes for Librus, Telegram, Supabase, Kody and the service apps.
- Do not add a dependency if the platform or Node 22 can do the task.
- No personal data. Fixtures use invented data only.
