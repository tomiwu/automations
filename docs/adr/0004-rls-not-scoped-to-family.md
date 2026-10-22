# 0004 RLS policies are not scoped to one Family

## Status

Accepted.

## Context

CONTEXT.md says that one deployment serves one Family. The policies in `0001_init.sql`, `0002_credentials.sql` and `0003_kradziejka.sql` use `using (true)` and `with check (true)`. The `automations_watcher` role can read and change the rows of all Families, also in `kradziejka_bots`.

A policy can check `family_id` only if the request carries a family claim. The watchers connect with one service key. The key has no family claim in its JWT. Migrations 0001 and 0002 have no claim check.

## Decision

- The policies stay `using (true)`. Migration 0004 is not added.
- The Family filter is only in code (`registry.ts` and the other repositories).
- The grants limit the role: no delete on `kradziejka_bots`, and read-only columns on `credentials`.

## Consequences

- One deployment must use one Supabase project for one Family. Do not put two Families in one project.
- A bug in the code filter can show rows of another Family only if the project holds more than one Family.
- If a deployment must serve more than one Family, issue a JWT with a `family_id` claim per Family. Then add policies that compare `family_id` with the claim, and add a test in `tools/sql-tests`.
