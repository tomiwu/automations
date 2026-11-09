-- 0011_journal_payment_kind: allow the kind 'payment' in journal_events (ADR 0006).
-- The migration replaces the check constraint on kind. It does not change or
-- delete a row. The migration can run more than once.

alter table journal_events drop constraint if exists journal_events_kind_check;
alter table journal_events add constraint journal_events_kind_check
  check (kind in ('lesson', 'homework', 'session', 'check',
    'meeting', 'dayOff', 'trip', 'terminarz', 'announcement', 'message', 'grade', 'payment'));
