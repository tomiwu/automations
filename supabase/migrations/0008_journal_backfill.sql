-- 0008_journal_backfill: copy the item_details rows into journal_events.
-- Each Item is one stream. Each content of the Item is one event.
-- Nothing is deleted from item_details. A second run adds no row.
-- The migration can run more than once.

create or replace function journal_backfill_items() returns integer
language sql
as $$
  with pending as (
    select d.*,
      'item:' || d.scope || ':' || d.source_id as stream_id
    from item_details d
    where not exists (
      select 1 from journal_events j
      where j.family_id = d.family_id
        and j.stream = 'item:' || d.scope || ':' || d.source_id
        and j.content_hash = d.content_hash
    )
  ),
  numbered as (
    select p.*,
      coalesce((
        select max(j.seq) from journal_events j
        where j.family_id = p.family_id and j.stream = p.stream_id
      ), 0) + row_number() over (
        partition by p.family_id, p.stream_id
        order by p.first_seen, p.content_hash
      ) as new_seq
    from pending p
  ),
  inserted as (
    insert into journal_events (family_id, child_id, stream, seq, kind, day, event_type, payload, content_hash, recorded_at, source)
    select n.family_id, n.child_id, n.stream_id, n.new_seq, n.kind, n.date,
      case when n.new_seq = 1 then 'ItemRecorded' else 'ItemChanged' end,
      jsonb_build_object(
        'scope', n.scope,
        'sourceId', n.source_id,
        'kind', n.kind,
        'childId', n.child_id,
        'date', to_char(n.date, 'YYYY-MM-DD'),
        'startTime', to_char(n.start_time, 'HH24:MI'),
        'endTime', to_char(n.end_time, 'HH24:MI'),
        'title', n.title,
        'text', n.text,
        'sender', n.sender,
        'subject', n.subject,
        'category', n.category,
        'sourceUpdatedAt', to_char(n.source_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      n.content_hash, n.first_seen, 'backfill-0008'
    from numbered n
    returning 1
  )
  select count(*)::integer from inserted
$$;

revoke all on function journal_backfill_items() from public;

select journal_backfill_items();
