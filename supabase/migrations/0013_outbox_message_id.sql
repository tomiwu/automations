-- 0013_outbox_message_id: the Telegram message ID of a sent Outbox message (payments contract v0.2 section 3b, PC4).
-- The ID is a delivery field of the Outbox, like delivered_at. It is not in the Journal.
-- The migration only adds a column. It does not change or delete a row.
-- The migration can run more than once.

alter table outbox add column if not exists message_id bigint;

grant update (message_id) on outbox to automations_watcher;
