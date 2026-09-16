-- The latest fully settled hour, as a canonical read of its own.
--
-- `GET /v1/grid/now` opened by asking the question every observed panel on the
-- Overview depends on: *which is the most recent hour ONS has settled in all
-- four subsystems?* It asked it by grouping the whole of
-- `canonical_curtailment_by_reporting_entity` — the deduplicated fact view — by
-- `valid_time` and taking the newest group with four subsystems in it.
--
-- That is the correct question asked in the one way that forces a sort of the
-- entire table: the fact view carries `DISTINCT ON (reporting_entity_code,
-- technology, valid_time) ORDER BY ..., ingested_at DESC, data_version DESC`,
-- and no index serves that ordering, so the deduplication had to complete
-- before the grouping could begin. Measured against a reproduction at 864,000
-- rows — production carries more — the plan was a sequential scan plus an
-- `external merge` sort spilling 42 MB to disk, at **1,026 ms**. Railway's own
-- proxy log put the deployed endpoint at **8.4-9.7 seconds** on every request
-- that missed the 60-second CDN cache, and it is the first call the Overview
-- makes: that was the wait before any panel could render.
--
-- The view below answers the same question in **1.3 ms** on the same data. An
-- `Index Scan Backward` over `curtailment_report_hour_time` — which already
-- exists — feeds a `GroupAggregate` that the `LIMIT 1` stops at the first
-- qualifying hour: 751 rows read instead of 864,000. No new index, no new
-- column, no change to any stored value.
--
-- **Why it may skip the deduplication, which is the only interesting part.**
-- `DISTINCT ON` chooses one row per business key; it never removes a key
-- entirely. So the set of (`valid_time`, `subsystem`) pairs is identical either
-- side of it, and a `count(distinct subsystem)` per `valid_time` cannot differ
-- between the two formulations. That argument was checked rather than asserted:
-- against superseding `data_version` rows, against rows ingested earlier than
-- their siblings, against a newest hour carrying only two subsystems that must
-- not be chosen, and at three `as_of` cuts including one before any ingest. The
-- two formulations agreed on every case, `null` included.
--
-- **It is a canonical read, not a shortcut past one.** The rule that a product
-- read never reaches into an ingest table stands: this view *is* the canonical
-- layer, it applies `canonical_as_of()` exactly as its siblings do, and
-- `contract/grid-now.ts` selects from it by name. What changed is that the
-- canonical layer now publishes the read the product needed, instead of the
-- product assembling it out of a view shaped for a different question.
--
-- The subsystem count is read from the enum rather than written as `4`. Four is
-- a fact about the Brazilian grid and `subsystem_code` already states it;
-- spelling it again here would be a second statement free to disagree with the
-- first.

CREATE VIEW "public"."canonical_latest_complete_settled_hour" AS (
  select c.valid_time
  from curtailment_report_hour c
  join reporting_entity e on e.ons_code = c.reporting_entity_code
  where c.ingested_at <= canonical_as_of()
  group by c.valid_time
  having count(distinct e.subsystem)
       = (select count(*) from unnest(enum_range(null::subsystem_code)))
  order by c.valid_time desc
  limit 1
);