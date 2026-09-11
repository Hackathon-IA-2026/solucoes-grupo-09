# 31 — A schedule the repository does not keep

**What to build:** the fourth question in the series 27, 29 and 30 opened. 27
established that a spec cannot be trusted to describe itself, 29 that a ticket
cannot be trusted to count itself, 30 that a thing a ticket says it built may be
called by nothing. None of the three asks whether the **clock** a document
describes is a clock this repository actually keeps.

**The evidence that this was worth doing.** `docs/specs/api-surface.md:323`, in
the job table under "What the worker runs":

```
| `refresh-featured-days` | `30 3 * * *` | — | the Replay shortlist cache |
```

`refresh-featured-days` is not a `WorkerTask` member, not an `IngestTask` kind,
not an id registered on the queue by `apps/api/src/worker.ts`, not a cron in
`.github/workflows/`, not a field of `railway.json` and not a service in
`docker-compose.yml`. **Nothing in this repository fires at `30 3 * * *`.** The
spec promises a nightly job; the Replay shortlist is therefore never computed
and `/v1/replay/days` serves `pending` forever. The same absence is asserted a
second time in prose 780 lines earlier — "a shortlist the nightly job has not
yet computed publishes `pending`" (`api-surface.md:1103`) — which is the shape
27 calls a claim that has been repeated until it reads as settled.

**Why a guard rather than a one-line fix.** Three guards were already in the
tree and none of them could see it, each for a structural reason rather than an
oversight:

- **27** (`test/spec-claims.ts`) binds counts, path-form file references and
  "does not exist / is not served" claims. A table row pairing a job name with
  a cron is none of the three, and both of its halves — the name and the
  pattern — are outside every binder it has.
- **29** (`test/ticket-claims.ts`) reads a *ticket's* own box counts against its
  `Status:` line. It never opens a spec.
- **30** (`test/reachability.ts`) asks whether code reaches code. A document is
  not code, and a job that was never written has no symbol to be unreachable:
  the orphan sweep found four *written* units nothing called, and this one was
  invisible to it because there is nothing to orphan.

**The rule this guard inherits, absolute:** no human-maintained list, on either
side. Nothing in `test/phantom-schedules.test.ts` knows the name of any job. The
claimed side is found by shape — a Markdown table *any* row of which pairs a
name with a cron expression is a job table, and then every row of it is a claim
— so a job table added to a new spec next month is swept on its first commit.
The real side is a sweep of every mechanism that can put work on a clock here,
each read from its own source.

**Blocked by:** None. (27, 29 and 30 are the model, and are done.)

**Status:** done — the guard is `test/phantom-schedules.test.ts`, and it is
**red on `refresh-featured-days` and on nothing else**. That row is being wired
this round by the agent closing 30's four orphans; when the job exists the guard
goes green by itself, with no edit to this file or to the test. It is red
deliberately in the meantime: the defect is real, and a guard that shipped green
beside it would be the fifth vacuous guard in this repository's history.

- [x] Every schedule any published document claims is reported **real**,
      **phantom** or **not checkable**, with the check used — the not-checkable
      ones **named**, which is the honest half and what 27 required
- [x] Both halves of a job-table row are checked: the cron is a pattern
      something fires at, **and** the name is an identity the tree can run
- [x] Every scheduling mechanism was found before any one of them was trusted —
      there are six, and four of them are live
- [x] The guard needs no human to keep a list in step — no allow-list on either
      side, and a job added, renamed or removed tomorrow is governed that day
- [x] The guard is proven to fail on drift **and** on empty input, with every
      empty case refused at the verdict rather than passing as `[] === []`
- [x] What is not mechanically checkable is named with the reason, including the
      nineteen schedules stated in English rather than in cron

---

## The sweep

Claimed schedules, from `docs/**/*.md` and `README.md`:

