CREATE TYPE "public"."custody_provenance" AS ENUM('bulk_resource', 'load_api_request');--> statement-breakpoint
CREATE TYPE "public"."ingestion_run_status" AS ENUM('running', 'ok', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ingestion_source" AS ENUM('energy_balance', 'constrained_off_wind', 'constrained_off_solar', 'interchange', 'daily_load', 'dessem_balance', 'verified_load', 'programmed_load', 'plant_registry');--> statement-breakpoint
CREATE TYPE "public"."refresh_tier" AS ENUM('live', 'recent', 'history', 'manual');--> statement-breakpoint
CREATE TABLE "ingestion_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "ingestion_source" NOT NULL,
	"tier" "refresh_tier" NOT NULL,
	"period_label" text,
	"status" "ingestion_run_status" NOT NULL,
	"resources_probed" integer DEFAULT 0 NOT NULL,
	"resources_downloaded" integer DEFAULT 0 NOT NULL,
	"rows_parsed" integer DEFAULT 0 NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"rows_revised" integer DEFAULT 0 NOT NULL,
	"rows_unchanged" integer DEFAULT 0 NOT NULL,
	"republications" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payload_custody" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provenance" "custody_provenance" NOT NULL,
	"provenance_id" uuid NOT NULL,
	"dataset_slug" text NOT NULL,
	"resource_name" text NOT NULL,
	"archive_uri" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone,
	"purge_reason" text
);
--> statement-breakpoint
CREATE TABLE "resource_republication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_slug" text NOT NULL,
	"resource_name" text NOT NULL,
	"resource_url" text NOT NULL,
	"prior_version_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"prior_fetched_at" timestamp with time zone NOT NULL,
	"settled_days" integer NOT NULL,
	"tier" "refresh_tier",
	"run_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_republication" ADD CONSTRAINT "resource_republication_prior_version_id_ons_resource_version_id_fk" FOREIGN KEY ("prior_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_republication" ADD CONSTRAINT "resource_republication_version_id_ons_resource_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingestion_run_source" ON "ingestion_run" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "ingestion_run_status_time" ON "ingestion_run" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payload_custody_provenance" ON "payload_custody" USING btree ("provenance","provenance_id");--> statement-breakpoint
CREATE INDEX "payload_custody_retention" ON "payload_custody" USING btree ("purged_at","fetched_at");--> statement-breakpoint
CREATE INDEX "payload_custody_uri" ON "payload_custody" USING btree ("archive_uri");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_republication_pair" ON "resource_republication" USING btree ("prior_version_id","version_id");--> statement-breakpoint
CREATE INDEX "resource_republication_detected" ON "resource_republication" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "resource_republication_dataset" ON "resource_republication" USING btree ("dataset_slug","detected_at");