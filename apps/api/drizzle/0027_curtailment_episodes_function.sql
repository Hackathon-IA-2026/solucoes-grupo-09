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
