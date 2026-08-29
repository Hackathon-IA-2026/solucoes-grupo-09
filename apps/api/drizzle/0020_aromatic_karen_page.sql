CREATE TABLE "feature_publication_lag" (
	"dataset" text PRIMARY KEY NOT NULL,
	"canonical_read" text NOT NULL,
	"publication_lag_hours" integer NOT NULL,
	"rationale" text NOT NULL,
	CONSTRAINT "feature_publication_lag_non_negative" CHECK ("feature_publication_lag"."publication_lag_hours" >= 0)
);
