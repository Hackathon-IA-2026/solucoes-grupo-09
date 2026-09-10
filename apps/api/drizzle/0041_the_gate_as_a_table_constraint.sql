-- `published_at == gate_at(target_date, gate_profile)`, as a table constraint.
--
-- `.scratch/api-surface/issues/10-forecast-publication.md`'s second named gap,
-- closed. Ticket 10 shipped the equality as a **publisher-side** check:
-- `src/forecast/publish.ts` computes `gate_at` on the gateway side, compares it
-- to the instant the modelling service stamped the payload with, and refuses
-- before its first insert. That is strong on the one path that writes today and
-- it is worth nothing on any other. The ticket said so in as many words and
-- named the reason it was not fixed there — `drizzle/` was held by another
-- agent that cycle — so this is the same sentence moved from a code path into
-- the schema, where a mis-stamped row stops being a row.
--
-- ## Why a call to `gate_at` and not a copy of the gate
--
-- The gate hour is already spelled three times: `0016_the_feature_gate.sql`'s
-- `gate_at`, which is the authority every feature row's `published_at` comes
-- out of; `packages/core`'s `GATES`, which `/v1/meta` builds its sentence from;
-- and `src/forecast/gate.ts`, whose own docstring says a fourth spelling would
-- be worth avoiding. Inlining `(target_date - 1) + 9h/19h at time zone
-- 'America/Sao_Paulo'` here would have been that fourth, and it would have been
-- the one nobody reads. Calling `gate_at` makes the constraint and the feature
-- rows structurally unable to disagree about the hour.
--
-- `gate_at` is declared `STABLE`. Postgres accepts a `STABLE` function in a
-- CHECK — verified on a migrated database, not assumed — and the function is
-- deterministic in its two arguments up to the tzdata `America/Sao_Paulo`
-- resolves under, which is exactly what the `_is_a_forecast` constraints beside
-- these four already assume with their inline `at time zone`. The volatility
-- marking is left as `0016` set it: re-marking a function eight migrations of
-- callers depend on is a change with a blast radius, and it buys nothing here.
--
-- ## The four tables, and why `backfilled_holdout` is included
--
-- Every table that carries `published_at` beside `target_date` and
-- `gate_profile` gets the constraint: the two subsystem grains, the national
-- day grain, and the published attribution — whose own docstring already
-- asserted "`published_at` **is** `gate_at(target_date, gate_profile)`" as the
-- reason it is not a key column. That prose is now true of the table.
--
-- The constraint is **not** scoped to `origin_kind = 'served'`. A
-- reconstruction's instant is the *counterfactual* gate — "the gate that would
-- have been" for the day it describes, per `src/forecast/backfill.ts` — which
-- is the same function of the same two columns. What separates a record from a
-- reconstruction is `origin_kind`, and it was never the instant; a backfilled
-- row stamped with anything but its own day's gate is as wrong as a served one.

ALTER TABLE "curtailment_forecast_day" ADD CONSTRAINT "curtailment_forecast_day_published_at_is_the_gate" CHECK ("curtailment_forecast_day"."published_at" = gate_at("curtailment_forecast_day"."target_date", "curtailment_forecast_day"."gate_profile"::text));--> statement-breakpoint
ALTER TABLE "curtailment_forecast_hour" ADD CONSTRAINT "curtailment_forecast_hour_published_at_is_the_gate" CHECK ("curtailment_forecast_hour"."published_at" = gate_at("curtailment_forecast_hour"."target_date", "curtailment_forecast_hour"."gate_profile"::text));--> statement-breakpoint
ALTER TABLE "curtailment_forecast_national_day" ADD CONSTRAINT "curtailment_forecast_national_day_published_at_is_the_gate" CHECK ("curtailment_forecast_national_day"."published_at" = gate_at("curtailment_forecast_national_day"."target_date", "curtailment_forecast_national_day"."gate_profile"::text));--> statement-breakpoint
ALTER TABLE "diagnosis_attribution" ADD CONSTRAINT "diagnosis_attribution_published_at_is_the_gate" CHECK ("diagnosis_attribution"."published_at" = gate_at("diagnosis_attribution"."target_date", "diagnosis_attribution"."gate_profile"::text));