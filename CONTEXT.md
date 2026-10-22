# Context: words

- **Family**: One group of Children and Recipients. One deployment serves one Family.
- **Child**: One pupil, with a name, `has_librus` and a `calendar_id`.
- **Account**: The login of a Child at a Service. It holds secret NAMES, never secret values.
- **Service**: An external app: `librus`, `activenow`, `edusky`, `mondo`.
- **Activity**: A recurring class after school.
- **Watcher**: A job that reads a Service and records new Items.
- **Item**: One fact that a Watcher saw (grade, message, lesson, session).
- **Outbox**: The queue of Notifications. An Outbox entry is for one Recipient.
- **Notifier**: The job that delivers Outbox entries to Telegram.
- **Recipient**: One Telegram chat with a language and a list of Children.
- **StorageAdapter**: The interface for Items, the Outbox and config reads.
- **Runtime**: The interface for fetch, secrets, time, logs and schedules.
- **Registry**: The Supabase table `kradziejka_bots`. One row is one Grok bot.
- **Hub**: The registry row with slug `hub`. Unclear messages go to the hub.
- **Allowlist**: The Telegram user IDs that `kradziejka` accepts. An empty list accepts no one.

Avoid: "user" for Recipient, "event" for Item, "queue" for Outbox.
