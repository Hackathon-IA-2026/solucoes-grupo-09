-- The national day grain — forecaster ticket 22.
--
-- **The table `NationalDayGrain.as_row()` had no destination for.** Ticket 08
-- built the joint band and it is right: `apps/ml/.../training/national.py` adds
-- the four subsystems' day totals **on the same draw** under one shared row
-- index of `U`, takes peak-of-sum rather than sum-of-peaks, and counts
-- occurrence over draws. Measured, it comes out at roughly half the width of
-- the componentwise sum, which is what a real joint distribution buys over an
-- assumption of comonotonicity. Ticket 14 recorded that it had nowhere to go,
-- and until this migration `/v1/grid/outlook` served `band: null` with
-- `band_unavailable_reason: 'no_joint_ensemble'`.
--
-- **Its own grain, because `SIN` is not a `Subsystem`.** Making the national
-- figure a fifth row of `curtailment_forecast_day` is exactly the shape
-- `docs/domain-model.md`'s vocabulary rule 6 forbids, and it is why the
-- national figure lives under its own key on the wire rather than as a fifth
-- array member. There is no `subsystem` column here. The four subsystems the
-- sum covered are carried as a `subsystem_code[]` — a statement about coverage,
-- constrained to be exactly the four — which is a different fact from a row's
-- identity and cannot be joined to as one. `SIN` is not a member of
-- `subsystem_code`, so it is not spellable anywhere in this table.
--
-- **`threshold_mw` is in the key, and in `curtailment_forecast_day`'s it is
-- not.** A national total is MWh above τ summed across four subsystems: two
-- thresholds are two quantities rather than two beliefs about one, so a
-- threshold sweep writes a second row here instead of revising the first. The
-- read filters on the threshold the day's four subsystem rows share.
--
-- **`derivation` is `joint_path_ensemble` and the check refuses
-- `path_ensemble`.** They are two constructions — one draws whole days of one
-- subsystem, the other adds four subsystems on one shared draw index — and a
-- reader of the database has to be able to tell a national figure drawn from
-- the shared index from one an earlier code path summed. Hand-written rather
-- than generated because the snapshots in `meta/` have been frozen since 0033
-- and a plain `drizzle-kit generate` re-emits every table added since.
--
-- Bitemporal discipline is the same as the two tables beside it: append-only,
-- `data_version` monotone per business key, `published_at` the gate instant and
-- `ingested_at` the axis `AsOf(t)` filters on. Nothing is ever overwritten.

CREATE TABLE "curtailment_forecast_national_day" (
	"target_date" date NOT NULL,
	"origin_kind" "forecast_origin_kind" NOT NULL,
	"gate_profile" "forecast_gate_profile" NOT NULL,
	"threshold_mw" double precision NOT NULL,
	"forecast_producer" "forecast_producer" NOT NULL,
	"run_label" text NOT NULL,
	"feature_set" text NOT NULL,
	"correction_regime" text NOT NULL,
	"subsystems" "subsystem_code"[] NOT NULL,
	"day_total_p10_mwh" double precision NOT NULL,
	"day_total_p50_mwh" double precision NOT NULL,
	"day_total_p90_mwh" double precision NOT NULL,
	"peak_power_p10_mw" double precision NOT NULL,
	"peak_power_p50_mw" double precision NOT NULL,
	"peak_power_p90_mw" double precision NOT NULL,
	"day_occurrence_probability" double precision NOT NULL,
	"expected_mwh" double precision NOT NULL,
	"derivation" text NOT NULL,
	"ensemble_draws" integer NOT NULL,
	"ensemble_seed" integer NOT NULL,
	"ensemble_calibration_days" integer NOT NULL,
	"trained_through" date NOT NULL,
	"risk_bin_elevated_from" double precision NOT NULL,
	"risk_bin_high_from" double precision NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	CONSTRAINT "curtailment_forecast_national_day_target_date_origin_kind_gate_profile_threshold_mw_data_version_pk" PRIMARY KEY("target_date","origin_kind","gate_profile","threshold_mw","data_version"),
	CONSTRAINT "curtailment_forecast_national_day_is_a_forecast" CHECK ("curtailment_forecast_national_day"."published_at" < ("curtailment_forecast_national_day"."target_date"::timestamp at time zone 'America/Sao_Paulo')),
	CONSTRAINT "curtailment_forecast_national_day_total_monotone" CHECK ("curtailment_forecast_national_day"."day_total_p10_mwh" <= "curtailment_forecast_national_day"."day_total_p50_mwh" and "curtailment_forecast_national_day"."day_total_p50_mwh" <= "curtailment_forecast_national_day"."day_total_p90_mwh"),
	CONSTRAINT "curtailment_forecast_national_day_peak_monotone" CHECK ("curtailment_forecast_national_day"."peak_power_p10_mw" <= "curtailment_forecast_national_day"."peak_power_p50_mw" and "curtailment_forecast_national_day"."peak_power_p50_mw" <= "curtailment_forecast_national_day"."peak_power_p90_mw"),
	CONSTRAINT "curtailment_forecast_national_day_probability" CHECK ("curtailment_forecast_national_day"."day_occurrence_probability" between 0 and 1),
	CONSTRAINT "curtailment_forecast_national_day_from_the_joint_ensemble" CHECK ("curtailment_forecast_national_day"."derivation" = 'joint_path_ensemble'),
	CONSTRAINT "curtailment_forecast_national_day_covers_the_four" CHECK (array_length("curtailment_forecast_national_day"."subsystems", 1) = 4 and "curtailment_forecast_national_day"."subsystems" @> array['N','NE','SE','S']::subsystem_code[]),
	CONSTRAINT "curtailment_forecast_national_day_drew_something" CHECK ("curtailment_forecast_national_day"."ensemble_draws" > 0),
	CONSTRAINT "curtailment_forecast_national_day_threshold_positive" CHECK ("curtailment_forecast_national_day"."threshold_mw" > 0),
	CONSTRAINT "curtailment_forecast_national_day_risk_edges_ordered" CHECK (0 < "curtailment_forecast_national_day"."risk_bin_elevated_from" and "curtailment_forecast_national_day"."risk_bin_elevated_from" < "curtailment_forecast_national_day"."risk_bin_high_from" and "curtailment_forecast_national_day"."risk_bin_high_from" < 1)
);
--> statement-breakpoint
CREATE INDEX "curtailment_forecast_national_day_as_of" ON "curtailment_forecast_national_day" USING btree ("target_date","ingested_at");
--> statement-breakpoint
CREATE VIEW "public"."canonical_forecast_national_day" AS (
  select distinct on (target_date, origin_kind, gate_profile, threshold_mw)
    target_date,
    origin_kind,
    gate_profile,
    threshold_mw,
    forecast_producer,
    run_label,
    feature_set,
    correction_regime,
    subsystems,
    day_total_p10_mwh,
    day_total_p50_mwh,
    day_total_p90_mwh,
    peak_power_p10_mw,
    peak_power_p50_mw,
    peak_power_p90_mw,
    day_occurrence_probability,
    expected_mwh,
    derivation,
    ensemble_draws,
    ensemble_seed,
    ensemble_calibration_days,
    trained_through,
    risk_bin_elevated_from,
    risk_bin_high_from,
    data_version,
    published_at,
    ingested_at
  from curtailment_forecast_national_day
  where ingested_at <= canonical_as_of()
  order by target_date, origin_kind, gate_profile, threshold_mw,
           ingested_at desc, data_version desc
);
