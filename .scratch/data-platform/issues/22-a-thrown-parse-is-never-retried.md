# 22 — A thrown parse was never retried, and a day never arrived while every run reported health

**What to build:** the separation of *holding the bytes* from *having ingested
them*, so a parse that throws is retried, a payload this platform is right to
refuse is recorded once, and neither is reported as a period that loaded.

Data-platform 21's backfill filed this as its first finding and measured it:

> `markResourceFetched` stamps `fetched_at` on the resource version as soon as
> the bytes are in hand, which is **before** the parse. So a day whose parse
> threw is `alreadySeen` on the next pass: `recordResourceVersion` returns the
> existing row, the job reports `changed: false, downloaded: false,
> inserted: 0` and **exits 0**. Measured on 2025-07-19 — the day that killed the
> whole-history task: zero rows in `dessem_balance_half_hour`, `fetched_at` set,
> and a clean success on every re-run.

Confirmed here before anything was changed, and it is the shape that matters
rather than the day: a `HEAD`-conditional cache keyed on "we have the bytes"
cannot tell "we stored what they said" from "we downloaded this and threw it
away", and the second case reads as done — permanently, and silently, because
every counter a healthy run reports is also what an empty one reports.

**The reasoning that was already right, and is kept.** `bulk-resource.ts` puts
custody before the parse on purpose:

> Custody before parsing, deliberately. The payload is retained for what it is
> — the only surviving copy of what ONS said today — and a parser that throws on
> an unexpected column must not be what decides whether the bytes were kept.

That is correct and the fix does not touch it. `retainPayload` and
`markResourceFetched` both still run before the parse, and the digest, the byte
size and the archive locator are still established before anything tries to
understand the payload. The defect was never the ordering; it was that **one
mark carried two claims**, and the second — "this resource has been processed" —
was false whenever the parse threw.

**Blocked by:** None. Ticket 21 is merged and measured it.

**Status:** done — `drizzle/0046_a_parse_that_landed.sql`,
`test/database-resource-settlement.test.ts`

- [x] The skip gate reads a *completion* mark, not a custody mark.
      `ons_resource_version` gains `ingested_at`, stamped by the ingestor after
      its write, and `recordResourceVersion` answers two separate questions:
      `alreadySeen` ("did the file move?", which still decides `changed`) and
      `settled` ("were these bytes parsed to a conclusion?", which decides
      whether to spend the download). A version that was fetched and whose parse
      threw is the first and not the second, so it is fetched and parsed again
- [x] Custody before parsing is preserved and asserted, not merely claimed. In
      the acquisition where the parse then throws, the version row has
      `fetched_at`, `content_sha256`, `byte_size` and `archive_uri` set, and
      `readRetainedPayload` reads the 17,236 bytes back — while `ingested_at`
      and `refused_at` are both null. Both halves are one test
- [x] The completion mark is the caller's, because the caller is the only party
      that knows its rows landed. All eight `acquireBulkResource` call sites
      call `markIngested()` after their write — the registry job marks both
      halves, since the identifier link needed both. Forgetting the call costs
      one re-download on the next sweep, which is the direction this mark is
      deliberately biased in: marking too early cost a day of history that never
      arrived and never complained
- [x] **A refused day and a thrown parse are different things, and the code says
      which.** `PayloadRefusedError` names a defect that is a property of the
      *bytes* — `coverage`, `time_axis`, `forecast_integrity`, `schema` — so a
      re-parse of the same bytes refuses identically. It is recorded against the
      fingerprint (`refused_at`, `refusal_reason`, `refusal_detail`), which
      settles it: one `HEAD` per sweep, no download, **no hot loop**, and
      `ingested_at` still null so no census can read it as a day that loaded.
      Every other throw — a socket, a Postgres, an adapter bug — is left
      unmarked and retried. The DESSEM adapter's three measured refusal causes
      map onto three of the four reasons: 34 short civil days are `coverage`, 68
      files re-published after the day they forecast are `forecast_integrity`,
      3 solar-in-local-night days are `time_axis`
- [x] The refusal never outlives the bytes it is about. ONS re-publishing a day
      is a new `change_key` and therefore a fresh, unsettled row — retried with
      no force and no operator. Proven end to end: the short day is refused,
      re-runs cost one `HEAD`, and the day ONS re-publishes complete loads on
      the next sweep
- [x] One refused day no longer takes the sweep with it. `dessem-job.ts`
      isolates the parse and the write per reference day: a `PayloadRefusedError`
      is recorded, counted (`daysRefused`, `daysStandingRefused`) and reported
      in `refusals[]` with its reason and ONS's own sentence, the way
      `refresh.ts` reports a failed task; anything else still throws out of the
      task. Ticket 21's task died on day 58 of 469 and never probed the other
      411 — the test is two days, the first refused, and asserts the second
      still lands 192 rows
