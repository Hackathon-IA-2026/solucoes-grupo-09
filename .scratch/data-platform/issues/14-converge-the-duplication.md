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

**Why this waits:** the correct shape of (1) and (2) becomes obvious once
tickets 06, 07 and 08 add a third and fourth adapter — one of which is a REST
source with no bulk file at all, which is exactly the case a premature generic
would fail to accommodate. And (3) should converge when the screens stop
running on fixtures, not before.

**Blocked by:** 06, 07, 08 — deliberately, so the abstraction is drawn from
four instances rather than two.

**Status:** ready-for-agent

- [ ] The versioned-append write is extracted once and used by both fact tables
- [ ] The reads stay separate, and the header comment claims only that
- [ ] Job orchestration is shared, with parse and write injected
- [ ] Adding a fifth dataset touches one adapter file and one registration
- [ ] `apps/web` has one definition of each domain type, and it is the sum-type one
- [ ] No behaviour changes; the existing tests pass untouched
