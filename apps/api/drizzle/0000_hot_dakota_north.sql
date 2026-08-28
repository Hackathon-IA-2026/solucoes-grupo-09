CREATE TYPE "public"."published_at_precision" AS ENUM('row', 'file');--> statement-breakpoint
CREATE TYPE "public"."resource_format" AS ENUM('PARQUET', 'CSV');--> statement-breakpoint
CREATE TYPE "public"."subsystem_code" AS ENUM('N', 'NE', 'S', 'SE');--> statement-breakpoint
CREATE TABLE "ons_resource_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_slug" text NOT NULL,
	"resource_name" text NOT NULL,
	"resource_url" text NOT NULL,
	"format" "resource_format" NOT NULL,
	"change_key" text NOT NULL,
	"last_modified" timestamp with time zone,
	"content_length" bigint,
	"etag" text,
	"content_sha256" text,
	"byte_size" bigint,
	"archive_uri" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subsystem_energy_balance_hour" (
	"subsystem" "subsystem_code" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"data_version" integer NOT NULL,
	"load_mwh" double precision NOT NULL,
	"hydro_generation_mwh" double precision NOT NULL,
	"thermal_generation_mwh" double precision NOT NULL,
	"wind_generation_mwh" double precision NOT NULL,
	"solar_generation_mwh" double precision NOT NULL,
	"net_exchange_mwh" double precision NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "subsystem_energy_balance_hour_subsystem_valid_time_data_version_pk" PRIMARY KEY("subsystem","valid_time","data_version")
);
--> statement-breakpoint
ALTER TABLE "subsystem_energy_balance_hour" ADD CONSTRAINT "subsystem_energy_balance_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ons_resource_version_identity" ON "ons_resource_version" USING btree ("resource_url","change_key");--> statement-breakpoint
CREATE INDEX "ons_resource_version_dataset" ON "ons_resource_version" USING btree ("dataset_slug","first_seen_at");--> statement-breakpoint
CREATE INDEX "subsystem_energy_balance_hour_as_of" ON "subsystem_energy_balance_hour" USING btree ("valid_time","subsystem","ingested_at");