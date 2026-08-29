CREATE TABLE "feature_ab_configuration" (
	"run" text PRIMARY KEY NOT NULL,
	"feature_set" text NOT NULL,
	"window_from" date NOT NULL,
	"gate_profile" text NOT NULL,
	"isolates" text NOT NULL,
	CONSTRAINT "feature_ab_configuration_gate" CHECK ("feature_ab_configuration"."gate_profile" in ('gate_early', 'gate_late'))
);
--> statement-breakpoint
CREATE TABLE "feature_dictionary_entry" (
	"column_name" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"classes" text[] NOT NULL,
	"source" text NOT NULL,
	"grain" text,
	"in_dessem_free_v1" boolean NOT NULL,
	"in_dessem_augmented_v1" boolean NOT NULL,
	"available_at_gate_early" boolean NOT NULL,
	"is_proxy" boolean NOT NULL,
	"justifies_dessem_trade" boolean NOT NULL,
	"model_input" boolean NOT NULL,
	CONSTRAINT "feature_dictionary_entry_role" CHECK ("feature_dictionary_entry"."role" in ('identity', 'stamp', 'feature', 'label')),
	CONSTRAINT "feature_dictionary_entry_classes_known" CHECK ("feature_dictionary_entry"."classes" <@ array['D', 'W', 'P', 'K', 'T']),
	CONSTRAINT "feature_dictionary_entry_features_are_classified" CHECK (("feature_dictionary_entry"."role" = 'feature') = (cardinality("feature_dictionary_entry"."classes") > 0)),
	CONSTRAINT "feature_dictionary_entry_grain" CHECK (("feature_dictionary_entry"."grain" is null) = ("feature_dictionary_entry"."role" in ('identity', 'stamp'))
          and ("feature_dictionary_entry"."grain" is null or "feature_dictionary_entry"."grain" in ('hour', 'day'))),
	CONSTRAINT "feature_dictionary_entry_in_some_set" CHECK ("feature_dictionary_entry"."in_dessem_free_v1" or "feature_dictionary_entry"."in_dessem_augmented_v1"),
	CONSTRAINT "feature_dictionary_entry_dessem_is_augmented_only" CHECK (not ('D' = any("feature_dictionary_entry"."classes"))
          or ("feature_dictionary_entry"."in_dessem_augmented_v1"
              and not "feature_dictionary_entry"."in_dessem_free_v1"
              and not "feature_dictionary_entry"."available_at_gate_early")),
	CONSTRAINT "feature_dictionary_entry_trade_is_augmented_only" CHECK (not "feature_dictionary_entry"."justifies_dessem_trade"
          or ("feature_dictionary_entry"."in_dessem_augmented_v1" and not "feature_dictionary_entry"."in_dessem_free_v1")),
	CONSTRAINT "feature_dictionary_entry_model_input" CHECK (("feature_dictionary_entry"."role" = 'feature' and "feature_dictionary_entry"."model_input")
          or ("feature_dictionary_entry"."role" = 'identity' and "feature_dictionary_entry"."column_name" = 'subsystem' and "feature_dictionary_entry"."model_input")
          or not "feature_dictionary_entry"."model_input")
);
--> statement-breakpoint
CREATE TABLE "feature_dropped_feature" (
	"idea_feature" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"replacement" text NOT NULL,
	"replacement_columns" text[] NOT NULL,
	CONSTRAINT "feature_dropped_feature_reason" CHECK (length("feature_dropped_feature"."reason") > 0),
	CONSTRAINT "feature_dropped_feature_replacement" CHECK (length("feature_dropped_feature"."replacement") > 0)
);
--> statement-breakpoint
CREATE TABLE "feature_set_definition" (
	"feature_set" text PRIMARY KEY NOT NULL,
	"window_from" date NOT NULL,
	"window_from_driver" text NOT NULL,
	"gates" text[] NOT NULL,
	"residual_load_column" text NOT NULL,
	CONSTRAINT "feature_set_definition_known" CHECK ("feature_set_definition"."feature_set" in ('dessem_free_v1', 'dessem_augmented_v1')),
	CONSTRAINT "feature_set_definition_gates" CHECK (cardinality("feature_set_definition"."gates") > 0 and "feature_set_definition"."gates" <@ array['gate_early', 'gate_late'])
);
--> statement-breakpoint
ALTER TABLE "feature_ab_configuration" ADD CONSTRAINT "feature_ab_configuration_feature_set_feature_set_definition_feature_set_fk" FOREIGN KEY ("feature_set") REFERENCES "public"."feature_set_definition"("feature_set") ON DELETE no action ON UPDATE no action;