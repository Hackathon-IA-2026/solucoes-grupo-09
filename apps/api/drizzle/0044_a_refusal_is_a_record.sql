-- A refusal is a record: the diagnosis publication the system declined to make.
--
-- `.scratch/api-surface/issues/10-forecast-publication.md`'s publication watch
-- named its own gap — it watches the *forecast* publication and not the chained
-- `publish_diagnosis` that a finished forecast publication submits. Watching the
-- chain needs one fact Postgres did not hold.
--
-- An absent attribution has two causes and they are opposites. Either the chain
-- broke — the task was never queued, never ran, or died in its retries, and the
-- forecast is serving with no explanation beside it and nobody was told — or
-- `apps/ml` was asked and *refused*, naming one of the four conditions in
-- `wattsteer_ml.diagnosis.publish.REFUSAL_CONDITIONS`. The second is the system
-- working correctly, and until this table it was a `console.warn` in a worker
-- log: unreadable to anything on a schedule. A watch that could not tell the two
-- apart would have alarmed on every legitimately unexplainable lane-day, and an
-- alarm that fires on correct behaviour is switched off inside a week.
--
-- One current answer per lane-day, upserted rather than appended: a retry that
-- refuses again is the same refusal observed again. `observed_at` is what places
-- a refusal against the forecast publication it followed — a refusal older than
-- the serving forecast rows' `ingested_at` is a *stale* statement about a
-- previous vintage and does not silence the watch.
--
-- `expected_published_at` carries `0041`'s constraint, calling `gate_at` rather
-- than spelling the gate hour a fifth time: the refusal is stamped with the
-- instant the attribution it stands in place of would have carried, so a row
-- here and the forecast rows it stands beside cannot disagree about which
-- publication was refused.
--
-- No canonical view reads this table and nothing in the request path does
-- either. `/v1/diagnosis/day-ahead` still answers an absent attribution as its
-- own absence; a reader asking what we said must not be handed the reason we
-- said nothing. The one reader is `src/forecast/publication-watch.ts`.
CREATE TABLE "diagnosis_publication_refusal" (
	"target_date" date NOT NULL,
	"gate_profile" "forecast_gate_profile" NOT NULL,
	"lane" text NOT NULL,
	"expected_published_at" timestamp with time zone NOT NULL,
	"condition" text NOT NULL,
	"reason" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnosis_publication_refusal_pk" PRIMARY KEY("target_date","gate_profile","lane"),
	CONSTRAINT "diagnosis_publication_refusal_condition" CHECK ("diagnosis_publication_refusal"."condition" in ('no_base_fit_window', 'no_matched_background', 'contract_and_groups_disagree', 'incomplete_day')),
	CONSTRAINT "diagnosis_publication_refusal_reason_given" CHECK (length("diagnosis_publication_refusal"."reason") > 0),
	CONSTRAINT "diagnosis_publication_refusal_expected_at_is_the_gate" CHECK ("diagnosis_publication_refusal"."expected_published_at" = gate_at("diagnosis_publication_refusal"."target_date", "diagnosis_publication_refusal"."gate_profile"::text))
);
--> statement-breakpoint
CREATE INDEX "diagnosis_publication_refusal_observed" ON "diagnosis_publication_refusal" USING btree ("observed_at");