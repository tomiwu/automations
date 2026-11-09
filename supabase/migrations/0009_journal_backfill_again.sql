-- 0009_journal_backfill_again: copy the item_details rows that the old code wrote between 0008 and the deploy.
-- The function journal_backfill_items() is from 0008. A second run adds no row.

select journal_backfill_items();
