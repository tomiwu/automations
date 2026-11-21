-- 0016_journal_attachment_kind: allow kind 'attachment' in journal_events (#263).
-- The migration can run more than once.

alter table journal_events drop constraint if exists journal_events_kind_check;
alter table journal_events add constraint journal_events_kind_check
  check (kind in ('lesson', 'homework', 'session', 'check',
    'meeting', 'dayOff', 'trip', 'terminarz', 'announcement', 'message', 'grade', 'payment', 'attachment'));