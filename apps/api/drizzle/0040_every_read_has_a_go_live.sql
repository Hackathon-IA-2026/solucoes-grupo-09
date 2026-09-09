-- Every canonical read has a go-live row, and the set is derived rather than
-- listed.
--
-- Hand-written, like `0012_canonical_read_axes.sql`,
-- `0016_the_feature_gate.sql`, `0039_the_gate_over_a_backfill.sql` and every
-- function migration in this tree, and for the same reason: drizzle-kit
-- generates tables and views, not function DDL. The view replacement below is
-- drizzle-kit's own output; everything around it is not.
--
-- ## The gap
--
-- `canonical_read_go_live` was a `union all` with one arm per read, written out
-- by hand: eight arms at `0013`, a ninth at `0024`. `canonical_plant_registry`
-- reads `plant_geo` under `canonical_as_of()` and stands behind every weather
-- feature through `canonical_capacity_weight`, and `plant_geo` was in no arm.
--
-- The cost was not a wrong number anywhere. It was that feature-engineering 16
-- could not narrow the feature horizon. `feature_ingestion_history_from()` was
-- the latest go-live across all nine reads, two of which — `curtailment-by-plant`
-- and `conjunto-membership` — no feature block reads; onboarding one of *those*
-- last stamped `revision_optimistic` on rows every source of which was live at
-- their gate. 16 measured that band (11,904 rows over 62 target dates in its
-- scenario C) and left the wide horizon standing anyway, because the wide
-- horizon was the only cover for the source that had no row at all. Narrowing
-- to the seven *named* reads would have dropped `plant_geo` off the stamp
-- entirely, which is the one direction that makes a row claim more than the
-- data supports.
--
-- ## The rule that replaced the list
--
-- `canonical_read_source()` walks the catalogue: every `canonical_*` view,
-- transitively through the views it reads, down to the base tables that carry an
-- `ingested_at` column. `canonical_read_go_live` is one aggregate over it.
--
-- The walk is `pg_depend` over each view's rewrite rule — the same edges
-- Postgres itself uses to refuse a `DROP TABLE`, so it cannot disagree with what
-- the view really reads. It is deliberately **not** a scan of
-- `pg_get_viewdef()`: this repository has been bitten five times by an
-- enumeration where discovery was needed, once by a comment stripper that ate
-- the code it was scanning, and a text scan of SQL would be the sixth.
-- `database-read-go-live.test.ts` derives the same closure a second way,
-- through `information_schema.view_table_usage`, and asserts the two agree pair
-- for pair — 18 read/source pairs, no difference in either direction.
--
-- Three consequences, each of which the hand-written union could not express:
--
-- 1. **A tenth read arrives with a row.** The test creates a table and a
--    `canonical_*` view over it inside a rolled-back transaction and asserts the
--    go-live row appears, with no edit to any list.
-- 2. **A read with two vintaged sources gets one go-live, the later of them** —
--    `docs/contracts/canonical-reads.md`'s weakest-link rule, at last applied
--    where reads compose. `plant-registry` is the first: `generating_unit` and
--    `plant_geo`. NULL if either has ingested nothing, because then there is no
--    honest instant.
-- 3. **A read with no ingestion axis behind it has no row**, rather than a NULL
--    one. `canonical_solar_centroid` reads the frozen geometry and
--    `canonical_subsystem_state` reads `plant`; neither carries an
--    `ingested_at`, and NULL here means "this source has ingested nothing",
--    which of a table with no ingestion axis is simply false. Those two reads
--    are the "shown not to need one" half of the acceptance criterion, and they
--    are shown by the rule rather than argued in prose.
--
-- Every one of the nine rows that existed before keeps its exact value: the
-- eight single-source reads are unchanged by construction, and
-- `installed-capacity` is too, because `canonical_installed_capacity`'s other
-- table — `plant` — has no `ingested_at`. Seven rows are new:
-- `plant-registry`, `capacity-weight`, `diagnosis-attribution`,
-- `diagnosis-driver`, `forecast-hour`, `forecast-day` and
-- `forecast-national-day`.
--
-- The view's own body reads two functions and no relation, so the catalogue
-- records no table behind it and the rule finds no source for it. It therefore
-- does not appear in its own output, and it does not appear by not being
-- excluded by name either.
--
-- ## What this let the feature side do
--
-- `feature_read_go_live()` is the weakest link over the sources a feature row
-- reads, and `feature_ingestion_history_from()` is now the horizon over those
-- same sources rather than over every canonical read. Both take the set from
-- `feature_source_go_live()`, which is discovery in the one place the catalogue
-- cannot help: a plpgsql body records no dependency on the views it reads, so
-- the set is the canonical views named in the `feature_%` functions' own
-- source, resolved to tables through `canonical_read_source()`. Measured, it is
-- eight tables — the seven `feature_rows` used to name one at a time, plus
-- `plant_geo`.
--
-- Two properties keep that honest, and both are tested rather than asserted:
--
-- - A false positive — a canonical view named in a *comment* inside a feature
--   function — widens the set, and a wider set is the strict direction: a later
--   horizon and an earlier weakest link. A false negative would be the unsafe
--   one, so it is measured directly: `database-features.test.ts` snapshots
--   `pg_stat_get_xact_numscans` across a real build and asserts that every
--   vintaged table the build actually scanned is in the derived set.
-- - The narrowing is only sound because the two unread reads are genuinely
--   unread. That is not taken on trust either: the same measurement asserts the
--   build scans neither `plant_detail_hour` nor `conjunto_membership`.
--
-- **The invariants `0039` bought are untraded.** `feature_rows` still accepts no
-- instant of any kind and neither does anything below it;
-- `published_at_or_before` is still the gate unconditionally, so a `gate_late`
-- feature still cannot read a run published after its own gate; and the
-- weakest-link stamp still binds at the last go-live among the sources a row
-- actually reads — over a set that is now complete rather than seven eighths of
-- one.
--
-- ## The measurement, because "can the horizon narrow now" is a count
--
-- Over the population feature-engineering 16 used — 1,096 target dates
-- (2024-01-01 .. 2026-12-31) x both gate profiles x 96 rows = 210,432 rows per
-- scenario — with both predicates computed from the server's own `gate_at`,
-- `feature_local_day_hours` and `feature_vintage_fidelity`, and only the go-live
-- vector varied:
--
--     scenario                                      rev-opt before  -> PIT   -> rev-opt
--     A  all sources in one sweep                          140,544       0         0
--     B  staggered, a source a feature reads last          169,536       0         0
--     C  staggered, conjunto-membership two months on      181,440  11,904         0
--     D  one sweep, conjunto-membership six hours behind   140,544       0         0
--     E  one sweep, plant_geo two months on                140,544       0    11,328
--     F  plant_geo has ingested nothing                    140,544       0    69,888
--
-- **Yes, it narrows, and by exactly the count 16 measured.** Scenario C is 16's
-- band and 11,904 over 62 target dates is 16's number: rows stamped
-- `revision_optimistic` although every source they read was live at their gate,
-- now `point_in_time`. The count is 96 x 2 x the target dates whose gate falls
-- in the band, which is why D moves nothing at all — a source six *hours* behind
-- opens a band no gate lands in, both profiles being D-1 wall-clock hours.
--
-- **E and F are the correction, and they matter more than C.** Those are rows
-- that were claiming `point_in_time` against a registry location cut which was
-- not live at their gate — 11,328 of them for a two-month SIGA onboarding gap,
-- and every row that had claimed it (69,888) where SIGA has ingested nothing.
-- Narrowing the horizon without first completing the set would have kept those
-- claims and removed their only cover. That is the trade 16 declined; this
-- migration is why it no longer has to be made.
--
-- ## What moves
--
-- `feature_hash` moves. `docs/specs/forecaster.md` hashes the ordered feature
-- names together with `pg_get_functiondef(feature_rows)`, and the seven named
-- lookups inside `feature_rows` become one derived call, so the definition
-- changes. **No column moves and none is added**: the row is the same 112
-- attributes in the same order, and the stamp is the only value that can differ.
-- The tree is already carrying `0039`'s retrain debt and this does not add a
-- second cause — every artifact that owes a retrain for `0039` owes exactly one.

