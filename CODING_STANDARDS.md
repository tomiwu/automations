# Coding standards

- TypeScript, strict mode. Node 22. ES modules.
- Write code, comments, docs and commit messages in English. Use ASD-STE100 Simplified Technical English.
- No personal data anywhere: no real names, schools, e-mail addresses, chat IDs or local paths. Fixtures use invented data (`Child One`, `Example School`, chat ID `1000001`).
- Secret values never appear in code, tests or the database. Use secret names only.
- Every function has a CRAP score less than 6. Keep functions small and tested.
- Tests do not use the network. Use fakes.
- Watcher code imports the `Runtime` interface, never `kody:runtime` directly.
- No user-facing text in watcher code. Put it in the i18n catalogs.
- Do not add a dependency if Node 22 can do the task.
