-- 0010_outbox_keep: Outbox rows are kept forever (#154).
-- The daily-purge job is gone. Remove its delete policy and the delete grant,
-- so the role automations_watcher cannot delete any Outbox row.

drop policy if exists watcher_purge on outbox;
revoke delete on outbox from automations_watcher;
