CREATE TYPE "public"."calendar_holiday_category" AS ENUM('public', 'optional');--> statement-breakpoint
CREATE TABLE "feature_calendar_day" (
	"calendar_version" text NOT NULL,
	"day" date NOT NULL,
	"uf" text NOT NULL,
	"name" text NOT NULL,
	"category" "calendar_holiday_category" NOT NULL,
	CONSTRAINT "feature_calendar_day_calendar_version_day_uf_name_pk" PRIMARY KEY("calendar_version","day","uf","name")
);
--> statement-breakpoint
CREATE TABLE "feature_calendar_generation" (
	"version" text PRIMARY KEY NOT NULL,
	"generator" text NOT NULL,
	"digest" text NOT NULL,
	"day_from" date NOT NULL,
	"day_to" date NOT NULL,
	"day_count" integer NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_calendar_day" ADD CONSTRAINT "feature_calendar_day_calendar_version_feature_calendar_generation_version_fk" FOREIGN KEY ("calendar_version") REFERENCES "public"."feature_calendar_generation"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_calendar_day_lookup" ON "feature_calendar_day" USING btree ("calendar_version","day","uf");--> statement-breakpoint
CREATE VIEW "public"."canonical_solar_centroid" AS (
  select
    set_version,
    sum(latitude * represented_mw) / nullif(sum(represented_mw), 0) as latitude,
    sum(longitude * represented_mw) / nullif(sum(represented_mw), 0) as longitude,
    sum(represented_mw) as represented_mw,
    count(*)::int as centroids
  from centroid_point
  where technology = 'SOLAR'
  group by set_version
);--> statement-breakpoint
CREATE VIEW "public"."canonical_subsystem_state" AS (
  select subsystem, state_code as uf, count(*)::int as plants
  from plant
  group by subsystem, state_code
);