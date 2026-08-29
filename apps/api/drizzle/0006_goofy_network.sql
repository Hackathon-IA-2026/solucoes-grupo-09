CREATE TABLE "observed_plant" (
	"ons_code" text PRIMARY KEY NOT NULL,
	"ceg_core" text NOT NULL,
	"ceg_raw" text NOT NULL,
	"name" text NOT NULL,
	"subsystem" "subsystem_code" NOT NULL,
	"state_code" text NOT NULL,
	"technology" "technology" NOT NULL,
	"operation_modality" "operation_modality" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plant_detail_hour" (
	"plant_ons_code" text NOT NULL,
	"technology" "technology" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"estimated_generation_mwh" double precision,
	"verified_generation_mwh" double precision,
	"measured_wind_speed_ms" double precision,
	"measured_irradiance_wm2" double precision,
	"measurement_invalid" integer,
	"half_hours_observed" integer NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "plant_detail_hour_plant_ons_code_technology_valid_time_data_version_pk" PRIMARY KEY("plant_ons_code","technology","valid_time","data_version"),
	CONSTRAINT "plant_detail_measurement_whole" CHECK ((coalesce("plant_detail_hour"."measured_wind_speed_ms", "plant_detail_hour"."measured_irradiance_wm2") is null) = ("plant_detail_hour"."measurement_invalid" is null)),
	CONSTRAINT "plant_detail_measurement_technology" CHECK (case "plant_detail_hour"."technology"
            when 'WIND' then "plant_detail_hour"."measured_irradiance_wm2" is null
            else "plant_detail_hour"."measured_wind_speed_ms" is null
          end),
	CONSTRAINT "plant_detail_invalid_boolean" CHECK ("plant_detail_hour"."measurement_invalid" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE "plant_detail_hour" ADD CONSTRAINT "plant_detail_hour_plant_ons_code_observed_plant_ons_code_fk" FOREIGN KEY ("plant_ons_code") REFERENCES "public"."observed_plant"("ons_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_detail_hour" ADD CONSTRAINT "plant_detail_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observed_plant_ceg_core" ON "observed_plant" USING btree ("ceg_core");--> statement-breakpoint
CREATE INDEX "observed_plant_subsystem_technology" ON "observed_plant" USING btree ("subsystem","technology");--> statement-breakpoint
CREATE INDEX "plant_detail_hour_as_of" ON "plant_detail_hour" USING btree ("valid_time","plant_ons_code","technology","ingested_at");--> statement-breakpoint
CREATE INDEX "plant_detail_hour_time" ON "plant_detail_hour" USING btree ("valid_time","technology");