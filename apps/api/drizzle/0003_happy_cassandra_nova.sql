CREATE TYPE "public"."forecast_producer" AS ENUM('ons_dessem', 'open_meteo', 'wattsteer');--> statement-breakpoint
CREATE TABLE "dessem_balance_half_hour" (
	"subsystem" "subsystem_code" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"forecast_producer" "forecast_producer" NOT NULL,
	"run_label" text NOT NULL,
	"demand_mw" double precision NOT NULL,
	"hydro_generation_mw" double precision NOT NULL,
	"small_hydro_generation_mw" double precision NOT NULL,
	"thermal_generation_mw" double precision NOT NULL,
	"small_thermal_generation_mw" double precision NOT NULL,
	"wind_generation_mw" double precision NOT NULL,
	"solar_generation_mw" double precision NOT NULL,
	"mmgd_generation_mw" double precision NOT NULL,
	"pumping_consumption_mw" double precision NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "dessem_balance_half_hour_subsystem_valid_time_data_version_pk" PRIMARY KEY("subsystem","valid_time","data_version"),
	CONSTRAINT "dessem_balance_is_a_forecast" CHECK ("dessem_balance_half_hour"."published_at" < "dessem_balance_half_hour"."valid_time")
);
--> statement-breakpoint
ALTER TABLE "dessem_balance_half_hour" ADD CONSTRAINT "dessem_balance_half_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dessem_balance_half_hour_as_of" ON "dessem_balance_half_hour" USING btree ("valid_time","subsystem","ingested_at");--> statement-breakpoint
CREATE INDEX "dessem_balance_half_hour_published" ON "dessem_balance_half_hour" USING btree ("published_at","valid_time");