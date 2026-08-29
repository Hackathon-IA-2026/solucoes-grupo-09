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

**Status:** done except the gateway box — see below

- [x] The shared package exports the subsystem enum with ONS display names, the reference fleet, both thresholds, the gap default and the single R$/MWh assumption
- [x] The duplicated economic-assumption name is gone, with one definition left and every reader pointed at it
- [x] The frontend domain vocabulary lives in the shared package and the web app imports it from there
- [ ] The gateway imports the same definitions rather than restating them.
      **Deferred to ticket 04, and not for the reason first recorded.** The
      restatements are `SUBSYSTEM`/`TECHNOLOGY` in `api/canonical.ts` and
      `export type Technology` in `ingest/types.ts`, and the source edit really is
      mechanical — but `apps/api` has no dependency on `@wattsteer/core` and its
      Dockerfile copies only `apps/api/src`, so the import would typecheck locally
      and fail in the container. Closing this box means adding the workspace
      dependency, copying `packages/core/src` in the build, and verifying a real
      `docker build` — which belongs with ticket 04's shared-types plumbing, not
      bolted onto a constants ticket
- [x] `SIN` is not representable as a subsystem in the shared types
- [x] No exported type carries a stored lead time
- [x] The web app still builds and its existing tests still pass against the promoted module

**The gateway box is not ticked, and was not attempted.** `apps/api/src/api/`,
`apps/api/src/contract/`, `apps/api/src/database/schema.ts` and
`apps/api/src/ingest/` were being edited concurrently by other agents while this
ticket ran, and every gateway restatement lives in one of them: the `SUBSYSTEM`
and `TECHNOLOGY` literals in `apps/api/src/api/canonical.ts`, and
`type Technology` in `apps/api/src/ingest/types.ts`. Pointing them at
`@wattsteer/core` is a small, mechanical change and the definitions they need
are now published and pinned in both languages.

**Also decided here** (the specs left it open): `Technology` serializes as
`WIND` / `SOLAR`, and the `technology` query parameter is case-sensitive. Written
down in `docs/domain-model.md` §2 and §8.8, implemented in
`packages/core/src/domain.ts` and `apps/ml/src/wattsteer_ml/constants.py`, and
pinned for both languages by the shared vector.
