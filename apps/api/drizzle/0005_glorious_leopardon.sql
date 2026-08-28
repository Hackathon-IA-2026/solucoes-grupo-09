CREATE TYPE "public"."load_methodology_regime" AS ENUM('DISPATCHED_ONLY', 'WITH_NON_DISPATCHED', 'WITH_MMGD');--> statement-breakpoint
CREATE TABLE "subsystem_exchange_hour" (
	"from_subsystem" "subsystem_code" NOT NULL,
	"to_subsystem" "subsystem_code" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"verified_exchange_mwh" double precision NOT NULL,
	"programmed_exchange_mwh" double precision,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "subsystem_exchange_hour_from_subsystem_to_subsystem_valid_time_data_version_pk" PRIMARY KEY("from_subsystem","to_subsystem","valid_time","data_version"),
	CONSTRAINT "subsystem_exchange_canonical_orientation" CHECK ("subsystem_exchange_hour"."from_subsystem" < "subsystem_exchange_hour"."to_subsystem")
);
--> statement-breakpoint
CREATE TABLE "subsystem_load_day" (
	"subsystem" "subsystem_code" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"load_mwh" double precision NOT NULL,
	"day_minutes" integer NOT NULL,
	"methodology_regime" "load_methodology_regime" NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "subsystem_load_day_subsystem_valid_time_data_version_pk" PRIMARY KEY("subsystem","valid_time","data_version"),
	CONSTRAINT "subsystem_load_day_length" CHECK ("subsystem_load_day"."day_minutes" in (1380, 1440, 1500))
);
--> statement-breakpoint
ALTER TABLE "subsystem_exchange_hour" ADD CONSTRAINT "subsystem_exchange_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subsystem_load_day" ADD CONSTRAINT "subsystem_load_day_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subsystem_exchange_hour_as_of" ON "subsystem_exchange_hour" USING btree ("valid_time","from_subsystem","to_subsystem","ingested_at");--> statement-breakpoint
CREATE INDEX "subsystem_load_day_as_of" ON "subsystem_load_day" USING btree ("valid_time","subsystem","ingested_at");