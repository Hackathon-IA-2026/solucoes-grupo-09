CREATE TYPE "public"."reason_code" AS ENUM('REL', 'CNF', 'ENE', 'PAR');--> statement-breakpoint
CREATE TYPE "public"."reporting_entity_kind" AS ENUM('CONJUNTO', 'PLANT');--> statement-breakpoint
CREATE TYPE "public"."restriction_origin" AS ENUM('LOC', 'SIS');--> statement-breakpoint
CREATE TYPE "public"."technology" AS ENUM('WIND', 'SOLAR');--> statement-breakpoint
CREATE TABLE "curtailment_report_hour" (
	"reporting_entity_code" text NOT NULL,
	"technology" "technology" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"data_version" integer NOT NULL,
	"generation_mwh" double precision NOT NULL,
	"constrained_off_mwh" double precision NOT NULL,
	"reference_generation_mwh" double precision,
	"final_reference_generation_mwh" double precision,
	"availability_mw" double precision,
	"half_hours_observed" integer NOT NULL,
	"reason" "reason_code",
	"origin" "restriction_origin",
	"restriction_description" text,
	"cause_mixed" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "curtailment_report_hour_reporting_entity_code_technology_valid_time_data_version_pk" PRIMARY KEY("reporting_entity_code","technology","valid_time","data_version"),
	CONSTRAINT "curtailment_cause_whole" CHECK (("curtailment_report_hour"."reason" is null) = ("curtailment_report_hour"."origin" is null))
);
--> statement-breakpoint
CREATE TABLE "reporting_entity" (
	"ons_code" text PRIMARY KEY NOT NULL,
	"kind" "reporting_entity_kind" NOT NULL,
	"ceg_core" text,
	"name" text NOT NULL,
	"subsystem" "subsystem_code" NOT NULL,
	"state_code" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curtailment_report_hour" ADD CONSTRAINT "curtailment_report_hour_reporting_entity_code_reporting_entity_ons_code_fk" FOREIGN KEY ("reporting_entity_code") REFERENCES "public"."reporting_entity"("ons_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curtailment_report_hour" ADD CONSTRAINT "curtailment_report_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "curtailment_report_hour_as_of" ON "curtailment_report_hour" USING btree ("valid_time","reporting_entity_code","technology","ingested_at");--> statement-breakpoint
CREATE INDEX "curtailment_report_hour_time" ON "curtailment_report_hour" USING btree ("valid_time","technology");--> statement-breakpoint
CREATE INDEX "reporting_entity_subsystem" ON "reporting_entity" USING btree ("subsystem","kind");