-- Which base table each canonical read reads under an ingestion axis.
--
-- The closure is over `pg_depend` for each view's rewrite rule, which is the
-- edge set Postgres maintains itself, and it is transitive because
-- `canonical_capacity_weight` reaches `plant_geo` through
-- `canonical_plant_registry` and a one-level walk would miss exactly the table
-- this migration is about. A relation qualifies as a source when it is a table
-- carrying an `ingested_at` column: that column *is* the ingestion axis, so
-- "has a go-live" and "has an `ingested_at`" are the same question, and a table
-- without one (`plant`, `reporting_entity`, `centroid_point`) is shown not to
-- need a go-live by the rule rather than by a note.
--
-- The read name is the manifest's, by the transform the contract already
-- applies in the other direction: `canonical_curtailment_by_plant` <->
-- `curtailment-by-plant`.
CREATE OR REPLACE FUNCTION canonical_read_source()
  RETURNS TABLE (read text, view_name text, source_table text)
  LANGUAGE sql STABLE AS $$
  WITH RECURSIVE canonical_view AS (
    SELECT c.oid, c.relname
    FROM pg_class c
    WHERE c.relkind = 'v'
      AND c.relnamespace = 'public'::regnamespace
      AND c.relname LIKE 'canonical\_%'
  ),
  -- Every view-to-relation edge in the database, from the rewrite rules. The
  -- self-edge is dropped: a view's rule depends on the view it defines.
  edge AS (
    SELECT DISTINCT r.ev_class AS src, d.refobjid AS dst
    FROM pg_rewrite r
    JOIN pg_depend d
      ON d.objid = r.oid
     AND d.classid = 'pg_rewrite'::regclass
     AND d.refclassid = 'pg_class'::regclass
    WHERE d.refobjid <> r.ev_class
  ),
  reach AS (
    SELECT v.oid AS root, v.oid AS rel FROM canonical_view v
    UNION
    SELECT reach.root, edge.dst FROM reach JOIN edge ON edge.src = reach.rel
  )
  SELECT replace(substring(v.relname from 11), '_', '-'),
         v.relname,
         t.relname
  FROM reach
  JOIN canonical_view v ON v.oid = reach.root
  JOIN pg_class t ON t.oid = reach.rel
  WHERE t.relkind IN ('r', 'p')
    AND t.relnamespace = 'public'::regnamespace
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid
        AND a.attname = 'ingested_at'
        AND a.attnum > 0
        AND NOT a.attisdropped
    );
