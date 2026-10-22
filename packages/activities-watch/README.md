# @tomiwu/activities-watch

The ActiveNow, Edusky and Mondo Watchers, the `sessions` export, the after-school section of the Morning report, and the mail comparison.

## How it works

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
- A failed Account queues one failure Notification a day for each Recipient of the Child (`failure:<account id>:<day>:<chat id>`).
- At the end, `deliverPending` of `@tomiwu/librus-watch` sends the Outbox through the `Messenger` port.
- Each run reads the config, so each run is also the keepalive read of Supabase.

## Entry files

Only `src/entry/*` imports the Kody runtime and the Kody `telegram` package.

| Export | Result |
| --- | --- |
| `./scheduled` | One scheduled pass. It takes no input. It rejects when something failed. |
| `./sessions` | No input. `{ sessions, errors }`: every Session of every Child for the next 14 days, ordered by start. |
| `./after-school` | `{ childId, day, language? }`. `{ text }`: the after-school section of one Child. |

Each Session has `childId` and the name of the Child (`child`).
The Supabase URL and the Family ID are plain config set with `./configure` (`{ supabaseUrl, familyId }`). The secret `SUPABASE_KEY` gives access to the storage.
The secret `EDUSKY_CLIENT_SECRET` holds the client secret that the Edusky web app sends to log in. The repository does not hold it.

## After-school section and mail comparison

- `createAfterSchool(deps)` makes the `afterSchool` port of the Morning report of `@tomiwu/librus-watch`. It reads only the Accounts of the Child.
- `compareWithMail(sessions, facts)` is pure. A `MailFact` pairs with a Session by Child, Activity and day. A stated field that differs gives `warning: "mail differs"` and one `MailDifference` with a stable `key` and a `text(language)` function. The app wins: no Session value changes. The agent reads the mails and queues the Notifications.

## Not verified

`UNVERIFIED`: no move was seen in a live Mondo account, and no cancellation or move in a live ActiveNow or Edusky account. Check the status rules on the first real cancellation and move.
The schedule is in `package.json` (`kody.jobs`). Its time zone must be the time zone of the Family.
