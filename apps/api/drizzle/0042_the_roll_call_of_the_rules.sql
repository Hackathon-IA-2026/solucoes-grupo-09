-- The roll call: which rules a published attribution was explained under.
--
-- `.scratch/api-surface/issues/10-forecast-publication.md`, "A third thing this
-- ticket will own", closed at the storage layer.
--
-- ## The hole
--
-- The one-way valve — a rule may `annotate`, `demote` or `withhold`, and may
-- never change a number or delete a driver — is enforced four ways inside
-- `wattsteer_ml.diagnosis.rules.apply_rules`: a rule is never handed a number
-- it could change, cannot return one, is held to that by an AST walk over the
-- module, and the whole payload is compared byte-for-byte before and after.
-- Not one of the four says the rules were **called**.
--
-- And `rule_flags = '[]'` is the ordinary shape of a quiet day. Most days fire
-- nothing, so an empty flag list is the common, honest case — which is exactly
-- why it was also a perfect disguise: a publish path that assembled an
-- attribution row and skipped `apply_rules` wrote a valid row that no reader,
-- and no test, could tell apart from a day the rules had looked at and passed.
--
-- ## The fix, and why it is a list of codes
--
-- `rules_evaluated` is the roll call: every rule the engine evaluated, fired or
-- not. `{}` on it means the rules did not run, and
-- `diagnosis_attribution_the_rules_ran` makes that unwritable. A quiet day now
-- carries the four codes beside an empty `rule_flags`, and the two states are
-- different values rather than one value read two ways.
--
-- Codes rather than a count or a boolean, because the shipping set is expected
-- to grow and "which rules did this row see" is the question a strange
-- narration a year from now actually raises: a day explained under three rules
-- is not the same row as one explained under five, and a `true` would not say
-- which. `text[]` rather than an enum, because adding a rule must not be a
-- migration; the *closed* half of the check is the gateway's parse, which
-- refuses a code that is not one of `apps/ml`'s `SHIPPING_RULE_CODES`.
--
-- ## The second constraint, and why it needs a function
--
-- `diagnosis_attribution_flags_were_evaluated` is the other half: every code in
-- `rule_flags` must appear in the roll call. The flags and the roll call are
-- two halves of one record, and a flag list assembled beside a roll call copied
-- from another run is a record of nothing.
--
-- It goes through `rule_flags_were_evaluated` because the test is over the
-- *elements* of a `jsonb` array and Postgres refuses a subquery in a CHECK —
-- "cannot use subquery in check constraint", measured, not assumed. A function
-- body may hold one, so the function is where it lives, declared here beside
-- the constraint that calls it rather than in a shared module nobody reads.
--
-- Its `coalesce(..., true)` is deliberate: `bool_and` over an empty
-- `rule_flags` is NULL, and no flags is not a violation — it is the quiet day
-- the roll-call constraint above already vouched for. And it tolerates a
-- non-array `rule_flags` rather than erroring on it, because *that* is
-- `diagnosis_attribution_rule_flags_array`'s refusal to make and a CHECK that
-- raised instead of returning false would report the wrong defect.
--
-- ## The column is NOT NULL with no default, and that needs a word
--
-- There is no honest backfill. A row written before this migration does not
-- know which rules looked at it: the four codes would be an invention, and `{}`
-- would trip the constraint that is the whole point. `docs/domain-model.md`'s
-- standing rule is that a zero never stands in for an absence, so neither is
-- written.
--
-- What makes that safe rather than reckless is that the table is **empty in
-- every database that exists**: `diagnosis_attribution` landed in `0035` and
-- `writeAttributionPublication` had no scheduled caller until this same
-- ticket's chain. That is a checkable fact, so the migration checks it instead
-- of assuming it, and says which row it found if it is wrong.
--
-- ## Both canonical views are dropped and recreated
--
-- drizzle-kit emitted the drop of `canonical_diagnosis_attribution` and not the
-- drop of `canonical_diagnosis_driver`, which joins it — so the generated
-- statement would have failed on the dependency. The driver view's body is
-- `0035`'s verbatim and is unchanged; it is dropped and put back only because
-- Postgres will not let the view underneath it change shape while it stands.

-- The precondition, checked rather than assumed.
DO $$
DECLARE existing bigint;
BEGIN
  SELECT count(*) INTO existing FROM diagnosis_attribution;
  IF existing > 0 THEN
    RAISE EXCEPTION
      'diagnosis_attribution holds % row(s) and rules_evaluated has no honest backfill: a row written before the roll call existed does not know which rules explained it. Naming the four would be an invention and an empty array trips diagnosis_attribution_the_rules_ran. Re-publish the affected days through the diagnosis publication and re-run this migration.',
      existing
      USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint

-- Every fired rule appears in the roll call. A function rather than an inline
-- CHECK because a CHECK may not hold a subquery; see the header.
CREATE OR REPLACE FUNCTION rule_flags_were_evaluated(flags jsonb, roll text[])
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(flags) IS DISTINCT FROM 'array' THEN true
    ELSE coalesce(
      (
        SELECT bool_and(flag->>'code' = any(roll))
        FROM jsonb_array_elements(flags) AS flag
      ),
      true
    )
  END
$$;--> statement-breakpoint
COMMENT ON FUNCTION rule_flags_were_evaluated(jsonb, text[]) IS
  'Whether every code in a rule_flags array appears in the roll call of evaluated rules. True for an empty or non-array rule_flags: no flags is not a violation, and the array-ness is a different constraint.';--> statement-breakpoint
DROP VIEW "public"."canonical_diagnosis_driver";--> statement-breakpoint
DROP VIEW "public"."canonical_diagnosis_attribution";--> statement-breakpoint
ALTER TABLE "diagnosis_attribution" ADD COLUMN "rules_evaluated" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "diagnosis_attribution" ADD CONSTRAINT "diagnosis_attribution_the_rules_ran" CHECK (cardinality("diagnosis_attribution"."rules_evaluated") > 0);--> statement-breakpoint
ALTER TABLE "diagnosis_attribution" ADD CONSTRAINT "diagnosis_attribution_flags_were_evaluated" CHECK (rule_flags_were_evaluated("diagnosis_attribution"."rule_flags", "diagnosis_attribution"."rules_evaluated"));--> statement-breakpoint
CREATE VIEW "public"."canonical_diagnosis_attribution" AS (
  select distinct on (subsystem, target_date, origin_kind, gate_profile)
    subsystem,
    target_date,
    origin_kind,
    gate_profile,
    forecast_producer,
    run_label,
    feature_set,
    correction_regime,
    threshold_mw,
    target,
    explains,
    hours_attributed,
    baseline_expected_mwh,
    day_expected_mwh,
    total_attributed_mwh,
    sum_abs_attributed_mwh,
    local_accuracy_residual_mwh,
    top_two_share,
    attribution_stderr_mwh,
    baseline_stderr_mwh,
    stderr_resamples,
    stderr_seed,
    peak_hour_local,
    peak_hour_expected_mwh,
    peak_hour_baseline_expected_mwh,
    driver_group_version,
    driver_group_hash,
    background_source,
    background_seed,
    background_rows,
    coalitions,
    rule_flags,
    rules_evaluated,
    governing_rule_action,
    data_version,
    published_at,
    ingested_at
  from diagnosis_attribution
  where ingested_at <= canonical_as_of()
  order by subsystem, target_date, origin_kind, gate_profile,
           ingested_at desc, data_version desc
);--> statement-breakpoint
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