$$;
--> statement-breakpoint
COMMENT ON FUNCTION canonical_read_source() IS
  'Which base tables each canonical read reads under an ingestion axis, derived from the catalogue: every canonical_* view, transitively through the views it reads, down to the tables carrying an ingested_at column. The input to canonical_read_go_live, so that a read added tomorrow has a go-live row without anyone remembering to write one. A table with no ingested_at is not a source: that column is the ingestion axis, and a go-live for a table that has none would be an instant with nothing to be the instant of.';
--> statement-breakpoint

-- `min(ingested_at)` over one source, by name.
--
-- Dynamic, because the set of tables is discovered rather than written down and
-- a static view cannot aggregate over a set it does not name. It is scoped to
-- the tables `canonical_read_source()` found rather than left as a general
-- primitive for reading any table in the schema: the argument is a name, and a
-- function that turns a name into a scan of that table is worth keeping narrow.
CREATE OR REPLACE FUNCTION canonical_source_go_live(source_table text)
  RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE go_live_at timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM canonical_read_source() s
    WHERE s.source_table = canonical_source_go_live.source_table
  ) THEN
    RAISE EXCEPTION 'no canonical view reads % under an ingestion axis',
      coalesce(source_table, '<null>') USING ERRCODE = '22023';
  END IF;
  EXECUTE format('select min(ingested_at) from public.%I', source_table)
    INTO go_live_at;
  RETURN go_live_at;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION canonical_source_go_live(text) IS
  'WattSteer go-live for one canonical source table - min(ingested_at), unfiltered by any axis, because go-live is a fact about WattSteer history rather than about the cut being asked for. Refuses a table no canonical view reads under an ingestion axis, so it stays the go-live primitive rather than a way to scan an arbitrary table.';
--> statement-breakpoint

-- The view itself: drizzle-kit's replacement, one aggregate over the rule
-- above. It reads two functions and no relation, which is why the rule finds
-- no source for it and it does not appear in its own output.
DROP VIEW "public"."canonical_read_go_live";--> statement-breakpoint
CREATE VIEW "public"."canonical_read_go_live" AS (
  select
    s.read,
    case
      when count(*) filter (where g.go_live_at is null) > 0 then null
      else max(g.go_live_at)
    end as go_live_at
  from (select distinct read, source_table from canonical_read_source()) s
  cross join lateral (
    select canonical_source_go_live(s.source_table) as go_live_at
  ) g
  group by s.read
);
--> statement-breakpoint

