CREATE TYPE "public"."operation_modality" AS ENUM('TIPO_I', 'TIPO_II_A', 'TIPO_II_B', 'TIPO_II_C');--> statement-breakpoint
CREATE TABLE "conjunto" (
	"ons_conjunto_code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subsystem" "subsystem_code" NOT NULL,
	"state_code" text NOT NULL,
	"technology" "technology",
	"source_type_code" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conjunto_membership" (
	"plant_ons_code" text NOT NULL,
	"conjunto_code" text NOT NULL,
	"member_from" timestamp with time zone NOT NULL,
	"member_to" timestamp with time zone,
	"plant_ceg_core" text,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "conjunto_membership_plant_ons_code_conjunto_code_member_from_data_version_pk" PRIMARY KEY("plant_ons_code","conjunto_code","member_from","data_version"),
	CONSTRAINT "conjunto_membership_ordered" CHECK ("conjunto_membership"."member_to" is null or "conjunto_membership"."member_to" >= "conjunto_membership"."member_from")
);
--> statement-breakpoint
CREATE TABLE "generating_unit" (
	"plant_ceg_core" text NOT NULL,
	"equipment_code" text NOT NULL,
	"unit_number" text NOT NULL,
	"name" text NOT NULL,
	"rated_power_mw" double precision NOT NULL,
	"test_entry_on" timestamp with time zone,
	"commissioned_on" timestamp with time zone NOT NULL,
	"decommissioned_on" timestamp with time zone,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "generating_unit_plant_ceg_core_equipment_code_data_version_pk" PRIMARY KEY("plant_ceg_core","equipment_code","data_version")
);
--> statement-breakpoint
CREATE TABLE "plant" (
	"ceg_core" text PRIMARY KEY NOT NULL,
	"ceg_raw" text NOT NULL,
	"ons_plant_code" text,
	"name" text NOT NULL,
	"subsystem" "subsystem_code" NOT NULL,
	"state_code" text NOT NULL,
	"technology" "technology" NOT NULL,
	"operation_modality" "operation_modality" NOT NULL,
	"owner_name" text NOT NULL,
	"operator_name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conjunto_membership" ADD CONSTRAINT "conjunto_membership_conjunto_code_conjunto_ons_conjunto_code_fk" FOREIGN KEY ("conjunto_code") REFERENCES "public"."conjunto"("ons_conjunto_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conjunto_membership" ADD CONSTRAINT "conjunto_membership_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generating_unit" ADD CONSTRAINT "generating_unit_plant_ceg_core_plant_ceg_core_fk" FOREIGN KEY ("plant_ceg_core") REFERENCES "public"."plant"("ceg_core") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generating_unit" ADD CONSTRAINT "generating_unit_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conjunto_subsystem_technology" ON "conjunto" USING btree ("subsystem","technology");--> statement-breakpoint
CREATE INDEX "conjunto_membership_as_of" ON "conjunto_membership" USING btree ("member_from","plant_ons_code","ingested_at");--> statement-breakpoint
CREATE INDEX "conjunto_membership_conjunto" ON "conjunto_membership" USING btree ("conjunto_code","member_from");--> statement-breakpoint
CREATE INDEX "generating_unit_as_of" ON "generating_unit" USING btree ("commissioned_on","plant_ceg_core","ingested_at");--> statement-breakpoint
CREATE INDEX "generating_unit_interval" ON "generating_unit" USING btree ("commissioned_on","decommissioned_on");--> statement-breakpoint
CREATE INDEX "plant_subsystem_technology" ON "plant" USING btree ("subsystem","technology");--> statement-breakpoint
CREATE INDEX "plant_ons_code" ON "plant" USING btree ("ons_plant_code");