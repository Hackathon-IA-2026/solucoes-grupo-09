CREATE TYPE "public"."weather_model" AS ENUM('ecmwf_ifs');--> statement-breakpoint
CREATE TYPE "public"."weather_run_cycle" AS ENUM('00Z', '12Z');--> statement-breakpoint
CREATE TABLE "weather_forecast_hour" (
	"centroid_id" text NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"grid_latitude" double precision NOT NULL,
	"grid_longitude" double precision NOT NULL,
	"grid_elevation_m" double precision NOT NULL,
	"run_cycle" "weather_run_cycle" NOT NULL,
	"run_age_hours" integer NOT NULL,
	"wind_speed100m_kmh" double precision,
	"wind_speed120m_kmh" double precision,
	"wind_direction120m_deg" double precision,
	"wind_gusts10m_kmh" double precision,
	"temperature2m_c" double precision,
	"surface_pressure_hpa" double precision,
	"relative_humidity2m_pct" double precision,
	"precipitation_mm" double precision,
	"shortwave_radiation_wm2" double precision,
	"direct_normal_irradiance_wm2" double precision,
	"diffuse_radiation_wm2" double precision,
	"cloud_cover_pct" double precision,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_request_id" uuid NOT NULL,
	CONSTRAINT "weather_forecast_hour_centroid_id_valid_time_data_version_pk" PRIMARY KEY("centroid_id","valid_time","data_version"),
	CONSTRAINT "weather_forecast_published_at_is_run_init" CHECK (date_part('minute', "weather_forecast_hour"."published_at" at time zone 'UTC') = 0
          and date_part('second', "weather_forecast_hour"."published_at" at time zone 'UTC') = 0
          and date_part('hour', "weather_forecast_hour"."published_at" at time zone 'UTC')
              = case when "weather_forecast_hour"."run_cycle" = '00Z' then 0 else 12 end),
	CONSTRAINT "weather_forecast_run_age_non_negative" CHECK ("weather_forecast_hour"."run_age_hours" >= 0)
);
--> statement-breakpoint
CREATE TABLE "weather_run_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" "weather_model" NOT NULL,
	"run_init" timestamp with time zone NOT NULL,
	"run_cycle" "weather_run_cycle" NOT NULL,
	"scheduled_run_init" timestamp with time zone NOT NULL,
	"centroid_set_version" text NOT NULL,
	"centroid_count" integer NOT NULL,
	"variables" text NOT NULL,
	"forecast_days" integer NOT NULL,
	"request_url" text NOT NULL,
	"http_status" integer NOT NULL,
	"row_count" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"rate_limit_retries" integer DEFAULT 0 NOT NULL,
	"archive_uri" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weather_forecast_hour" ADD CONSTRAINT "weather_forecast_hour_source_request_id_weather_run_request_id_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."weather_run_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weather_forecast_hour_as_of" ON "weather_forecast_hour" USING btree ("valid_time","centroid_id","ingested_at");--> statement-breakpoint
CREATE INDEX "weather_forecast_hour_run" ON "weather_forecast_hour" USING btree ("published_at","run_cycle");--> statement-breakpoint
CREATE INDEX "weather_run_request_run" ON "weather_run_request" USING btree ("run_init","run_cycle");--> statement-breakpoint
CREATE INDEX "weather_run_request_fetched" ON "weather_run_request" USING btree ("fetched_at");