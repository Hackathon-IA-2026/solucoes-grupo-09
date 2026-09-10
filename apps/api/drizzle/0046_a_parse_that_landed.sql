-- A parse that landed, told apart from bytes in hand.
--
-- `fetched_at` carried two claims: "we hold these bytes" and "we ingested
-- them". The second was false whenever a parse threw, and the consequence was
-- silent — the next sweep saw the resource as done, reported
-- `changed: false, inserted: 0` and exited 0 forever (data-platform 21, 22;
-- measured on the DESSEM reference day 2025-07-19). `ingested_at` now carries
-- the second claim alone, stamped after the write; `refused_at` carries the
-- third state that had no column at all — bytes this platform is right to
-- refuse, recorded so a refused day costs one HEAD instead of a hot loop.
--
-- **No backfill, deliberately.** `ingested_at` could be set to `fetched_at`
-- for every existing row in one line, and that line would re-assert exactly
-- the falsehood this migration exists to remove: for the poisoned rows the
-- parse never landed, and nothing in this database records which rows those
-- are. So every version already on record is left unsettled, and the first
-- sweep after this migration re-downloads and re-parses each resource once —
-- measured at ~1.0 GB and under fifteen minutes for the full ONS history in
-- issue 21 — after which the ones that load are stamped, the ones that are
-- refused are recorded with a reason, and the poison is gone without an
-- operator having to guess which day was poisoned.

ALTER TABLE "ons_resource_version" ADD COLUMN "ingested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ons_resource_version" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ons_resource_version" ADD COLUMN "refusal_reason" text;--> statement-breakpoint
ALTER TABLE "ons_resource_version" ADD COLUMN "refusal_detail" text;