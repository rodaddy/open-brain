-- monthly-event-counts.sql
--
-- PROVES: the 2026-08 drop in ob_session_events (1062) against 2026-07 (7673)
-- is NOT a capture outage and NOT an embedding gap. It is two separate,
-- measurable mechanisms stacked on top of each other:
--
--   (1) JULY WAS INFLATED BY A ONE-TIME HISTORICAL BACKFILL.
--       5,080 of July's 7,673 events (66%) landed in the six-day window
--       2026-07-13..2026-07-18 from sources 'codex-session-finalization' and
--       'claude-session-finalization', carrying metadata lifecycle
--       'session-end' and event_type 'handoff'. Their CONTENT is May/June
--       session logs ("Finalized codex session for king-capital.
--       {"timestamp":"2026-05-12T01:55:53...}"), so they are imported history
--       written on one date, not July activity. Strip that window and July
--       is 2,593 organic events -- the same order of magnitude as August.
--
--   (2) THE VOLUME MOVED TO ob_raw_turns, AND THE DISTILLER NEVER RAN FOR
--       NAMESPACE 'rico'. ob_raw_turns did not exist before 2026-07-25. It
--       then took over the raw-prompt capture that source='shared' had been
--       writing into ob_session_events: 'shared' collapses from 220/day
--       (2026-07-31) to 25 (08-01) and effectively 0 after 2026-08-04,
--       exactly as raw_turns scales to 7k-13k/day. Raw capture ROSE 4x
--       (40,805 in July -> 156,653 in August), so nothing stopped capturing.
--
--       What fell is distillation, and query 7 shows it is namespace-scoped,
--       not a general outage. maintenance_jobs holds 391 'memory.distill'
--       jobs, ALL of them 'succeeded', for namespaces geetesh (177), lisa
--       (147), kevin (64) and admin (3) -- and ZERO for 'rico'. Accordingly
--       every other namespace is 100% distilled (lisa 2377/2377, geetesh
--       250/250, kevin 176/176, admin 9/9) while 'rico' sits at 5,028 of
--       194,483 = 2.6%, leaving a 189,455-turn undistilled backlog. The
--       5,028 rico turns that ARE distilled were done by the pre-queue path
--       before the cliff on capture day 2026-07-28 (128) -> 2026-07-29 (0);
--       the queue-based distiller only starts on 2026-08-08 and has never
--       been enqueued for the namespace that holds 98.5% of the turns.
--
-- READ-ONLY. Run with:
--   set -a; . ./.env; set +a
--   psql -At -f scripts/done-means/monthly-event-counts.sql

\echo '== 1. monthly ob_session_events (the reported drop) =='
select date_trunc('month', created_at)::date as month,
       count(*)                              as events,
       count(embedding)                      as with_embedding
  from ob_session_events
 group by 1
 order by 1;

\echo '== 2. cause (1): July minus the 07-13..07-18 historical backfill window =='
select date_trunc('month', created_at)::date as month,
       count(*)                                                            as total,
       count(*) filter (where created_at::date between '2026-07-13'
                                                   and '2026-07-18')       as backfill_window,
       count(*) filter (where created_at::date not between '2026-07-13'
                                                       and '2026-07-18')   as organic
  from ob_session_events
 group by 1
 order by 1;

\echo '== 3. cause (1) attribution: the backfill sources and their lifecycle marker =='
select date_trunc('month', created_at)::date as month,
       coalesce(source, '(null)')            as source,
       coalesce(metadata->>'lifecycle', '(none)') as lifecycle,
       event_type,
       count(*)
  from ob_session_events
 where source in ('codex-session-finalization', 'claude-session-finalization')
 group by 1, 2, 3, 4
 order by 1, 5 desc;

\echo '== 4. cause (2): capture ROSE while distillation FELL =='
select date_trunc('month', created_at)::date as month,
       count(*)                              as raw_turns,
       count(distilled_at)                   as distilled,
       round(100.0 * count(distilled_at) / count(*), 2) as pct_distilled
  from ob_raw_turns
 group by 1
 order by 1;

\echo '== 5. cause (2) cliff: distillation per capture day, 128 -> 0 on 2026-07-29 =='
select created_at::date as capture_day,
       count(*)         as raw_turns,
       count(distilled_at) as distilled
  from ob_raw_turns
 group by 1
 order by 1;

\echo '== 6. cause (2) migration: source=shared dies as ob_raw_turns takes over =='
with shared_events as (
  select created_at::date as day, count(*) as n
    from ob_session_events
   where source = 'shared'
   group by 1
), raw as (
  select created_at::date as day, count(*) as n
    from ob_raw_turns
   group by 1
)
select coalesce(shared_events.day, raw.day) as day,
       coalesce(shared_events.n, 0)         as shared_events,
       coalesce(raw.n, 0)                   as raw_turns
  from shared_events
  full join raw on shared_events.day = raw.day
 order by 1;

\echo '== 7. ROOT CAUSE: distillation is namespace-scoped and rico is never enqueued =='
select 'raw_turns' as relation,
       namespace,
       count(*)            as turns,
       count(distilled_at) as distilled,
       round(100.0 * count(distilled_at) / count(*), 2) as pct_distilled
  from ob_raw_turns
 group by 1, 2
having count(*) > 5
 order by turns desc;

\echo '== 7b. memory.distill jobs by namespace -- note rico is absent entirely =='
select namespace, state, count(*), min(created_at)::date as first_job, max(created_at)::date as last_job
  from maintenance_jobs
 where job_kind = 'memory.distill'
 group by 1, 2
 order by 3 desc;
