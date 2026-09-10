-- The fifth refusal condition, from forecaster 31.
--
-- `0044` closed this vocabulary at four, and said so in as many words: "the
-- four `apps/ml` distinguishes, and not the fifth it stopped distinguishing".
-- That was true of the tree it was written against. In the same wave,
-- forecaster 31 put the driver-group partition on the model card, so a card
-- whose partition disagrees with the map the publisher reads is now its own
-- refusal — `partition_disagrees_with_card` — rather than an attribution
-- quietly filed under the wrong partition.
--
-- Why this is a new migration and not an edit to `0044`: `drizzle/` is applied
-- history. `apps/api/README.md` is explicit that a landed migration's SQL is
-- never edited, not even a comment, because the file is the record of what was
-- run and editing it makes the repository lie about that.
--
-- How it was found is the part worth keeping. `publication-watch.test.ts`
-- parses `REFUSAL_CONDITIONS` out of `apps/ml/src/wattsteer_ml/diagnosis/
-- publish.py` rather than restating it, and asserts the TS list and this CHECK
-- agree with it. The two branches were green apart and neither could see the
-- other; the mismatch failed on the merge, which is exactly what that test's
-- own comment promised it would do. Had it not, the fifth condition would have
-- arrived as a refusal this side declined to record — and an unrecorded
-- refusal reads, to the watch, as a missed publication.

ALTER TABLE "diagnosis_publication_refusal" DROP CONSTRAINT "diagnosis_publication_refusal_condition";--> statement-breakpoint
ALTER TABLE "diagnosis_publication_refusal" ADD CONSTRAINT "diagnosis_publication_refusal_condition" CHECK ("diagnosis_publication_refusal"."condition" in ('no_base_fit_window', 'no_matched_background', 'contract_and_groups_disagree', 'incomplete_day', 'partition_disagrees_with_card'));