-- A headline reading is a number **or** a stated absence.
--
-- `.scratch/api-surface/issues/10-forecast-publication.md`, "A driver group
-- whose headline feature is NULL for the day can be published, or the refusal
-- is a stated contract rather than an accident". This is the storage half of
-- the first answer.
--
-- ## The defect
--
-- `observed` and `typical` were NOT NULL, and the gateway's parser read both
-- through `num()` on every one of the sixteen driver rows. But three of the
-- eight real headline features — `weather_expected_wind_mwh`,
-- `weather_expected_vre_ramp_1h`, `weather_centroid_coverage` — are in the
-- weather block, and that block arrives from one join on one model run and goes
-- NULL together. So a day whose weather run did not land had no publishable
-- pair for those bars, and the wire had no way to say so. The whole day's
-- diagnosis was refused, typed, as `null_headline_feature`.
--
-- ## How often, measured
--
-- At the feature fixture's own 5%-per-row weather-null rate — which is there
-- because a NULL feature is the case the no-imputation rule exists for — over a
-- year of rows: 71.8% of subsystem-days hold at least one NULL weather hour,
-- and **99.2% of calendar days hold one somewhere**, which is what the refusal
-- was scoped to. The `typical` side is worse: a background cell is 128 rows, so
-- P(one cell gap-free) = 0.95^128 ≈ 0.0013 and P(all 24 day-grain cells
-- gap-free) ≈ 7e-70. The refusal did not fire on a corner case; it fired
-- essentially always.
--
-- ## Why nullable is the right answer and not the lazy one
--
-- The pair is a **subtitle** under a bar. `phi_mwh`, `direction`, `share` and
-- `rank` are the boosters' and are computed with the NULL in the matrix, where
-- LightGBM handles it natively; none of them moves because a column has no
-- mean. Refusing an entire day's explanation — eight bars, two grains, four
-- subsystems — because one bar lost its caption was a large cost for a small
-- gap.
--
-- What is *not* done is the pair of alternatives that would have kept the
-- columns NOT NULL, and both were rejected before this migration was written:
-- a zero is the invented number this whole table exists to keep out, and a mean
-- over the hours that happened to carry a reading is a **different** "typical"
-- than the one the baseline `v(∅)` was averaged over, published under the same
-- name. Both are invisible once stored.
--
-- ## The two CHECKs are the whole safety
--
-- A nullable column on its own would have re-created the defect it fixes: a
-- reader cannot tell a NULL that means "no reading" from a NULL that means
-- "somebody forgot". So each half carries a reason column and a CHECK that ties
-- the two together — a value XOR a reason, in both directions. A NULL with no
-- reason is a dropped field by another name; a number beside a reason leaves
-- the reader to pick a half to believe. Neither is representable.
--
-- The reasons are `text` and not an enum, for the reason `driver_group` is
-- text: the vocabulary is `READING_ABSENCE_REASONS` in `apps/ml` and the closed
-- half of it is the gateway's parse, so a third reason upstream is a code
-- change and not a migration.
--
-- ## No backfill, and none needed
--
-- Unlike `0042` this migration needs no precondition. Existing rows carry a
-- number in both columns and NULL in both new ones, which is exactly the shape
-- both CHECKs admit — dropping a NOT NULL cannot invalidate a row that has a
-- value. So an existing publication stays readable and unchanged, and it says
-- what it always said.
--
-- ## The view is dropped and recreated
--
-- `canonical_diagnosis_driver` projects both columns, so Postgres will not let
-- the columns underneath it change nullability while it stands. The body is
-- `0042`'s with the two reason columns added and nothing else moved.

DROP VIEW "public"."canonical_diagnosis_driver";--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ALTER COLUMN "observed" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ALTER COLUMN "typical" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ADD COLUMN "observed_absent_reason" text;--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ADD COLUMN "typical_absent_reason" text;--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ADD CONSTRAINT "diagnosis_attribution_driver_observed_or_its_absence" CHECK (("diagnosis_attribution_driver"."observed" is null) = ("diagnosis_attribution_driver"."observed_absent_reason" is not null));--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ADD CONSTRAINT "diagnosis_attribution_driver_typical_or_its_absence" CHECK (("diagnosis_attribution_driver"."typical" is null) = ("diagnosis_attribution_driver"."typical_absent_reason" is not null));--> statement-breakpoint
CREATE VIEW "public"."canonical_diagnosis_driver" AS (
  select
    d.subsystem,
    d.target_date,
    d.origin_kind,
    d.gate_profile,
    d.data_version,
    d.grain,
    d.driver_group,
    d.label_code,
    d.rank,
    d.phi_mwh,
    d.share,
    d.direction,
    d.hour_disagreement,
    d.headline_feature,
    d.observed,
    d.typical,
    d.observed_absent_reason,
    d.typical_absent_reason,
    d.unit,
    d.demoted
  from diagnosis_attribution_driver d
  join canonical_diagnosis_attribution a
    on a.subsystem = d.subsystem
   and a.target_date = d.target_date
   and a.origin_kind = d.origin_kind
   and a.gate_profile = d.gate_profile
   and a.data_version = d.data_version
);