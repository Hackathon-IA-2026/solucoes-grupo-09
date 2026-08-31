CREATE TYPE "public"."diagnosis_attribution_grain" AS ENUM('day', 'peak_hour');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_driver_direction" AS ENUM('raises', 'lowers');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_rule_action" AS ENUM('annotate', 'demote', 'withhold');--> statement-breakpoint
CREATE TABLE "diagnosis_attribution" (
	"subsystem" "subsystem_code" NOT NULL,
	"target_date" date NOT NULL,
	"origin_kind" "forecast_origin_kind" NOT NULL,
	"gate_profile" "forecast_gate_profile" NOT NULL,
	"forecast_producer" "forecast_producer" NOT NULL,
	"run_label" text NOT NULL,
	"feature_set" text NOT NULL,
	"correction_regime" text NOT NULL,
	"threshold_mw" double precision NOT NULL,
	"target" text NOT NULL,
	"explains" text NOT NULL,
	"hours_attributed" integer NOT NULL,
	"baseline_expected_mwh" double precision NOT NULL,
	"day_expected_mwh" double precision NOT NULL,
	"total_attributed_mwh" double precision NOT NULL,
	"sum_abs_attributed_mwh" double precision NOT NULL,
	"local_accuracy_residual_mwh" double precision NOT NULL,
	"top_two_share" double precision NOT NULL,
	"attribution_stderr_mwh" double precision NOT NULL,
	"baseline_stderr_mwh" double precision NOT NULL,
	"stderr_resamples" integer NOT NULL,
	"stderr_seed" integer NOT NULL,
	"peak_hour_local" integer NOT NULL,
	"peak_hour_expected_mwh" double precision NOT NULL,
	"peak_hour_baseline_expected_mwh" double precision NOT NULL,
	"driver_group_version" text NOT NULL,
	"driver_group_hash" text NOT NULL,
	"background_source" text NOT NULL,
	"background_seed" integer NOT NULL,
	"background_rows" integer NOT NULL,
	"coalitions" integer NOT NULL,
	"rule_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"governing_rule_action" "diagnosis_rule_action",
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	CONSTRAINT "diagnosis_attribution_subsystem_target_date_origin_kind_gate_profile_data_version_pk" PRIMARY KEY("subsystem","target_date","origin_kind","gate_profile","data_version"),
	CONSTRAINT "diagnosis_attribution_is_a_forecast" CHECK ("diagnosis_attribution"."published_at" < ("diagnosis_attribution"."target_date"::timestamp at time zone 'America/Sao_Paulo')),
	CONSTRAINT "diagnosis_attribution_target" CHECK ("diagnosis_attribution"."target" = 'expected_mwh_day'),
	CONSTRAINT "diagnosis_attribution_whole_day" CHECK ("diagnosis_attribution"."hours_attributed" = 24),
	CONSTRAINT "diagnosis_attribution_peak_hour" CHECK ("diagnosis_attribution"."peak_hour_local" between 0 and 23),
	CONSTRAINT "diagnosis_attribution_stderr_non_negative" CHECK ("diagnosis_attribution"."attribution_stderr_mwh" >= 0 and "diagnosis_attribution"."baseline_stderr_mwh" >= 0),
	CONSTRAINT "diagnosis_attribution_sum_abs_non_negative" CHECK ("diagnosis_attribution"."sum_abs_attributed_mwh" >= 0),
	CONSTRAINT "diagnosis_attribution_top_two_share" CHECK ("diagnosis_attribution"."top_two_share" between 0 and 1),
	CONSTRAINT "diagnosis_attribution_measured_against_something" CHECK ("diagnosis_attribution"."background_rows" > 0 and "diagnosis_attribution"."coalitions" > 0 and "diagnosis_attribution"."stderr_resamples" > 0),
	CONSTRAINT "diagnosis_attribution_group_hash_present" CHECK ("diagnosis_attribution"."driver_group_hash" <> '' and "diagnosis_attribution"."driver_group_version" <> ''),
	CONSTRAINT "diagnosis_attribution_rule_flags_array" CHECK (jsonb_typeof("diagnosis_attribution"."rule_flags") = 'array')
);
--> statement-breakpoint
CREATE TABLE "diagnosis_attribution_driver" (
	"subsystem" "subsystem_code" NOT NULL,
	"target_date" date NOT NULL,
	"origin_kind" "forecast_origin_kind" NOT NULL,
	"gate_profile" "forecast_gate_profile" NOT NULL,
	"data_version" integer NOT NULL,
	"grain" "diagnosis_attribution_grain" NOT NULL,
	"driver_group" text NOT NULL,
	"label_code" text NOT NULL,
	"rank" integer NOT NULL,
	"phi_mwh" double precision NOT NULL,
	"share" double precision NOT NULL,
	"direction" "diagnosis_driver_direction" NOT NULL,
	"hour_disagreement" double precision,
	"headline_feature" text NOT NULL,
	"observed" double precision NOT NULL,
	"typical" double precision NOT NULL,
	"unit" text NOT NULL,
	"demoted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "diagnosis_attribution_driver_subsystem_target_date_origin_kind_gate_profile_data_version_grain_driver_group_pk" PRIMARY KEY("subsystem","target_date","origin_kind","gate_profile","data_version","grain","driver_group"),
	CONSTRAINT "diagnosis_attribution_driver_share" CHECK ("diagnosis_attribution_driver"."share" between 0 and 1),
	CONSTRAINT "diagnosis_attribution_driver_rank" CHECK ("diagnosis_attribution_driver"."rank" between 1 and 8),
	CONSTRAINT "diagnosis_attribution_driver_direction_follows_sign" CHECK (("diagnosis_attribution_driver"."phi_mwh" < 0) = ("diagnosis_attribution_driver"."direction" = 'lowers')),
	CONSTRAINT "diagnosis_attribution_driver_disagreement_is_a_day_figure" CHECK (("diagnosis_attribution_driver"."grain" = 'day') = ("diagnosis_attribution_driver"."hour_disagreement" is not null)),
	CONSTRAINT "diagnosis_attribution_driver_disagreement_at_least_one" CHECK ("diagnosis_attribution_driver"."hour_disagreement" is null or "diagnosis_attribution_driver"."hour_disagreement" >= 1)
);
--> statement-breakpoint
ALTER TABLE "diagnosis_attribution_driver" ADD CONSTRAINT "diagnosis_attribution_driver_publication" FOREIGN KEY ("subsystem","target_date","origin_kind","gate_profile","data_version") REFERENCES "public"."diagnosis_attribution"("subsystem","target_date","origin_kind","gate_profile","data_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_attribution_as_of" ON "diagnosis_attribution" USING btree ("target_date","subsystem","ingested_at");--> statement-breakpoint
CREATE INDEX "diagnosis_attribution_driver_ranked" ON "diagnosis_attribution_driver" USING btree ("target_date","subsystem","grain","rank");--> statement-breakpoint
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
