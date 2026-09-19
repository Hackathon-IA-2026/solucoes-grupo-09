CREATE TYPE "public"."programme_technology" AS ENUM('WIND', 'SOLAR', 'HYDRO', 'THERMAL');--> statement-breakpoint
ALTER TYPE "public"."ingestion_source" ADD VALUE 'programmed_generation' BEFORE 'verified_load';--> statement-breakpoint
ALTER TYPE "public"."ingestion_source" ADD VALUE 'programmed_vs_forecast' BEFORE 'verified_load';--> statement-breakpoint
ALTER TYPE "public"."ingestion_source" ADD VALUE 'controlled_flow' BEFORE 'verified_load';--> statement-breakpoint
CREATE TABLE "controlled_flow_half_hour" (
	"element" text NOT NULL,
	"terminal" integer NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"run_label" text NOT NULL,
	"description" text NOT NULL,
	"submarket" text NOT NULL,
	"load_mw" double precision NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "controlled_flow_half_hour_element_terminal_valid_time_data_version_pk" PRIMARY KEY("element","terminal","valid_time","data_version"),
	CONSTRAINT "controlled_flow_is_a_forecast" CHECK ("controlled_flow_half_hour"."published_at" < "controlled_flow_half_hour"."valid_time"),
	CONSTRAINT "controlled_flow_submarket_is_known" CHECK ("controlled_flow_half_hour"."submarket" in ('N', 'NE', 'S', 'SE', 'RR'))
);
--> statement-breakpoint
CREATE TABLE "pdp_crosswalk" (
	"pdp_code" text NOT NULL,
	"subsystem_candidates" text[] NOT NULL,
	"technology_candidates" text[] NOT NULL,
	"determined_on" timestamp with time zone NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "pdp_crosswalk_pdp_code_data_version_pk" PRIMARY KEY("pdp_code","data_version")
);
--> statement-breakpoint
CREATE TABLE "programmed_generation_half_hour" (
	"subsystem" "subsystem_code" NOT NULL,
	"technology" "programme_technology" NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"run_label" text NOT NULL,
	"plant_count" integer NOT NULL,
	"reporting_plant_count" integer NOT NULL,
	"programmed_mw" double precision NOT NULL,
	"availability_mw" double precision,
	"inflexibility_mw" double precision,
	"unit_commitment_mw" double precision,
	"electrical_reason_mw" double precision,
	"energy_guarantee_mw" double precision,
	"export_mw" double precision,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "programmed_generation_half_hour_subsystem_technology_valid_time_data_version_pk" PRIMARY KEY("subsystem","technology","valid_time","data_version"),
	CONSTRAINT "programmed_generation_is_a_forecast" CHECK ("programmed_generation_half_hour"."published_at" < "programmed_generation_half_hour"."valid_time"),
	CONSTRAINT "programmed_generation_reporters_within_plants" CHECK ("programmed_generation_half_hour"."reporting_plant_count" between 0 and "programmed_generation_half_hour"."plant_count")
);
--> statement-breakpoint
CREATE TABLE "programmed_vs_forecast_half_hour" (
	"pdp_code" text NOT NULL,
	"valid_time" timestamp with time zone NOT NULL,
	"run_label" text NOT NULL,
	"pdp_name" text NOT NULL,
	"forecast_mw" double precision NOT NULL,
	"programmed_mw" double precision NOT NULL,
	"data_version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_at_precision" "published_at_precision" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_digest" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	CONSTRAINT "programmed_vs_forecast_half_hour_pdp_code_valid_time_data_version_pk" PRIMARY KEY("pdp_code","valid_time","data_version"),
	CONSTRAINT "programmed_vs_forecast_is_a_forecast" CHECK ("programmed_vs_forecast_half_hour"."published_at" < "programmed_vs_forecast_half_hour"."valid_time")
);
--> statement-breakpoint
ALTER TABLE "controlled_flow_half_hour" ADD CONSTRAINT "controlled_flow_half_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdp_crosswalk" ADD CONSTRAINT "pdp_crosswalk_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programmed_generation_half_hour" ADD CONSTRAINT "programmed_generation_half_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programmed_vs_forecast_half_hour" ADD CONSTRAINT "programmed_vs_forecast_half_hour_source_version_id_ons_resource_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."ons_resource_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "controlled_flow_half_hour_as_of" ON "controlled_flow_half_hour" USING btree ("valid_time","element","terminal","ingested_at");--> statement-breakpoint
CREATE INDEX "controlled_flow_half_hour_published" ON "controlled_flow_half_hour" USING btree ("published_at","valid_time");--> statement-breakpoint
CREATE INDEX "pdp_crosswalk_as_of" ON "pdp_crosswalk" USING btree ("pdp_code","ingested_at");--> statement-breakpoint
CREATE INDEX "programmed_generation_half_hour_as_of" ON "programmed_generation_half_hour" USING btree ("valid_time","subsystem","technology","ingested_at");--> statement-breakpoint
CREATE INDEX "programmed_generation_half_hour_published" ON "programmed_generation_half_hour" USING btree ("published_at","valid_time");--> statement-breakpoint
CREATE INDEX "programmed_vs_forecast_half_hour_as_of" ON "programmed_vs_forecast_half_hour" USING btree ("valid_time","pdp_code","ingested_at");--> statement-breakpoint
CREATE INDEX "programmed_vs_forecast_half_hour_published" ON "programmed_vs_forecast_half_hour" USING btree ("published_at","valid_time");--> statement-breakpoint
CREATE VIEW "public"."canonical_controlled_flow" AS (
  select distinct on (element, terminal, valid_time)
    element,
    terminal,
    valid_time,
    run_label,
    description,
    submarket,
    load_mw,
    data_version,
    published_at,
    ingested_at
  from controlled_flow_half_hour
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
  order by element, terminal, valid_time, ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_pdp_crosswalk" AS (
  select distinct on (pdp_code)
    pdp_code,
    case when cardinality(subsystem_candidates) = 1
         then subsystem_candidates[1]::subsystem_code end as subsystem,
    case cardinality(subsystem_candidates)
         when 1 then null when 0 then 'no_match' else 'ambiguous' end
      as subsystem_unavailable_reason,
    case when cardinality(technology_candidates) = 1
         then technology_candidates[1]::technology end as technology,
    case cardinality(technology_candidates)
         when 1 then null when 0 then 'no_match' else 'ambiguous' end
      as technology_unavailable_reason,
    determined_on,
    data_version,
    published_at,
    ingested_at
  from pdp_crosswalk
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
  order by pdp_code, ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_programmed_generation" AS (
  select distinct on (subsystem, technology, valid_time)
    subsystem,
    technology,
    valid_time,
    run_label,
    plant_count,
    reporting_plant_count,
    programmed_mw,
    availability_mw,
    inflexibility_mw,
    unit_commitment_mw,
    electrical_reason_mw,
    energy_guarantee_mw,
    export_mw,
    data_version,
    published_at,
    ingested_at
  from programmed_generation_half_hour
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
  order by subsystem, technology, valid_time, ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_programmed_vre" AS (
  select
    subsystem::subsystem_code as subsystem,
    technology::technology as technology,
    valid_time,
    sum(forecast_mw) as forecast_mw,
    sum(programmed_mw) as programmed_mw,
    count(*)::int as entity_count,
    case when max(total_programmed_mw) > 0
         then max(mapped_programmed_mw) / max(total_programmed_mw) end
      as mapped_programmed_share,
    case when max(total_programmed_mw) > 0 then null
         else 'nothing_programmed' end as mapped_share_unavailable_reason,
    max(total_programmed_mw) - max(mapped_programmed_mw) as unmapped_programmed_mw,
    max(data_version) as data_version,
    max(published_at) as published_at,
    max(ingested_at) as ingested_at
  from (
    select
      j.*,
      sum(j.programmed_mw) over (partition by j.valid_time) as total_programmed_mw,
      sum(case when j.subsystem is not null and j.technology is not null
               then j.programmed_mw else 0 end)
        over (partition by j.valid_time) as mapped_programmed_mw
    from (
      select
        f.valid_time, f.forecast_mw, f.programmed_mw,
        f.data_version, f.published_at, f.ingested_at,
        case when cardinality(b.subsystem_candidates) = 1
             then b.subsystem_candidates[1] end as subsystem,
        case when cardinality(b.technology_candidates) = 1
             then b.technology_candidates[1] end as technology
      from (
        select distinct on (pdp_code, valid_time)
          pdp_code, valid_time, forecast_mw, programmed_mw,
          data_version, published_at, ingested_at
        from programmed_vs_forecast_half_hour
        where ingested_at <= canonical_as_of()
          and (canonical_published_at_or_before() is null
               or published_at <= canonical_published_at_or_before())
        order by pdp_code, valid_time, ingested_at desc, data_version desc
      ) f
      left join (
        select distinct on (pdp_code)
          pdp_code, subsystem_candidates, technology_candidates
        from pdp_crosswalk
        where ingested_at <= canonical_as_of()
          and (canonical_published_at_or_before() is null
               or published_at <= canonical_published_at_or_before())
        order by pdp_code, ingested_at desc, data_version desc
      ) b on b.pdp_code = f.pdp_code
    ) j
  ) x
  where subsystem is not null and technology is not null
  group by subsystem, technology, valid_time
);--> statement-breakpoint
CREATE VIEW "public"."canonical_subsystem_programme_hour" AS (
  select
    g.subsystem,
    g.hour as valid_time,
    g.programmed_wind_mw,
    g.programmed_solar_mw,
    g.programmed_hydro_mw,
    g.programmed_thermal_mw,
    g.thermal_inflexibility_mw,
    g.thermal_unit_commitment_mw,
    g.thermal_electrical_reason_mw,
    v.pdp_wind_forecast_mw,
    v.pdp_wind_programmed_mw,
    v.pdp_solar_forecast_mw,
    v.pdp_solar_programmed_mw,
    v.pdp_mapped_programmed_share,
    greatest(g.data_version, coalesce(v.data_version, 0)) as data_version,
    greatest(g.published_at, coalesce(v.published_at, g.published_at)) as published_at,
    greatest(g.ingested_at, coalesce(v.ingested_at, g.ingested_at)) as ingested_at
  from (
    select
      subsystem,
      date_trunc('hour', valid_time) as hour,
      case when count(*) filter (where technology = 'WIND') = 2
           then avg(programmed_mw) filter (where technology = 'WIND') end
        as programmed_wind_mw,
      case when count(*) filter (where technology = 'SOLAR') = 2
           then avg(programmed_mw) filter (where technology = 'SOLAR') end
        as programmed_solar_mw,
      case when count(*) filter (where technology = 'HYDRO') = 2
           then avg(programmed_mw) filter (where technology = 'HYDRO') end
        as programmed_hydro_mw,
      case when count(*) filter (where technology = 'THERMAL') = 2
           then avg(programmed_mw) filter (where technology = 'THERMAL') end
        as programmed_thermal_mw,
      case when count(*) filter (where technology = 'THERMAL'
                                   and inflexibility_mw is not null) = 2
           then avg(inflexibility_mw) filter (where technology = 'THERMAL') end
        as thermal_inflexibility_mw,
      case when count(*) filter (where technology = 'THERMAL'
                                   and unit_commitment_mw is not null) = 2
           then avg(unit_commitment_mw) filter (where technology = 'THERMAL') end
        as thermal_unit_commitment_mw,
      case when count(*) filter (where technology = 'THERMAL'
                                   and electrical_reason_mw is not null) = 2
           then avg(electrical_reason_mw) filter (where technology = 'THERMAL') end
        as thermal_electrical_reason_mw,
      max(data_version) as data_version,
      max(published_at) as published_at,
      max(ingested_at) as ingested_at
    from canonical_programmed_generation
    group by subsystem, date_trunc('hour', valid_time)
  ) g
  left join (
    select
      subsystem,
      date_trunc('hour', valid_time) as hour,
      case when count(*) filter (where technology = 'WIND') = 2
           then avg(forecast_mw) filter (where technology = 'WIND') end
        as pdp_wind_forecast_mw,
      case when count(*) filter (where technology = 'WIND') = 2
           then avg(programmed_mw) filter (where technology = 'WIND') end
        as pdp_wind_programmed_mw,
      case when count(*) filter (where technology = 'SOLAR') = 2
           then avg(forecast_mw) filter (where technology = 'SOLAR') end
        as pdp_solar_forecast_mw,
      case when count(*) filter (where technology = 'SOLAR') = 2
           then avg(programmed_mw) filter (where technology = 'SOLAR') end
        as pdp_solar_programmed_mw,
      min(mapped_programmed_share) as pdp_mapped_programmed_share,
      max(data_version) as data_version,
      max(published_at) as published_at,
      max(ingested_at) as ingested_at
    from canonical_programmed_vre
    group by subsystem, date_trunc('hour', valid_time)
  ) v on v.subsystem = g.subsystem and v.hour = g.hour
);