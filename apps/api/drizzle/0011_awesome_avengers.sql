CREATE TYPE "public"."centroid_collision_check" AS ENUM('asserted', 'unchecked');--> statement-breakpoint
CREATE TYPE "public"."centroid_drift_outcome" AS ENUM('within_tolerance', 'regeneration_triggered');--> statement-breakpoint
CREATE TYPE "public"."centroid_point_origin" AS ENUM('municipality_centroid', 'hand_transcribed');--> statement-breakpoint
CREATE TYPE "public"."centroid_set_source" AS ENUM('hand_transcribed', 'generated');--> statement-breakpoint
CREATE TABLE "centroid_drift_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_version" text NOT NULL,
	"fleet_on" timestamp with time zone NOT NULL,
	"registry_as_of" timestamp with time zone NOT NULL,
	"mean_distance_km" double precision,
	"baseline_mean_distance_km" double precision,
	"drift_ratio" double precision,
	"trigger_ratio" double precision NOT NULL,
	"outcome" "centroid_drift_outcome" NOT NULL,
	"located_mw" double precision NOT NULL,
	"plants" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "centroid_point" (
	"set_version" text NOT NULL,
	"centroid_id" text NOT NULL,
	"label" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"technology" "technology" NOT NULL,
	"represented_mw" double precision NOT NULL,
	"origin" "centroid_point_origin" NOT NULL,
	"municipalities" text NOT NULL,
	"plants" integer NOT NULL,
	"merged_from" text NOT NULL,
	"grid_latitude" double precision,
	"grid_longitude" double precision,
	CONSTRAINT "centroid_point_set_version_centroid_id_pk" PRIMARY KEY("set_version","centroid_id")
);
--> statement-breakpoint
CREATE TABLE "centroid_set" (
	"version" text PRIMARY KEY NOT NULL,
	"source" "centroid_set_source" NOT NULL,
	"geometry_digest" text NOT NULL,
	"centroid_count" integer NOT NULL,
	"represented_mw" double precision NOT NULL,
	"registry_as_of" timestamp with time zone NOT NULL,
	"fleet_on" timestamp with time zone NOT NULL,
	"freeze_mean_distance_km" double precision,
	"freeze_located_mw" double precision NOT NULL,
	"freeze_plants" integer NOT NULL,
	"cluster_radius_km" double precision,
	"min_cluster_mw" double precision,
	"collision_check" "centroid_collision_check" NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "centroid_drift_check" ADD CONSTRAINT "centroid_drift_check_set_version_centroid_set_version_fk" FOREIGN KEY ("set_version") REFERENCES "public"."centroid_set"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "centroid_point" ADD CONSTRAINT "centroid_point_set_version_centroid_set_version_fk" FOREIGN KEY ("set_version") REFERENCES "public"."centroid_set"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "centroid_drift_check_set" ON "centroid_drift_check" USING btree ("set_version","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "centroid_point_cell" ON "centroid_point" USING btree ("set_version","grid_latitude","grid_longitude");--> statement-breakpoint
CREATE INDEX "centroid_point_technology" ON "centroid_point" USING btree ("set_version","technology");--> statement-breakpoint
CREATE INDEX "centroid_set_frozen" ON "centroid_set" USING btree ("frozen_at");