# @tomiwu/activities-watch

The ActiveNow, Edusky and Mondo Watchers, the `sessions` export, the after-school section of the Morning report, and the mail comparison.

## How it works

- The package entry also exports `openActiveNowPanel`, `checked`, `isActiveNowBlock`, `createHttp` and their types. `@tomiwu/payments-watch` uses them to read the ActiveNow Rozliczenia page on an existing login session.
- `runActivitiesWatch` loads the config with `loadConfig`. It validates it with `validateConfig`.
- It runs each enabled `activenow`, `edusky` and `mondo` Account. A bad Account gives one error. The other Accounts still run.
- Secret values come from `Runtime.secret(account.login_secret)` and `Runtime.secret(account.password_secret)`.
- The Sessions of an Account are named by its first enabled Activity. The `place` of the Activity is the place when the app gives none. An Account without an enabled Activity gives an error.
- `Account.origin` is the address of the app (for Mondo, the address of the parent panel). For Edusky it is the address of the organizer.
- `Account.group` has a different meaning for each Service:
  - ActiveNow: the name of the profile of the Child. It is needed when one login serves several Children.
  - Edusky: the text of the group name in the app. It is needed when one login lists the groups of several Children.
  - Mondo: the text of the Child in the child picker of the parent panel. An Account without a group uses the name of the Child. A Mondo class has no ID in the Session, so the Item ID uses the start of the class. A new time is a new Item. The badges `Odwołane`/`Anulowane` give `cancelled`. The badges `Przeniesione` and `zmiana terminu` give `moved`.
- The Items of one Account have the scope `<service>:<account id>`. The first run of a scope is a silent Baseline. The record `__baseline__` marks a scope as baselined, also when the app gave no Session.
- The Item ID is `<activity id>:<day before any move>:<start time>`, with a hash of status, time and place. Only an updated Item that is now `cancelled` or `moved` queues a Notification, for each Recipient that has the Child in `child_ids`. The text comes from the pl/en catalogs in the language of the Recipient. The Outbox key is `<scope>:<item>:<chat id>`.
- A change that starts in 24 hours or less gets the prefix of `session.urgent`.
- ActiveNow checks the status of every response. A 403 with the block page gives the error `access temporarily blocked by ActiveNow`. Any other failing status gives `HTTP <status> from <path>`. "login form not found" means status 200 without a token. A Watcher never retries a request: a retry after a 403 makes the block longer.
- ActiveNow Sessions are cached per Account in the package storage (`activenow-cache:<account id>`). ActiveNow is fetched at most once in the TTL (default `ACTIVENOW_CACHE_TTL_MS`, 24 hours), counted from the last attempt. Set `activenowCacheHours` with `./configure` to change it. A failed or empty fetch (also a 403 block) keeps the last good Sessions, records the attempt and gives the cached Sessions with the error. The log has one line for each Account: `activenow: fetched` or `activenow: cached (next fetch after <iso>)`.
- Fetch reserve: the package keeps its weekly fetch count in the package storage (`fetch-ledger`). When the budget is below `fetchReserve` (`./configure`, default 150), a scheduled pass does not fetch ActiveNow again for an Account with a cache and logs `budget reserve: skipped activenow refresh`. See `docs/kody-deploy.md`.
- The `sessions` export also gives `accounts`: for each Account `{ accountId, service, cached, fetchedAt }`. `cached: true` means the Sessions come from the cache.
- A failed Account queues one failure Notification a day for each Recipient of the Child (`failure:<account id>:<day>:<chat id>`).
- After all Accounts, `appendSessionsJournal` appends the Session Journal events once, from the Sessions that the run read already (no new app request). A failed Account gives no event and no `SessionVanished`. A failure gives the failure text `journal: <message>`.
  - Stream `session:<child id>:<session id>`, kind `session`, source `activities-watch`. The payload is `{ accountId, service, activity, start, end, place, status, warning }`.
  - Types: `SessionScheduled`, `SessionCancelled`, `SessionMoved`, `SessionRestored`, `SessionChanged`, `SessionVanished`. The vanish scope is the next 14 days of the Accounts that did not fail.
  - Each Account that did not fail also gets one `CheckCompleted` event in `check:activities-watch:<account id>`.
  - Supabase use: two `listHeads` reads and one `appendEvents` call for the whole run. The log has only the counts.
- At the end, `deliverPending` of `@tomiwu/librus-watch` sends the Outbox through the `Messenger` port.
- Each run reads the config, so each run is also the keepalive read of Supabase.

## Entry files

Only `src/entry/*` imports the Kody runtime and the Kody `telegram` package.