| document | claimed | verdict | check |
|---|---|---|---|
| `api-surface.md:320` | `publish-forecast:gate_early` at `10 9 * * *` | **real** | cron + name — `apps/api/src/jobs/publication.ts` |
| `api-surface.md:321` | `publish-forecast:gate_late` at `10 19 * * *` | **real** | cron + name — `apps/api/src/jobs/publication.ts` |
| `api-surface.md:322` | `publish-diagnosis`, "on completion of each above" | **not checkable** | name only — `publish_diagnosis` is a `WorkerTask` kind; the trigger is prose |
| `api-surface.md:323` | `refresh-featured-days` at `30 3 * * *` | **phantom** | cron + name — **both** fail |
| `forecaster.md:1442` | `10 3 * * 5` (the weekly retrain, in prose) | **real** | cron — `RETRAIN_PATTERN`, `apps/api/src/jobs/retrain.ts` |

| | count |
|---|---|
| **real** | 3 |
| **phantom** | 1 |
| **not checkable** | 1 |
| | **5** |

There is exactly one phantom, and it is the one the ticket was opened for. The
sweep found no second phantom: the two publication rows, the diagnosis row and
the retrain sentence all resolve.

## Every scheduling mechanism, found before any one was trusted

Six, and they look nothing alike. The count matters: a guard that had trusted
the first one it found would have called the three refresh tiers imaginary, and
one that had trusted only the queue would have missed seven CI crons.

| mechanism | how it is read | live today |
|---|---|---|
| **BullMQ repeatable jobs** | `{ id, pattern }` object literals in non-test TypeScript, with `const … = "…"` resolution for tokens like `RETRAIN_PATTERN` and `${…}` → `*` for template ids | 7 (`publish-forecast:gate_early`, `publish-forecast:gate_late`, `retrain:serving-lanes`, `holdout-backfill:newest-frozen-fold`, `custody:retention`, `centroid:drift`, `refresh:*`) |
| **Cron string literals** | any cron-shaped `"…"` in non-test TypeScript, named by the object key or constant beside it | 9 — including the three `REFRESH_CADENCE` tiers (`live`, `recent`, `history`), which are a `Record` with **no `id` anywhere near them** |
| **GitHub Actions** | `schedule:` blocks in `.github/workflows/*.yml`, scoped to the block so a cron discussed in a comment is not counted | 7, across four workflows |
| **Task kinds** | every `export type …Task =` union and every `kind:` `planRefresh` enqueues — identities with no cron, which is what makes `publish-diagnosis` answerable | 24 occurrences, 17 distinct |
| **`railway.json`** | any cron-shaped value at any depth (Railway schedules a service through a `cron` field) | 0 — the deploy block is a health check and a restart policy |
| **`docker-compose.yml`** | any cron-shaped value, and any service whose image or command is a cron daemon (`ofelia`, `supercronic`, `crond`) | 0 — the five services are Postgres, Redis, api, worker and ml; the worker *is* the scheduler |

The last two are readers over documents that schedule nothing today. They are
asserted on synthetic input rather than on a count, because asserting a count
there would be asserting that the deployment has a cron it does not have — and
a sixth compose service or a Railway cron added next month must be swept without
anybody remembering to come back to the test.

## What is not checkable, named rather than skipped

- **Triggers stated as prose.** `publish-diagnosis` has no cron and never will:
  its trigger is the completion of the forecast publication, chained by
  `chainDiagnosis` in `apps/api/src/jobs/worker-tasks.ts`. Its **name** is
  checked; "on completion of each above" is not evaluated. A guard that demanded
  a cron for it would be wrong about the architecture.
- **Cadence stated in English.** Nineteen lines across the corpus state a
  schedule in words and no cron: "a shortlist the nightly job has not yet
  computed", "the schedule is 11:00 UTC = 08:00 BRT", "A weekly queued job
  (`centroid_drift`, Mondays 06:00 UTC)", "the weekly retrain always scores
  against F6". There is no name to resolve and no pattern to compare, and a
  regex that turned "nightly" into `* * * * *` would be inventing a claim in
  order to check it. `scheduleProse()` enumerates them so the size of the
  unchecked half is a number somebody can read, the way 27 measures its
  exemptions rather than trusting them; the count is asserted non-empty and
  bounded.
