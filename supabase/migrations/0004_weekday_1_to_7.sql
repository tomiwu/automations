-- 0004_weekday_1_to_7: activities.weekday uses 1 = Monday to 7 = Sunday.
-- The packages read this scale. The old check accepted 0 to 6, so Sunday could not be stored.
-- An old row with weekday 0 was meant as Sunday. The migration changes it to 7.
-- Rows with 1 to 6 do not change. The migration can run more than once.

alter table activities drop constraint if exists activities_weekday_check;
update activities set weekday = 7 where weekday = 0;
alter table activities add constraint activities_weekday_check check (weekday between 1 and 7);
