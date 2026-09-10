# 03 — One place both languages read the constants from

**What to build:** the numbers and the vocabulary the whole product agrees on
live once, in the shared package, where the gateway, the web app and — via the
fixture directory — the Python service can all read them.

Four constants move, and one of them is a live bug: the R$/MWh economic
assumption sits **in a package Python cannot read**, while the optimizer spec
calls it "the single place it is written down" and the optimizer is Python. It
becomes one published constant beside the subsystem enum with its ONS display
names, the reference battery fleet, the subsystem threshold (5 MW), the
reporting-entity threshold (1 MW) and the maximum gap hours (0).

> **Correction, from the audit.** This ticket and `docs/specs/api-surface.md`
> both said the assumption "is written down twice", under
> `ECONOMIC_ASSUMPTION_BRL_PER_MWH` and `SCENARIO_BRL_PER_MWH`. It was not:
> `apps/web/src/lib/fixtures/mitigate.ts` **re-exported** the one constant under
> the second name. The alias was worth deleting and has been, but the defect to
> fix was always the narrower one — one of the two languages that quote the
> number could not read it.
>
> Likewise, `packages/core` did not hold "four things"; it already held
> `format.ts` **and a working cross-language parity harness** —
> `fixtures/canonical-contract/` with its README, read by
> `packages/core/test/canonical-contract.test.ts` and
> `apps/ml/tests/test_canonical_contract.py`. The constants therefore extend
> that harness (`fixtures/published-constants/`) rather than recovering it.

Two of these are deliberately **not** endpoints, and the reasoning is worth
keeping: a subsystem list endpoint would invite a fifth member, and a reference
fleet endpoint would break the requirement that floor coverage and the
forecaster's recovered-floor delta are computed against the same battery. Both
ship as constants and the reference fleet is *echoed* in the meta endpoint for
diagnosability, never fetched in order to be used.

The frontend's domain vocabulary module is promoted into the shared package as
the single definition — it is already the one place the web app defines
`Subsystem`, `Band`, `ForecastOrigin`, `Technology`, `VintageFidelity` and the
reason codes, and it already carries the reasoning for each. Promoting it is
what lets the gateway stop having a second opinion.

Two vocabulary rules the promotion must preserve rather than lose: `SIN` is not
a subsystem value anywhere, and `lead_time` is derived and therefore never
stored and never returned.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] The shared package exports the subsystem enum with ONS display names, the reference fleet, both thresholds, the gap default and the single R$/MWh assumption
- [x] The duplicated economic-assumption name is gone, with one definition left and every reader pointed at it
- [x] The frontend domain vocabulary lives in the shared package and the web app imports it from there
- [x] The gateway imports the same definitions rather than restating them
- [x] `SIN` is not representable as a subsystem in the shared types
- [x] No exported type carries a stored lead time
- [x] The web app still builds and its existing tests still pass against the promoted module