| Export | Result |
| --- | --- |
| `./scheduled` | One scheduled pass. It takes no input. It rejects when something failed. |
| `./sessions` | No input. `{ sessions, errors }`: every Session of every Child for the next 14 days, ordered by start. |
| `./stored-sessions` | `{ childId?, from?, to? }`. `{ timezone, from, to, accounts, sessions, fetches }`: the Sessions as the Journal stores them, ordered by start, with `lastSavedAt` of each Account (null before the first save). Each Session and Account has `childId` (the Journal `child_id`). `from` defaults to today, `to` to `from` + 13 (at most 60 days). Vanished Sessions stay with `vanished: true`. It reads Supabase only (3 fetches at most): no app login. |
| `./after-school` | `{ childId, day, language? }`. `{ text }`: the after-school section of one Child. |
| `./activenow-billing-shape` | No input. `{ accounts, fetches? }`: redacted skeleton of the ActiveNow billing page per Account (read-only probe), with redacted `head` (scripts, preloads, import map keys), optional `upcoming` (source, path, skeleton), and the redacted final path after redirects. Stimulus code names stay; `mailto`, `tel`, e-mail and image file names are masked. Record ids in `id`, `class`, `name` and `for` values and in error paths are masked (`<n>`, `<id>`). |
| `./edusky-billing-shape` | No input. `{ accounts, fetches? }`: read-only probe of the shape of the Edusky billing data per Account. Each Account has `authShape`, `listSource` (`auth` or `list`), `listStatus`, `listShape`, `agreementCount`, `agreementStatus`, `agreementShape`, `balanceStatus` and `balanceShape` (JSON shapes: keys and type marks, no values; small status codes stay). Accounts with the same origin and login share one probe (`sameAs`). At most 6 requests for each probe; a Cloudflare challenge stops it. No id value, host or name in the result. |
| `./mondo-billing-shape` | No input. `{ accounts, fetches? }`: read-only probe of the Mondo parent panel per Account. Each Account has `nav` (same-origin paths of the panel, masked, links with an allowlisted `label` or `<text>`), `candidates` (up to 3 pages with a billing word: `path`, `status`, `finalPath`, `contentType`, `skeleton`) and the `skeleton` of the navigation area. At most 5 requests for each probe; HTTP 403 stops it. The child hash is masked (`<id>`). |

Each Session has `childId` and the name of the Child (`child`).
The Supabase URL and the Family ID are plain config set with `./configure` (`{ supabaseUrl, familyId }`). The secret `SUPABASE_KEY` gives access to the storage.
The secret `EDUSKY_CLIENT_SECRET` holds the client secret that the Edusky web app sends to log in. The repository does not hold it.

## The stored export

Use `./stored-sessions` for the calendar sync. It reads Supabase only. Do not use `./sessions` for the sync: it logs in to the apps. `./sessions` stays for manual use.

- **Input:** `{ childId?, from?, to? }`. `from` and `to` are `YYYY-MM-DD`. `from` is today by default. `to` is `from` + 13 days by default. The range is at most 60 days. Other keys are rejected.
- **Output:** `{ timezone, from, to, accounts, sessions, fetches? }`.
- Each Session has `id`, `stream`, `childId`, `child`, `activity`, `service`, `start`, `end`, `place`, `status`, `warning`, `vanished`, `seq` and `lastChanged`. A vanished Session stays in the result with `vanished: true`.
- Each entry of `accounts` has `accountId`, `childId`, `service` and `lastSavedAt`. `lastSavedAt` is the time of the last `CheckCompleted` event of the Account, or `null` before the first save. Use it to find stale data.
- **Fetches:** the config, the heads of the Sessions, and the heads of the check streams. This is 3 Supabase fetches at most. There is no app request.
- The journal step adds about 2 Supabase fetches for each pass (two `listHeads` reads and one `appendEvents` call for all Accounts).
- `journal_events` is append-only (see `packages/librus-data/README.md`).

## After-school section and mail comparison

- `createAfterSchool(deps)` makes the `afterSchool` port of the Morning report of `@tomiwu/librus-watch`. It reads only the Accounts of the Child.
- `compareWithMail(sessions, facts)` is pure. A `MailFact` pairs with a Session by Child, Activity and day. A stated field that differs gives `warning: "mail differs"` and one `MailDifference` with a stable `key` and a `text(language)` function. The app wins: no Session value changes. The agent reads the mails and queues the Notifications.

## Not verified

`UNVERIFIED`: no move was seen in a live Mondo account, and no cancellation or move in a live ActiveNow or Edusky account. Check the status rules on the first real cancellation and move.
The schedule is in `package.json` (`kody.jobs`). Cron is in UTC: `30 4,12 * * *` (04:30 and 12:30 UTC).