- **A starless cron.** `isCron` requires at least one `*`, because a bare
  five-number sequence is how this repository writes ticket lists ("seams 1, 3,
  5, 6, 8"), hour lists and fixture vectors. `0 0 1 1 0` would not be read as a
  schedule. The cheaper mistake, deliberately: a missed claim is a gap, a false
  claim is a guard somebody deletes.
- **`.scratch/**` tickets.** Out of corpus. A ticket is a working log that
  quotes the defect it is fixing — this one prints the phantom row twice — and
  29 already owns what a ticket claims about itself.
- **A seventh mechanism.** A scheduler added in a shape none of the six readers
  knows is not covered until someone teaches the file about it. That is the
  honest ceiling, and it is the same one `reachability.ts` states about SQL and
  Python. What is *not* a ceiling is the set of jobs.

## The proofs that it is not vacuous

Four guards in this repository have read green over nothing; two days ago 29
found 27's sentence splitter blind to a bolded full stop, and 30 found its own
stripper eating the file it scanned. So the same class of bug was assumed here
until disproved:

**Drift, on disk.** A scratch document planted at `docs/specs/zz-scratch-phantom.md`
with a job table row `| `refresh-phantom-cache` | `3 3 * * *` | nothing |` made
the tally `phantom: 2` and named it on both halves; deleting the file returned
it to `phantom: 1`. Four more drift proofs run in-process against scratch copies
of the corpus and of the real sweep, none of them keyed to the row being fixed
this round:

- a planted job (`refresh-imaginary-cache` at `7 2 * * *`) is caught on both
  halves;
- deleting the retrain's schedule from the real side while `forecaster.md`'s
  sentence stands turns that sentence red — the *likelier* direction, a row that
  was true when written;
- renaming `publish-forecast:gate_late` in the tree while leaving its cron alone
  is caught by the **name** half, which a pattern-only guard would have passed;
- dropping `publish_diagnosis` from the `WorkerTask` union turns the one row
  that has no cron red.

**Emptiness, refused at the verdict.** `auditSchedules` **throws** rather than
returning `[]` when the claimed side is empty, when the real side is empty, when
the real side has identities but no patterns, and when it has patterns but no
identities. The two middle cases are the subtle ones: a corpus of pure phantoms
would read green if every cron reader broke at once. Each is asserted with
`.toThrow()` against a real starved input, not against a hypothetical.

**The stripper.** Asserted on `apps/api/src/api/grid.ts`, the file that broke
the last one: its line 280 is a `//` comment containing `/*`, and a scanner that
removed block comments first ate a hundred lines of route code from there on.
The stripper here is positional — whichever of `//`, `/*` or a quote opens first
wins — and the test asserts that every route registered *after* that line
survives, plus that a cron inside a comment is not a schedule while a cron
inside a string literal still is.

**The readers, on what they must not match.** `isCron` is asserted to accept
`30 3 * * *`, `*/5 * * * *`, `45 14,21 * * 1-5` and a six-field pattern, and to
reject `seams 1, 3, 5, 6, 8`, `10, 11, 12, 13, 16`, `0 20 70 110 90` and a cron
with a word after it. A table whose rows pair a backticked name with a status
code — the error table, the column dictionary — is asserted **not** to be read
as a job table. And a sentence that *withdraws* a cron ("this table said
`30 3 * * *`") is a quotation and not a claim, sentence-scoped rather than
paragraph-scoped, because paragraph scope is exactly the bug 29 found in 27 —
which matters immediately, since the correction note for this defect is likely
to quote the withdrawn pattern back.

## The interaction with 30's orphan wiring

`refresh-featured-days` is one of the four orphans being wired this round. When
that lands — a task kind, a schedule id and a `30 3 * * *` pattern, or a
corrected row — this guard turns green with no edit to it. Nothing in the test
names that row as its permanent example: every drift proof uses an invented job
or a mutation of the real side, so the proofs go on working after the line
becomes true. `docs/specs/api-surface.md` was not touched by this ticket.

## Files

- `test/phantom-schedules.test.ts` — the guard, self-contained, in the shape
  `test/migration-ledger.test.ts` established: no edit to `test/spec-claims.ts`
  was needed and none was made.
