-- The plant-grain constrained-off datasets become ingestable sources.
--
-- `constrained_off_detail-job.ts`, `plant-detail-repository.ts` and
-- `ons/constrained-off-detail.ts` were merged and tested but wired to nothing:
-- no `IngestTask` kind, no dispatcher branch, no `planRefresh` line — so
-- `plant_detail_hour` was unfillable and `canonical_curtailment_by_plant` was
-- the one canonical read with a null `go_live_at` after a complete ONS
-- backfill. Wiring it needs one thing from the schema, and this is it: a run
-- row names its source, and the enum had no member for this ingestor.
--
-- Two members, not one, following `constrained_off_wind` / `_solar`: the two
-- technologies are two CKAN packages with different coverage starts (wind
-- 2021-10, solar 2024-04), and an operator watching for a source that went
-- quiet needs one grain's silence to be visible while the other runs.
--
-- Placed before `interchange` so the two grains of one dataset read together in
-- the enum, which is where the schema declares them. The statements are
-- drizzle-kit's own output; nothing here is hand-written but this comment.

ALTER TYPE "public"."ingestion_source" ADD VALUE 'constrained_off_wind_detail' BEFORE 'interchange';--> statement-breakpoint
ALTER TYPE "public"."ingestion_source" ADD VALUE 'constrained_off_solar_detail' BEFORE 'interchange';