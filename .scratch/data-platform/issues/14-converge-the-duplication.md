# 14 — Converge the duplication the review found

**What to build:** nothing new. Three duplications that a code review confirmed
are real, deliberately deferred rather than fixed at the time, because the right
abstraction is not yet visible and a bad one is worse than the repetition.

**1. The bitemporal write path.** `ingest/repository.ts` and
`ingest/curtailment-repository.ts` share a line-for-line identical `writeX`:
the chunk and precision constants, `LatestVersion`, `loadLatest`, the min/max
valid-time range, the unchanged/revised/inserted loop, and the chunked
`onConflictDoNothing` insert. Roughly 100 duplicated lines. The *reads* are
genuinely different (different columns, different value-object reconstruction)
and should stay separate — `curtailment-repository.ts`'s header comment claims
this justifies duplicating both, which is only half true, and that comment
should be narrowed to what it actually defends.

**2. Job orchestration.** `ingest/job.ts` and `ingest/constrained-off-job.ts`
repeat the same seven-step shape: fetch the package, report progress, HEAD,
record the version, return early when unchanged, download, parse, write. Only
the parse and write differ.

**3. Two domain vocabularies in `apps/web`.** `components/landing/` and
`lib/fixtures/` each define `SubsystemCode`, `ForecastOrigin`, `Driver` and
`Band`, differently — `Driver.contribution` against `Driver.share`, and a
`Figure` sum type against a bare `Band`. Two agents built them in parallel
under enforced directory separation. The `landing/` design is the stronger one:
its `Figure` sum type makes a dropped uncertainty band unrepresentable.

**Why it did not wait, in the end.** The argument for waiting was that a REST
source with no bulk file would break a generic drawn from two file-based
examples. That turned out to name the seam rather than forbid it: the shared
piece is the *versioned write*, which every fact table needs whatever its
transport, and acquisition is a separate helper scoped to bulk files and named
for it. A REST source shares the first and skips the second. Splitting it that
way was only visible once the two concerns were pulled apart — which is what
doing the work, rather than deferring it, produced.

Finding (3) turned out to be worse than duplication: the two vocabularies
*contradicted* each other. `Technology` was lowercase on the web and uppercase
in the API and the database enum, and `Driver` disagreed on a field name. The
lowercase URL spelling survives as a transport form owned by `params.ts`, the
same way the ONS carga API's `SECO` is owned by its client.

**Blocked by:** nothing. Done ahead of 06/07/08 at the dev's call.

**Status:** done

- [x] The versioned-append write is extracted once and used by both fact tables
- [x] The reads stay separate, and the header comment claims only that
- [x] Job orchestration is shared, with parse and write injected
- [x] Adding a fifth dataset touches one adapter file and one registration
- [x] `apps/web` has one definition of each domain type, and it is the sum-type one
- [x] No behaviour changes; the existing tests pass untouched
