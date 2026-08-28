CREATE TYPE "public"."load_area_code" AS ENUM('SECO', 'S', 'NE', 'N', 'RJ', 'SP', 'MG', 'ES', 'MT', 'MS', 'DF', 'GO', 'AC', 'RO', 'PR', 'SC', 'RS', 'BASE', 'BAOE', 'ALPE', 'PBRN', 'CE', 'PI', 'TON', 'PA', 'MA', 'AP', 'AM', 'RR', 'PESE', 'PES', 'PENE', 'PEN');--> statement-breakpoint
CREATE TYPE "public"."load_area_kind" AS ENUM('SUBSYSTEM', 'GEOELECTRIC', 'LOSSES');--> statement-breakpoint
CREATE TYPE "public"."load_series" AS ENUM('VERIFIED', 'PROGRAMMED');--> statement-breakpoint
CREATE TABLE "load_api_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series" "load_series" NOT NULL,
	"area_code" "load_area_code" NOT NULL,
	"range_start" text NOT NULL,
	"range_end" text NOT NULL,
	"request_url" text NOT NULL,
	"http_status" integer NOT NULL,
	"row_count" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"json_repaired" integer DEFAULT 0 NOT NULL,
	"archive_uri" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programmed_load_half_hour" (
	"area_code" "load_area_code" NOT NULL,
	"area_kind" "load_area_kind" NOT NULL,
	"subsystem" "subsystem_code",
	"valid_time" timestamp with time zone NOT NULL,
	"programmed_load_mwh" double precision NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_request_id" uuid NOT NULL,
	CONSTRAINT "programmed_load_half_hour_area_code_valid_time_data_version_pk" PRIMARY KEY("area_code","valid_time","data_version"),
	CONSTRAINT "programmed_load_subsystem_only_for_subsystem_area" CHECK (("programmed_load_half_hour"."subsystem" is null) = ("programmed_load_half_hour"."area_kind" <> 'SUBSYSTEM'))
);
--> statement-breakpoint
CREATE TABLE "verified_load_half_hour" (
	"area_code" "load_area_code" NOT NULL,
	"area_kind" "load_area_kind" NOT NULL,
	"subsystem" "subsystem_code",
	"valid_time" timestamp with time zone NOT NULL,
	"load_mwh" double precision NOT NULL,
	"consisted_load_mwh" double precision,
	"load_net_of_mmgd_mwh" double precision,
	"supervised_load_mwh" double precision,
	"unsupervised_load_mwh" double precision,
	"mmgd_load_mwh" double precision,
	"consistency_adjustment_mwh" double precision,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_request_id" uuid NOT NULL,
	CONSTRAINT "verified_load_half_hour_area_code_valid_time_data_version_pk" PRIMARY KEY("area_code","valid_time","data_version"),
	CONSTRAINT "verified_load_subsystem_only_for_subsystem_area" CHECK (("verified_load_half_hour"."subsystem" is null) = ("verified_load_half_hour"."area_kind" <> 'SUBSYSTEM'))
);
--> statement-breakpoint
ALTER TABLE "programmed_load_half_hour" ADD CONSTRAINT "programmed_load_half_hour_source_request_id_load_api_request_id_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."load_api_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_load_half_hour" ADD CONSTRAINT "verified_load_half_hour_source_request_id_load_api_request_id_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."load_api_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "load_api_request_window" ON "load_api_request" USING btree ("series","area_code","range_start");--> statement-breakpoint
CREATE INDEX "load_api_request_fetched" ON "load_api_request" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "programmed_load_half_hour_as_of" ON "programmed_load_half_hour" USING btree ("valid_time","area_code","ingested_at");--> statement-breakpoint
CREATE INDEX "verified_load_half_hour_as_of" ON "verified_load_half_hour" USING btree ("valid_time","area_code","ingested_at");--> statement-breakpoint
CREATE INDEX "verified_load_half_hour_subsystem" ON "verified_load_half_hour" USING btree ("subsystem","valid_time");