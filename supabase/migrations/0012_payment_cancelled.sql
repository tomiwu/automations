-- 0012_payment_cancelled: allow the status 'cancelled' in payments (payments contract v0.2, PaymentCancelled).
-- The migration only widens the status check. It does not change or delete a row.
-- The migration can run more than once.

alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('pending', 'paid', 'skipped', 'cancelled'));
