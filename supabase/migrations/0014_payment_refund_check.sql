-- 0014_payment_refund_check: the refund-check flag of a Payment (payments contract v0.2 section 3b, PC2).
-- payments-watch sets it once, when the Organizer no longer lists a charge that is already paid.
-- It is a projection field. No Journal event is made, and the status stays 'paid'.
-- The migration only adds a nullable column. It does not change or delete a row.
-- The migration can run more than once.

alter table payments add column if not exists refund_check_at timestamptz;