-- The vintaged sources the **feature layer** reads, and their go-lives.
--
-- The one place the catalogue cannot answer: a plpgsql body records no
-- dependency on the views it reads, so `pg_depend` knows nothing about which
-- canonical views `feature_weather_block` composes. What is available is the
-- function source itself, matched against the canonical view names the
-- catalogue does know — so this is still discovery against a live list rather
-- than a list of its own, and a block that starts reading a ninth source is in
-- the set the moment it is created.
--
-- Two directions, and they are not symmetric. A view named in a *comment*
-- inside a feature function is a false positive: it widens the set, which
-- lengthens the horizon and moves the weakest link earlier — the strict
-- direction, and the safe one. A miss would be the unsafe direction, so it is
-- not left to reasoning: `database-features.test.ts` snapshots
-- `pg_stat_get_xact_numscans` across a real feature build and asserts that
-- every vintaged table the build actually scanned is in this set.
--
-- The `source_table` arm of the match is there for the same asymmetry. Nothing
-- in the feature layer reads a base table today — `features-gate.test.ts`
-- refuses one — but if something ever does, its go-live is counted rather than
-- silently absent.
CREATE OR REPLACE FUNCTION feature_source_go_live()
  RETURNS TABLE (source_table text, go_live_at timestamptz)
  LANGUAGE sql STABLE AS $$
  SELECT t.source_table, canonical_source_go_live(t.source_table)
  FROM (
    SELECT DISTINCT s.source_table
    FROM pg_proc p
    JOIN canonical_read_source() s
      ON p.prosrc ~ ('\m' || s.view_name || '\M')
      OR p.prosrc ~ ('\m' || s.source_table || '\M')
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname LIKE 'feature\_%'
      AND p.prokind = 'f'
  ) t;
$$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_source_go_live() IS
  'The vintaged source tables the feature layer reads, with WattSteer go-live for each. Derived: the canonical views named in the feature_% functions own source, resolved to base tables through canonical_read_source(). A plpgsql body records no catalogue dependency, so the source text is the only place this edge exists; a false positive widens the set, which is the strict direction, and a miss is measured against pg_stat_get_xact_numscans over a real build in database-features.test.ts.';
--> statement-breakpoint

-- The weakest link over the sources a feature row reads.
--
-- `docs/contracts/canonical-reads.md`'s composition rule, at the grain a
-- feature row composes: the *latest* contributing go-live, or NULL if any
-- contributing source has ingested nothing at all, because then no such
-- instant exists. NULL where the set is empty too — a feature layer whose
-- sources cannot be found claims nothing, which is `0012`'s posture.
--
-- It replaces seven `SELECT ... FROM canonical_read_go_live WHERE read = '...'`
-- lookups inside `feature_rows`. The seven were not wrong about the reads they
-- named; they were an eighth short, and being short is not something a list can
-- report about itself.
CREATE OR REPLACE FUNCTION feature_read_go_live()
  RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN count(*) = 0 THEN NULL
    WHEN count(*) FILTER (WHERE g.go_live_at IS NULL) > 0 THEN NULL
    ELSE max(g.go_live_at)
  END
  FROM feature_source_go_live() g;
$$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_read_go_live() IS
  'WattSteer go-live behind a feature row - the weakest link over the sources the feature blocks read, which is the latest of them, or NULL if any of them has ingested nothing. Derived from feature_source_go_live() rather than named read by read, which is how plant_geo - the registry location cut behind every weather feature through canonical_capacity_weight - reached the fidelity stamp at all.';
--> statement-breakpoint

-- The horizon, narrowed to the sources the feature layer reads.
--
-- `0039` made this the latest go-live across `canonical_read_go_live`, and said
-- why: a source that had not started yet has an `ingested_at` that is still a
-- backfill artefact, and one session axis cannot carry a different floor per
-- source. Both sentences are still true. What changed is the scope of "every
-- canonical read": the horizon covered nine reads including two no feature
-- block reads, and it had to, because narrowing to the seven *named* reads
-- would have dropped `plant_geo` — a source that is read — off the stamp.
--
-- With the set derived, the horizon is the latest go-live across exactly the
-- sources a feature row reads. That is strictly narrower and no less honest:
-- inside the band it gives up, every source the row reads was already live at
-- the gate, so `ingested_at` there is a record of what WattSteer had learned
-- rather than a loader's clock. The two reads it stops carrying —
-- `curtailment-by-plant` and `conjunto-membership` — feed no feature block,
-- which `database-features.test.ts` measures rather than assumes.
--
-- The memo is unchanged, and so is its reason: this is asked once per block per
-- target date, the scans behind it are unindexed `min()`s, and `-infinity` is
-- the memo's spelling of "computed, and there is no horizon". It remains a memo
-- and not a read axis.
CREATE OR REPLACE FUNCTION feature_ingestion_history_from()
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  memo text := nullif(current_setting('wattsteer.feature_ingestion_history_from', true), '');
  horizon timestamptz;
