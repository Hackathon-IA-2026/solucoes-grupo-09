DROP VIEW "public"."canonical_curtailment_by_reporting_entity";--> statement-breakpoint
CREATE VIEW "public"."canonical_curtailment_by_reporting_entity" AS (
  select distinct on (c.reporting_entity_code, c.technology, c.valid_time)
    c.reporting_entity_code,
    e.kind as reporting_entity_kind,
    e.name as reporting_entity_name,
    e.subsystem,
    c.technology,
    c.valid_time,
    c.constrained_off_mwh,
    c.verified_generation_mwh,
    c.reference_generation_mwh,
    c.final_reference_generation_mwh,
    c.available_capacity_mw,
    c.half_hours_observed,
    c.reason as restriction_reason,
    c.origin as restriction_origin,
    c.restriction_description,
    (c.cause_mixed = 1) as restriction_cause_mixed,
    c.data_version,
    c.published_at,
    c.ingested_at
  from curtailment_report_hour c
  join reporting_entity e on e.ons_code = c.reporting_entity_code
  where c.ingested_at <= canonical_as_of()
  order by c.reporting_entity_code, c.technology, c.valid_time,
           c.ingested_at desc, c.data_version desc
);--> statement-breakpoint
-- `CurtailmentEpisode`, as a parameterised function — because it is a **view of
-- the hours**, not a table of its own.
--
-- `docs/domain-model.md` §5 is explicit that nothing is ever stored at episode
-- grain: persisting a run would freeze one threshold into the database and let
-- two screens disagree about what an episode is. So the threshold and the gap
-- tolerance are arguments, every row the function returns is recomputed from
-- the hours, and `GET /v1/curtailment/episodes` stamps the two arguments on
-- every episode it returns.
--
-- It reads `canonical_curtailment_by_reporting_entity` and no base table, so it
-- inherits the `AsOf` pick and **requires the same axis**: with
-- `wattsteer.as_of` unset, `canonical_as_of()` raises 22023 from in here just as
-- it does from a direct read. It lives in SQL rather than in TypeScript for the
-- same reason the reads do — `apps/ml` must be able to ask the same question
-- and get the same answer without a second implementation of the rule.
--
-- The rule, stated once:
--
--  * An hour is **in** an episode when the subsystem's total constrained-off
--    for that hour is **at or above** the threshold. The comparison is MWh in a
--    one-hour bucket against MW, which is the same number: an hour's MWh is its
--    mean MW.
--  * Two such hours belong to the same episode when at most `p_max_gap_hours`
--    hours separate them. An hour that is **below** threshold and an hour that
--    was **never observed** are treated identically here, and deliberately: an
--    unobserved hour is an absence, and continuity across it cannot be
--    asserted. At the default gap of 0, either one ends the episode.
--  * `ended_at` is **exclusive** — the valid_time of the first hour that is not
--    in the episode, which for a contiguous run is the last hour plus one.
--  * `total_mwh` and `peak_mw` are taken over the hours that were **observed
--    inside `[started_at, ended_at)`**, gap hours included, so that they share
--    one denominator with `duration_hours` rather than quietly using two. An
--    hour with no row contributes nothing to the sum and is not a zero.
CREATE OR REPLACE FUNCTION canonical_curtailment_episodes(
  p_subsystem subsystem_code,
  p_from timestamptz,
  p_to timestamptz,
  p_threshold_mw double precision,
  p_max_gap_hours integer,
  p_technology technology DEFAULT NULL
) RETURNS TABLE (
  started_at timestamptz,
  ended_at timestamptz,
  duration_hours integer,
  total_mwh double precision,
  peak_mw double precision
) LANGUAGE sql STABLE AS $$
  with hourly as (
    select valid_time, sum(constrained_off_mwh) as mwh
    from canonical_curtailment_by_reporting_entity
    where subsystem = p_subsystem
      and valid_time >= p_from
      and valid_time < p_to
      and (p_technology is null or technology = p_technology)
    group by valid_time
  ),
  above as (
    select valid_time, mwh from hourly where mwh >= p_threshold_mw
  ),
  marked as (
    select
      valid_time,
      case
        when lag(valid_time) over (order by valid_time) is null
          or valid_time - lag(valid_time) over (order by valid_time)
             > make_interval(hours => p_max_gap_hours + 1)
        then 1 else 0
      end as starts_episode
    from above
  ),
  runs as (
    select
      valid_time,
      sum(starts_episode) over (
        order by valid_time rows between unbounded preceding and current row
      ) as episode_id
    from marked
  ),
  bounds as (
    select
      episode_id,
      min(valid_time) as started_at,
      max(valid_time) + interval '1 hour' as ended_at
    from runs
    group by episode_id
  )
  select
    b.started_at,
    b.ended_at,
    (extract(epoch from (b.ended_at - b.started_at)) / 3600)::int as duration_hours,
    sum(h.mwh) as total_mwh,
    max(h.mwh) as peak_mw
  from bounds b
  join hourly h
    on h.valid_time >= b.started_at and h.valid_time < b.ended_at
  group by b.episode_id, b.started_at, b.ended_at
  order by b.started_at
$$;
