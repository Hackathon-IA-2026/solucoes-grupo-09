-- The state data-platform 22 left unnamed: fetched, never settled, and gone.
--
-- 22 split `fetched_at` into `ingested_at` and `refused_at`, which made a
-- thrown parse retryable. A third state was already possible and had no column:
-- a version whose bytes upstream has since replaced. Its `change_key` is a
-- `Last-Modified` or `ETag` ONS no longer serves, so no retry can ever settle
-- it, and 22's census counted it beside the genuinely poisoned rows. After a
-- day that is 18 rows; after a year the loud signal drowns in them, which is
-- the failure 22 exists to prevent, one level up.
--
-- Measured on the working database before writing this: 18 unsettled rows, and
-- **all 18** had a later version of the same resource already settled.
--
-- **This one does backfill, and the distinction from 22 is the point.** 22
-- refused to backfill `ingested_at` because for a poisoned row the parse never
-- landed and no such instant exists anywhere — inventing one would have
-- re-asserted the falsehood it was removing. Here the instant is *recorded*:
-- the replacement was observed when the successor was first seen, which is
-- that row's own `first_seen_at`. So this is copying a fact across, not
-- minting one. A row with no successor is left null, which is the honest
-- reading of "nothing has replaced these bytes yet".

ALTER TABLE "ons_resource_version" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint

UPDATE "ons_resource_version" u
SET "superseded_at" = (
  SELECT MIN(l."first_seen_at")
  FROM "ons_resource_version" l
  WHERE l."resource_url" = u."resource_url"
    AND l."first_seen_at" > u."first_seen_at"
)
WHERE u."fetched_at" IS NOT NULL
  AND u."ingested_at" IS NULL
  AND u."refused_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "ons_resource_version" l
    WHERE l."resource_url" = u."resource_url"
      AND l."first_seen_at" > u."first_seen_at"
  );