BEGIN
  IF memo IS NOT NULL THEN
    RETURN memo::timestamptz;
  END IF;

  SELECT max(g.go_live_at) INTO horizon FROM feature_source_go_live() g;
  -- A source that has ingested nothing contributes no rows to filter, so it
  -- does not move the horizon; a database where *nothing* the feature layer
  -- reads has been ingested has no horizon at all, and `-infinity` puts that
  -- case on the strict side.
  horizon := coalesce(horizon, '-infinity'::timestamptz);

  PERFORM set_config('wattsteer.feature_ingestion_history_from', horizon::text, true);
  RETURN horizon;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_ingestion_history_from() IS
  'The instant by which every source the feature layer reads had begun ingesting - the latest go-live across feature_source_go_live(). Before it, ingested_at is a backfill artefact rather than a record of what WattSteer had learned, so the feature-side ingestion cut does not bind. Narrowed by data-platform 20 from every canonical read to the sources a feature row actually reads, which became sound once plant_geo had a go-live record at all. Memoised transaction-locally in wattsteer.feature_ingestion_history_from, which is a memo and not a read axis. -infinity when nothing the feature layer reads has ingested anything, which puts an empty database on the strict side.';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION feature_rows(
  target_from date,
  target_to date,
  gate_profile text,
  feature_set text,
  threshold_mw double precision
) RETURNS SETOF feature_row LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  d date;
  gate timestamptz;
  row_go_live timestamptz;