- [x] A run that refuses is not a quiet run. `refusals` is non-empty on the
      sweep that refuses and on every sweep afterwards, with `refusedThisRun`
      separating "this is news" from "this is the recorded state of what ONS
      published". Settled is not the same as silent
- [x] Proven by a test that fails before the fix, twice over, against real
      Postgres on a throwaway port. Restoring the pre-fix gate
      (`version.alreadySeen` in place of `version.settled`) fails
      *re-downloads and re-parses a payload whose parse threw* — `downloaded`
      comes back `false` — and *settles on the completion mark*. Restoring the
      pre-fix per-day behaviour additionally kills the whole sweep on the short
      day with `Reference day 2026-08-28 has 26 patamares for subsystem N`,
      which is ONS's 2025-07-19 in miniature. 4 of the 9 tests fail before,
      9 pass after
- [x] The guard is not vacuous. The first test in the file measures its own
      inputs before anything is acquired: the captured day is >10,000 bytes and
      carries 48 patamares for N and for SE, the derived short day carries **26
      for N and 48 for SE**, is stamped 2026-08-28 and contains no 2026-08-29
      row. The refusal detail asserted downstream is matched on "26 patamares",
      and the sweep's success is asserted as `inserted: 192` on the day *after*
      the refused one — a count that cannot come from an empty parse

## Repair: yes, and no operator has to guess which day

**Are there resources marked fetched whose parse never landed? Yes, and nothing
in a database today records which.** That is the defect restated: `fetched_at`
was the only mark, so a poisoned row is byte-for-byte indistinguishable from a
clean one. Ticket 21 measured at least one — the DESSEM reference day 2025-07-19
in `fc18-pg` — and its own census had to pass `force: true` on all 475 days
precisely because the fingerprint state could not be trusted.

**Is the existing `--force` sufficient?** As a mechanism, yes: `force: true`
re-downloads and re-parses regardless of the fingerprint, and this ticket adds
what force previously lacked — a landed re-parse now stamps `ingested_at` and
clears any standing refusal, so the repair sticks. As a *repair plan*, no. Force
is task-shaped, not row-shaped: forcing the DESSEM history re-downloads all 475
days, forcing the wind constrained-off window re-downloads 726 MB, and an
operator would have to know which day was poisoned in order to aim it — which is
the one thing the defect makes unknowable.

So the repair is the migration, and it is deliberate that it **does not**
backfill `ingested_at = fetched_at`. That one line would re-assert exactly the
falsehood being removed. Every version already on record therefore arrives
unsettled, and the first sweep after the migration re-downloads and re-parses
each resource once — ticket 21 measured the whole ONS history at ~1.0 GB and
under fifteen minutes — after which what loads is stamped, what is refused is
recorded with a reason, and the poison is gone without anyone guessing.

What an operator runs, in order:

    # 1. Apply the migration.
    cd apps/api && DATABASE_URL=<url> bun run db:migrate

    # 2. Nothing else is required: the next sweep re-verifies everything.
    bun run src/scripts/ingest.ts sweep history

    # 3. Or drive the re-verification per source, e.g. DESSEM's whole history:
    bun run src/scripts/ingest.ts task \
      '{"kind":"dessem_balance","payload":{"from":"2025-05-23"}}'

    # 4. Then read the state back. Every row is now one of three things.
    psql "$DATABASE_URL" -c "
      select dataset_slug,
             count(*) filter (where ingested_at is not null) as ingested,
             count(*) filter (where refused_at  is not null) as refused,
             count(*) filter (where fetched_at is not null
                              and ingested_at is null
                              and refused_at  is null)       as unsettled
        from ons_resource_version group by 1 order by 1;"

A non-zero `unsettled` after a completed sweep is the new loud version of the
old silence: those are bytes held whose parse neither landed nor was refused.

Two things this repair does *not* need and deliberately does not do: it does not
force where force is not needed (an already-ingested resource is re-verified
once and then costs one `HEAD` forever), and it does not touch the payload
archive — the retained bytes were always the trustworthy half of the record.

## What this ticket does not do

- **The 68 re-published DESSEM days are still refused, and correctly.**
  `published_at` comes from the resource's current `Last-Modified`, so a
  rewritten daily file presents as a forecast published after the half hour it
  describes. The assertion is right and the input is wrong; upstream has
  destroyed the original vintage. What changes here is only that those days are
  now recorded as `forecast_integrity` refusals with ONS's own sentence attached,
  instead of being invisible. Ticket 21's item 2 still owns the question of
  whether a re-published file can carry an honest `published_at`
- **`readIngestionHealth` does not yet report the unsettled count.** The state
  is queryable, per the SQL above, and the sweep result carries the refusals, but
  the health view still answers the questions it answered before
- **The single-file ingestors do not swallow refusals.** A refusal in a
  one-file-per-task job still fails the task, because for them the task failure
  *is* the report — `refresh.ts` isolates failures per task and there are no
  other days in the task to protect. Only the sweep-shaped ingestor needed
  per-day isolation, and only it has it
