CREATE TYPE "public"."coordinate_rejection" AS ENUM('missing', 'unparsable', 'null_island', 'out_of_bounds');--> statement-breakpoint
CREATE TYPE "public"."plant_location_source" AS ENUM('siga_coordinate', 'siga_municipality_centroid', 'unlocated');--> statement-breakpoint
CREATE TABLE "plant_geo" (
	"plant_ceg_core" text NOT NULL,
	"ceg_raw" text NOT NULL,
	"siga_name" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"location_source" "plant_location_source" NOT NULL,
	"coordinate_rejection" "coordinate_rejection",
	"municipality_name" text,
	"municipality_uf" text,
	"municipalities_raw" text NOT NULL,
	"ownership" text NOT NULL,
	"observed_on" timestamp with time zone NOT NULL,
	"withdrawn_on" timestamp with time zone,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "plant_geo_plant_ceg_core_data_version_pk" PRIMARY KEY("plant_ceg_core","data_version"),
	CONSTRAINT "plant_geo_coordinate_pair" CHECK (("plant_geo"."latitude" is null) = ("plant_geo"."longitude" is null)),
	CONSTRAINT "plant_geo_location_source" CHECK (("plant_geo"."location_source" = 'unlocated') = ("plant_geo"."latitude" is null)),
	CONSTRAINT "plant_geo_within_brazil" CHECK ("plant_geo"."latitude" is null or ("plant_geo"."latitude" between -34 and 6
           and "plant_geo"."longitude" between -74 and -33
           and not ("plant_geo"."latitude" = 0 and "plant_geo"."longitude" = 0)))
);
--> statement-breakpoint
CREATE TABLE "siga_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_date" timestamp with time zone NOT NULL,
	"source_version_id" uuid NOT NULL,
	"source_rows" integer NOT NULL,
	"fleet_rows" integer NOT NULL,
	"registry_plants" integer NOT NULL,
	"matched_plants" integer NOT NULL,
	"match_rate" double precision NOT NULL,
	"verbatim_matched_plants" integer NOT NULL,
	"null_island_rows" integer NOT NULL,
	"out_of_bounds_rows" integer NOT NULL,
	"located_plants" integer NOT NULL,
	"centroid_fallback_plants" integer NOT NULL,
	"unlocated_plants" integer NOT NULL,
	"withdrawn_plants" integer NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plant_geo" ADD CONSTRAINT "plant_geo_plant_ceg_core_plant_ceg_core_fk" FOREIGN KEY ("plant_ceg_core") REFERENCES "public"."plant"("ceg_core") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_geo" ADD CONSTRAINT "plant_geo_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siga_snapshot" ADD CONSTRAINT "siga_snapshot_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plant_geo_as_of" ON "plant_geo" USING btree ("plant_ceg_core","ingested_at");--> statement-breakpoint
CREATE INDEX "plant_geo_municipality" ON "plant_geo" USING btree ("municipality_uf","municipality_name");--> statement-breakpoint
CREATE INDEX "siga_snapshot_ingested" ON "siga_snapshot" USING btree ("ingested_at");