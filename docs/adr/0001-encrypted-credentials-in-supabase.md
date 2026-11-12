# 0001 Service credentials and routine keys are AES-256-GCM ciphertext in Supabase

## Status

Accepted.

## Context

Kody accepts only literal secret names. One Kody secret cannot hold one value for each Account or each bot. New Accounts must need no code change and no new Kody secret.

## Decision

- Service logins are rows in the Supabase table `credentials`. They are AES-256-GCM ciphertext.
- The table `kradziejka_bots` (of the suspended kradziejka package, removed from the code in #254; the table stays in the database) used the same ciphertext format.
- The packages keep one key, `credentialKey`. The owner sets it with `./configure`.
- The Kody secrets are only literal names, for example `SUPABASE_KEY`.
- The owner adds or changes a credential with `admin set-credential` on their own computer. An agent never sees the value.

## Consequences

- A new Account or bot needs no Kody secret.
- The owner must keep `credentialKey` in a password manager.
- The owner rotates the key with `admin rotate-credential-key`, then calls `./configure` again.
- The repository holds no credential and no key.