BEGIN
  IF target_from IS NULL OR target_to IS NULL THEN
    RAISE EXCEPTION 'feature_rows requires both ends of the target range'
      USING ERRCODE = '22023';
  END IF;
  IF target_to < target_from THEN
    RAISE EXCEPTION 'target range % .. % is backwards', target_from, target_to
      USING ERRCODE = '22023';
  END IF;
  IF feature_set IS NULL
     OR feature_set NOT IN ('dessem_free_v1', 'dessem_augmented_v1') THEN
    RAISE EXCEPTION 'unknown feature set %: expected dessem_free_v1 or dessem_augmented_v1',
      coalesce(feature_set, '<null>') USING ERRCODE = '22023';
  END IF;
  IF threshold_mw IS NULL OR threshold_mw < 0 THEN
    RAISE EXCEPTION 'threshold_mw must be a non-negative number of MW'
      USING ERRCODE = '22023';
  END IF;
  -- Structural, not a rule: the DESSEM file for day D is created on the
  -- afternoon of D-1, so at 09:00 on D-1 the newest one describes D-1 itself.
  -- The block behind this raises the same refusal for a caller that reaches it
  -- another way; this one is here so the refusal costs nothing to discover.
  IF feature_set = 'dessem_augmented_v1' AND gate_profile IS DISTINCT FROM 'gate_late' THEN
    RAISE EXCEPTION 'dessem_augmented_v1 exists only at gate_late: DESSEM for day D is not published until the evening of D-1'
      USING ERRCODE = '22023';
  END IF;
  -- Reject an unknown profile once, up front, rather than on the first row.
  PERFORM gate_at(target_from, gate_profile);

  -- WattSteer's own go-live behind this row, for the fidelity stamp: the
  -- weakest link over the sources a feature row reads, **derived** rather than
  -- named. Not filtered by any axis, for the reason the seven named lookups it
  -- replaces were not: go-live is a fact about WattSteer's history rather than
  -- about the cut being asked for.
  row_go_live := feature_read_go_live();

  FOR d IN SELECT generate_series(target_from, target_to, interval '1 day')::date LOOP
    gate := gate_at(d, gate_profile);

    RETURN QUERY
    WITH spine AS (
      -- Four subsystems by twenty-four local hours, from the enum and the
      -- calendar. `SIN` is not a Subsystem and there is no fifth member to
      -- leak in.
      SELECT s.subsystem, h.valid_time
      FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
      CROSS JOIN feature_local_day_hours(d) AS h(valid_time)
    ),
    -- MATERIALIZED so each block is evaluated whole. Each writes every axis at
    -- its own start, so the vintages cannot interleave whichever order the
    -- planner picks them in.
    --
    -- Class `W`, and now at (subsystem, hour) rather than at the hour: the
    -- weather a subsystem sees is the weather over *its own* fleet.
    weather AS MATERIALIZED (
      SELECT * FROM feature_weather_block(d, gate_profile)
    ),
    capacity AS MATERIALIZED (
      SELECT * FROM feature_capacity_block(d, gate_profile)
    ),
    labels AS MATERIALIZED (
      SELECT * FROM feature_label_block(d)
    ),
    -- Class `T`, and no vintage: the calendar is the same calendar whichever
    -- gate is being asked about, which is precisely why these two take a target
    -- date and no profile.
    calendar AS MATERIALIZED (
      SELECT * FROM feature_calendar_block(d)
    ),
    shares AS MATERIALIZED (
      SELECT * FROM feature_holiday_share_block(d)
    ),
    -- Class `K`. The one block cut on `valid_time` rather than on a vintage,
    -- and the only one that reads the fleet under a second fleet date, which is
    -- why it is materialised as firmly as the rest.
    lagged AS MATERIALIZED (
      SELECT * FROM feature_lagged_actuals_block(d, gate_profile, feature_rows.threshold_mw)
    ),
    -- Class `P`. A forecast, so it is cut on publication like the weather and
    -- unlike the block above it — the two cuts sit side by side here on purpose.
    programmed AS MATERIALIZED (
      SELECT * FROM feature_programmed_load_block(d, gate_profile)
    ),
    -- Class `D`. The only block that is handed the feature set, because it is
    -- the only one the set decides the existence of: at `dessem_free_v1` it
    -- returns nothing and the twenty-one columns below are NULL because the
    -- join found no row, not because a filter emptied them.
    dessem AS MATERIALIZED (
      SELECT * FROM feature_dessem_block(d, gate_profile, feature_rows.feature_set)
    ),
    -- Class `P`+`W`+`T`. The one block that reads no source: it composes the
    -- class-`P` and class-`W` blocks above rather than re-reading what they
    -- read, so the reconstruction and the terms it is built from are the same
    -- numbers in the same row. It is not handed the feature set, because both
    -- sets carry it — set B holds this family beside the DESSEM one so the two
    -- views of residual load are comparable.
    proxy AS MATERIALIZED (
      SELECT * FROM feature_proxy_residual_load_block(d, gate_profile)
    ),
    -- Class `K` and class `D`+`K`. The three utilisation ratios, and the only
    -- place in the row where a class-`D` numerator meets a class-`K`
    -- denominator. It is handed the feature set because of that one column: the
    -- class-`D` block it composes returns nothing at `dessem_free_v1`, so
    -- `dessem_export_utilisation` is NULL for set A by the same mechanism as
    -- the other twenty-one `dessem_*` columns — the join found no row — while
    -- the two observed ratios are present in both sets and at both gates.
    utilisation AS MATERIALIZED (
      SELECT * FROM feature_interchange_utilisation_block(
        d, gate_profile, feature_rows.feature_set
      )
    )
    SELECT
      spine.subsystem,
      spine.valid_time,
      d,
      feature_rows.gate_profile,
      gate,
      feature_rows.feature_set,
      feature_rows.threshold_mw,
      -- The weakest link. An answer composed from a point-in-time series and a
      -- revision-optimistic one is revision-optimistic as a whole, because a
      -- consumer cannot use half of it. Capacity is in that rule: over the
      -- backfill window the registry answers from today's snapshot. So are the
      -- two observation series the class-`K` block reads, the day-ahead
      -- programme the class-`P` block reads, the DESSEM balance, and the
      -- registry's location cut, which stands behind every weather feature
      -- because the weights are read from it.
      --
      -- It was seven `feature_vintage_fidelity` conjuncts over seven go-lives
      -- named one at a time, and `plant_geo` was in none of them — the eighth
      -- source, behind the weather weights, with no go-live row to name. So the
      -- weakest link is now taken over the sources this function's blocks
      -- **actually read**, discovered from the catalogue by
      -- `feature_read_go_live()`. Same rule, one conjunct, and a ninth source
      -- onboarded tomorrow joins it without an edit here.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, row_go_live) = 'point_in_time'
         -- And the gate itself, against WattSteer's own ingestion history over
         -- those same sources. `feature_as_of` suspends the ingestion cut for a
         -- gate that precedes it, because over the backfill window
         -- `ingested_at` is the loader's clock rather than a record of what had
         -- been learned. A row built under that relaxation cannot claim to be
         -- point-in-time, so the stamp is exact: `point_in_time` means this row
         -- was built under `as_of = gate`, unrelaxed. It is the second conjunct
         -- because it is about the gate rather than about a source, and it is a
         -- conjunct rather than a replacement for the one above because a
         -- source that has ingested nothing has a NULL go-live and moves no
         -- horizon.
         AND gate >= feature_ingestion_history_from()
        THEN 'point_in_time' ELSE 'revision_optimistic'
      END,
      weather.weather_temperature_2m,
      labels.wind_mwh,
      labels.solar_mwh,
      total.mwh,
      -- Derived from the argument and never stored, so two consumers cannot
      -- hold disagreeing thresholds. At hourly grain MWh and MW are numerically
      -- equal, which is why the comparison needs no conversion.
      total.mwh > feature_rows.threshold_mw,
      CASE WHEN total.mwh > feature_rows.threshold_mw THEN total.mwh END,
      -- Day grain, broadcast identically across the 24 hours of D. The join is
      -- on the subsystem alone because there is nothing hourly to join on.
      capacity.capacity_wind_mw,
      capacity.capacity_solar_mw,
      capacity.capacity_wind_added_28d_mw,
      capacity.capacity_solar_added_28d_mw,
      calendar.calendar_local_hour,
      calendar.calendar_hour_sin,
      calendar.calendar_hour_cos,
      calendar.calendar_doy_sin,
      calendar.calendar_doy_cos,
      calendar.calendar_day_of_week,
      calendar.calendar_is_weekend,
      calendar.calendar_is_holiday_national,
      shares.calendar_holiday_state_share,
      calendar.calendar_is_day_before_holiday,
      calendar.calendar_is_bridge_day,
      calendar.solar_zenith_cos,
      calendar.solar_extraterrestrial_ghi,
      lagged.observed_actual_lag_hours,
      lagged.observed_constrained_off_lag_168h,
      lagged.observed_constrained_off_wind_lag_168h,
      lagged.observed_constrained_off_solar_lag_168h,
      lagged.observed_constrained_off_lag_48h,
      lagged.observed_constrained_off_same_hour_mean_7d,
      lagged.observed_constrained_off_hours_above_threshold_7d,
      lagged.observed_constrained_off_total_7d_mwh,
      lagged.observed_load_lag_168h,
      lagged.observed_wind_generation_lag_168h,
      lagged.observed_solar_generation_lag_168h,
      lagged.observed_wind_capacity_factor_mean_7d,
      lagged.observed_solar_capacity_factor_mean_7d,
      lagged.observed_net_exchange_lag_168h,
      lagged.observed_net_exchange_mean_24h_to_cutoff,
      lagged.observed_corridor_flow_ne_se_lag_168h,
      lagged.observed_corridor_flow_n_ne_lag_168h,
      lagged.observed_reason_share_ene_7d,
      lagged.observed_reason_share_cnf_7d,
      lagged.observed_reason_share_rel_7d,
      programmed.programmed_load_mwh,
      programmed.programmed_load_ramp_1h,
      programmed.programmed_load_mean_3h,
      programmed.programmed_load_daily_min_mwh,
      programmed.programmed_load_rank_in_day,
      dessem.dessem_demand_mwh,
      dessem.dessem_wind_mwh,
      dessem.dessem_solar_mwh,
      dessem.dessem_mmgd_mwh,
      dessem.dessem_hydro_mwh,
      dessem.dessem_thermal_mwh,
      dessem.dessem_pumping_mwh,
      dessem.dessem_residual_load_mwh,
      dessem.dessem_renewable_load_ratio,
      dessem.dessem_vre_surplus_mwh,
      dessem.dessem_inflexible_share,
      dessem.dessem_implied_net_export_mwh,
      dessem.dessem_demand_ramp_1h,
      dessem.dessem_residual_load_ramp_1h,
      dessem.dessem_vre_ramp_1h,
      dessem.dessem_residual_load_min_of_day,
      dessem.dessem_residual_load_rank_in_day,
      dessem.dessem_wind_capacity_factor,
      dessem.dessem_solar_capacity_factor,
      dessem.dessem_sin_residual_load_mwh,
      dessem.dessem_absorber_residual_load_mwh,
      weather.weather_wind_speed_100m,
      weather.weather_wind_speed_120m,
      weather.weather_wind_direction_120m_sin,
      weather.weather_wind_direction_120m_cos,
      weather.weather_wind_gusts_10m,
      weather.weather_surface_pressure,
      weather.weather_relative_humidity_2m,
      weather.weather_precipitation,
      weather.weather_shortwave_radiation,
      weather.weather_direct_normal_irradiance,
      weather.weather_diffuse_radiation,
      weather.weather_cloud_cover,
      weather.weather_clearness_index,
      weather.weather_wind_power_curve_cf,
      weather.weather_expected_wind_mwh,
      weather.weather_expected_solar_mwh,
      weather.weather_wind_speed_120m_ramp_1h,
      weather.weather_shortwave_radiation_ramp_1h,
      weather.weather_expected_vre_ramp_1h,
      weather.weather_wind_speed_120m_mean_3h,
      weather.weather_wind_speed_120m_std_6h,
      weather.weather_shortwave_radiation_mean_3h,
      weather.weather_run_age_hours,
      weather.weather_centroid_coverage,
      proxy.proxy_residual_load_mwh,
      proxy.proxy_residual_load_ratio,
      proxy.proxy_renewable_load_ratio,
      proxy.proxy_vre_surplus_mwh,
      proxy.proxy_residual_load_ramp_1h,
      proxy.proxy_residual_load_min_of_day,
      proxy.proxy_residual_load_rank_in_day,
      utilisation.observed_export_utilisation_mean_24h_to_cutoff,
      utilisation.observed_corridor_utilisation_ne_se_max_7d,
      utilisation.dessem_export_utilisation,
      -- The 112th attribute, and last because appending is the only thing
      -- `ALTER TYPE ... ADD ATTRIBUTE` does. It comes from the class-`K` CTE
      -- twenty lines above the `utilisation` one, so this is the first place in
      -- the tree where the select list's order and the blocks' order visibly
      -- part company. That is what the restatement rule is protecting: rebuilt
      -- from `0031`'s copy with every prior column in its existing position.
      lagged.observed_constrained_off_same_hour_exceedance_7d
    FROM spine
    LEFT JOIN weather
      ON weather.subsystem = spine.subsystem
     AND weather.valid_time = spine.valid_time
    LEFT JOIN capacity ON capacity.subsystem = spine.subsystem
    LEFT JOIN calendar ON calendar.valid_time = spine.valid_time
    LEFT JOIN shares ON shares.subsystem = spine.subsystem
    LEFT JOIN lagged
      ON lagged.subsystem = spine.subsystem
     AND lagged.valid_time = spine.valid_time
    LEFT JOIN programmed
      ON programmed.subsystem = spine.subsystem
     AND programmed.valid_time = spine.valid_time
    LEFT JOIN dessem
      ON dessem.subsystem = spine.subsystem
     AND dessem.valid_time = spine.valid_time
    LEFT JOIN proxy
      ON proxy.subsystem = spine.subsystem
     AND proxy.valid_time = spine.valid_time
    LEFT JOIN utilisation
      ON utilisation.subsystem = spine.subsystem
     AND utilisation.valid_time = spine.valid_time
    LEFT JOIN labels
      ON labels.subsystem = spine.subsystem
     AND labels.valid_time = spine.valid_time
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN labels.wind_mwh IS NULL AND labels.solar_mwh IS NULL THEN NULL
        ELSE coalesce(labels.wind_mwh, 0) + coalesce(labels.solar_mwh, 0)
      END AS mwh
    ) total
    ORDER BY spine.valid_time, spine.subsystem;
  END LOOP;

  PERFORM feature_release_axes();
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_rows(date, date, text, text, double precision) IS
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The class W block is the twelve pinned weather variables capacity-weighted over the frozen centroids, per subsystem, with the weights recomputed per target date. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate. The proxy block is class P+W+T: it composes the class P and class W blocks rather than reading a source of its own, it is in both feature sets so the two views of residual load are comparable, and it is NULL at gate_early because the programme it subtracts from is. The utilisation block is class K and class D+K: three ratios that all divide by feature_export_capability_estimate, an ESTIMATE of directed export capability computed as P99.5 of directed flow over the trailing 365 days ending at the same actuals_cutoff, because no ONS dataset publishes a transfer limit at any grain. There is exactly one such estimate and every ratio reaches it. The one class-K column ticket 05 owed and did not ship is now here too: observed_constrained_off_same_hour_exceedance_7d, the occurrence twin of observed_constrained_off_same_hour_mean_7d over the same seven same-local-hour observations, which is what lets forecaster.md rung 1 compute BOTH heads of the mandatory baseline from this function instead of only the magnitude one. The vintage stamp is the weakest link over the sources the blocks read, taken from feature_read_go_live() rather than from seven go-lives named one at a time, so a source onboarded tomorrow binds the stamp without an edit here - which is how plant_geo, the registry location cut behind every weather feature, reached it.';
