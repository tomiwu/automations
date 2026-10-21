# Run on Node

The code uses the `Runtime` interface, so plain Node 22 can run it. `nodeRuntime()` in `@automations/shared` is the Node implementation.

## What `nodeRuntime` does

- `secret(name)` reads `process.env[name]`. It rejects when the variable is not set.
- `fetch` is the global `fetch`.
- `now()` returns the current time. `log` writes to `stderr`.
- `schedule(schedule, task)` runs the task one time at once. A cron or a systemd timer must start the process at the times you want.

## Environment

Set these variables for the process:

| Variable | Use |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_KEY` | Access to the storage (key of the role `automations_watcher`) |
| `FAMILY_ID` | ID of the Family |
| Account secrets | One variable for each secret NAME in the `accounts` table, for example `CHILD1_LIBRUS_LOGIN` |
| `EDUSKY_CLIENT_SECRET` | Only for Edusky |

## Script

The repository has no Node entry file yet. Write a small script that builds the dependencies from `nodeRuntime()`, and give it a `Messenger` that sends to Telegram:

```ts
import { nodeRuntime } from "@automations/shared";
import { supabaseStorageFromRuntime } from "@automations/librus-data";
import { runLibrusWatch, type Messenger } from "@tomiwu/librus-watch";

const runtime = nodeRuntime();
const messenger: Messenger = {
  async send(chatId, text) {
    // Call the Telegram Bot API sendMessage method with runtime.fetch.
  },
};
const failures = await runLibrusWatch({
  runtime,
  storage: await supabaseStorageFromRuntime(runtime),
  familyId: await runtime.secret("FAMILY_ID"),
  messenger,
});
if (failures.length > 0) throw new Error(failures.join("; "));
```

Run it with `node --experimental-strip-types script.ts`. Start it at least twice a day, so the free Supabase project does not pause. Run the purge (`runPurge`) once a day.

The one-time import of a Kody export also runs on Node: see "Migration from Kody" in `packages/librus-data/README.md`.
