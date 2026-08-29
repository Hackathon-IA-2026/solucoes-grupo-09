DROP VIEW "public"."canonical_curtailment_by_reporting_entity";--> statement-breakpoint
CREATE VIEW "public"."canonical_curtailment_by_reporting_entity" AS (
  select distinct on (c.reporting_entity_code, c.technology, c.valid_time)
    c.reporting_entity_code,
    e.kind as reporting_entity_kind,
    e.name as reporting_entity_name,
    e.subsystem,
    c.technology,
    c.valid_time,
    c.constrained_off_mwh,
    c.verified_generation_mwh,
    c.reference_generation_mwh,
    c.final_reference_generation_mwh,
    c.available_capacity_mw,
    c.half_hours_observed,
    c.reason as restriction_reason,
    c.origin as restriction_origin,
    c.restriction_description,
    (c.cause_mixed = 1) as restriction_cause_mixed,
    c.data_version,
    c.published_at,
    c.ingested_at
  from curtailment_report_hour c
  join reporting_entity e on e.ons_code = c.reporting_entity_code
  where c.ingested_at <= canonical_as_of()
  order by c.reporting_entity_code, c.technology, c.valid_time,
           c.ingested_at desc, c.data_version desc
);