**The gateway box, closed.** Ticket 04 had already done the plumbing this box
was deferred behind — `apps/api/package.json` carries
`"@wattsteer/core": "workspace:*"`, and the Dockerfile carries
`COPY packages/core/src ./packages/core/src` with a comment stating exactly the
failure the deferral predicted ("copying only the package.json installs a
workspace link pointing at nothing and the container dies on first import"). The
two restatements this ticket named were gone with it: `api/canonical.ts` builds
`SUBSYSTEM`/`TECHNOLOGY` from `SUBSYSTEM_CODES` and `TECHNOLOGIES`, and
`ingest/types.ts` re-exports `Technology` instead of declaring it.

**What was still restating, which the ticket had not named.** A sweep for
*definitions* of either vocabulary — a literal union or a literal array
enumerating the whole enum, as distinct from a comparison against a published
value — found ten more sites across nine files, all in the gateway and all
now importing:

- `ingest/normalise.ts` — the one that mattered. It declared
  `export type SubsystemCode = "N" | "NE" | "S" | "SE"` and its own membership
  `Set`, and it is the module **every ONS adapter and repository imports the
  vocabulary from**: eight files take `SubsystemCode` through it. The type is now
  re-exported from `@wattsteer/core/domain` and the `Set` is built from
  `SUBSYSTEM_CODES`, so the adapters keep their import path and get the published
  definition through it.
- `forecast/publication.ts` and `diagnosis/publication.ts` — a payload-validation
  `Set` each, now built from `SUBSYSTEM_CODES`.
- `api/curtailment.ts` (twice), `api/plants.ts`, `features/weather-aggregate.ts`,
  `ingest/weather/centroid-set-repository.ts` — inline `"WIND" | "SOLAR"`
  annotations, now `Technology`.
- `ingest/weather/centroids.ts` — `CentroidTechnology` is now an alias of
  `Technology` rather than a parallel union; `centroid-generator.ts` iterates
  `TECHNOLOGIES` instead of `["WIND", "SOLAR"] as const`.

**Two restatements were left literal, and the reasons are the interesting part.**

- `database/schema.ts`'s two `pgEnum`s. `drizzle-kit` diffs those value arrays
  against the migration snapshot, and `SUBSYSTEM_CODES` is in display order
  (`N, NE, SE, S`) while the enum was created in declaration order
  (`N, NE, S, SE`). Deriving it would generate a spurious enum migration — a
  schema change to satisfy a refactor.
- `ingest/ons/interchange.ts`'s `SUBSYSTEM_ORDER`. Its own comment says it is
  "`SubsystemCode`'s own declaration order", and it is the **orientation basis**:
  a link is stated from the earlier member to the later one. Swapping in
  `SUBSYSTEM_CODES` reverses every `S`↔`SE` link. This is worth recording as a
  finding rather than a footnote: **the published vocabulary carries two orders**
  — the type's declaration order and `SUBSYSTEMS`' north-to-south display order —
  and one behaviour in the gateway depends on the former. `SUBSYSTEM_CODES` is
  the latter and is not a substitute for it.

**A standing guard, because each half of this fails silently on its own.**
`test/gateway-imports-core.test.ts` (8 tests, in `test:hygiene`) scans
`apps/api/src` for a definition-shaped restatement of either enum, with the two
allowances above named and justified in the allow-list; asserts the workspace
dependency and both `COPY` lines in the Dockerfile; and refuses any
`@wattsteer/core/schema/*` import from the gateway, since that subpath maps to
`packages/core/schema`, which the image does **not** copy. It carries a
can-fail test in the repo's usual style, including that a three-member union
(`WeightBasis = "WIND" | "SOLAR" | "VRE"`) is a different type and not a hit.
Restating the enum and dropping the `COPY` are each invisible to `typecheck`,
`lint` and every test — which is precisely why this ticket asked for a real
container.

**Verified with a real `docker build`**, which is what the ticket said closing
this box means. `docker build -f apps/api/Dockerfile .` succeeded (12 steps,
134 packages installed under `--frozen-lockfile --production
--filter=wattsteer-api`). Then, **inside the container**, every touched module
was imported and `@wattsteer/core/constants` and `/domain` were read back:
`SUBSYSTEM_CODES` → `["N","NE","SE","S"]`, `TECHNOLOGIES` → `["WIND","SOLAR"]`,
`resolveSubsystem("SE ")` → `{kind:"subsystem",code:"SE"}` and
`resolveSubsystem("SIN")` → `{kind:"aggregate"}`. The image then booted with no
`DATABASE_URL` or `REDIS_URL` and served `GET /health` → `200 {"status":"ok"}`
with no error in the logs. A build alone would not have caught a bad specifier;
the import is the part that had to run.

**Both vocabulary rules preserved.** `SIN` is still not a subsystem value: the
ingest boundary resolves it to `{kind:"aggregate"}` and `SUBSYSTEM_CODES` does
not contain it, asserted here and in `packages/core/test/vocabulary.test.ts`. No
exported type gained a stored lead time — nothing about the wire types was
touched, and `vocabulary.test.ts` plus `vocabulary-rules.test.ts` (48 tests)
still pass.

Green after the change: `typecheck` across all four packages, `biome check` over
516 files, and 2,470 TypeScript tests — 67 hygiene (up from 59, the eight new
ones), 471 core, 1,743 API, 189 web, 0 failures.

**Also decided here** (the specs left it open): `Technology` serializes as
`WIND` / `SOLAR`, and the `technology` query parameter is case-sensitive. Written
down in `docs/domain-model.md` §2 and §8.8, implemented in
`packages/core/src/domain.ts` and `apps/ml/src/wattsteer_ml/constants.py`, and
pinned for both languages by the shared vector.
