# 28 — One vocabulary, two orders, and nothing said which was which

**What to build:** two named orders where there was one name and one unexplained
literal, and guards that make picking the wrong one a red test rather than a
reversed link.

api-surface 03's closing note recorded the finding and then left it as a note.
The published subsystem vocabulary carries **two orders**, and code depends on
both:

- `SUBSYSTEM_CODES` in `packages/core/src/constants.ts` is derived from
  `SUBSYSTEMS` and is therefore the **display** order, north to south:
  `N, NE, SE, S`. Its own doc comment says so.
- `apps/api/src/database/schema.ts`'s `subsystem_code` `pgEnum` was created in
  **declaration** order, `N, NE, S, SE` — the textual order of
  `export type SubsystemCode = "N" | "NE" | "S" | "SE"`. So was the migration
  that created the Postgres type:
  `apps/api/drizzle/0000_hot_dakota_north.sql:3`.
- `apps/api/src/ingest/ons/interchange.ts`'s `SUBSYSTEM_ORDER` is the link
  **orientation basis** — "a link is stated from the earlier member of this list
  to the later one" — and is anchored to declaration order. `S` precedes `SE`
  there and follows it in display order, so substituting `SUBSYSTEM_CODES`
  reverses **every** `S`↔`SE` link, in a column whose sign *is* the direction.

Two sites were therefore deliberately left restating the vocabulary literally,
with the reasons recorded in the allow-list of
`test/gateway-imports-core.test.ts`. The allow-list is honest and the reasons
are right. What is missing is that **one of the two orders has no name at all** —
it exists only as two literals in two files and a sentence in a test comment —
so the only way to know which order a new site needs is to have read that
comment.

**Evidence this is a live trap and not a theoretical one: it already bit.**
`c8e0063` substituted `SUBSYSTEM_CODES` into
`apps/api/src/jobs/diagnosis-publication.ts`, which api-surface 10 had written
that same day as `["N", "NE", "S", "SE"]` — declaration order — by an agent that
had no idea two orders existed. That commit's own message records the near-miss:
"immaterial here — `readReasons` returns a keyed record, so nothing downstream
sees this order". It was harmless by luck. The next one need not be.

**Blocked by:** api-surface 03 (merged), api-surface 04 (merged — the gateway's
`@wattsteer/core` dependency and the Dockerfile `COPY`).

**Status:** done

- [x] Each order has a published name that says what it is for, and neither is
      left as an unqualified `SUBSYSTEM_CODES` or as a bare literal in the file
      that happens to need it
- [x] The declaration-order constant is pinned to the `SubsystemCode` union's own
      textual order, so the two cannot drift — the union is the anchor and
      TypeScript gives a union no runtime order
- [x] `interchange.ts` reads the named constant instead of restating it, **and**
      `S`↔`SE` orientation is proved unchanged by a test that fails if the basis
      is swapped for display order
- [x] The `pgEnum` reads the named constant instead of restating it, **and** a
      plain `drizzle-kit generate` still emits nothing — measured, not assumed
- [x] A guard fails if the two orders are conflated, including the specific shape
      of this morning's line
- [x] A guard pins the `pgEnum`'s order against the migration that created the
      Postgres type
- [x] Every new guard is proved to fail when the defect is reintroduced, and to
      have non-empty inputs (api-surface 25's rule)
- [x] `test/gateway-imports-core.test.ts`'s allow-list matches what actually
      landed, with justifications that are still true
- [x] `bun run check` is green

---

## What landed

**The naming.** `SUBSYSTEM_CODES` is gone from TypeScript; the two orders are

- **`SUBSYSTEM_DISPLAY_ORDER`** — `N, NE, SE, S`. Derived from `SUBSYSTEMS`, the
  order the screens render and `GET /v1/meta` reports. Every reader of
  `SUBSYSTEM_CODES` across the 15 files that had one now reads this, unchanged
  in value: it is the same array, renamed, so no behaviour moved. Three of those
  files also had a *local* `SUBSYSTEM_CODES` — a membership `Set` shadowing the
  import — and those are `SUBSYSTEM_MEMBERS` now, since a set has no order to
  be one of two of. Python keeps `SUBSYSTEM_CODES` for its own display order:
  the cross-language parity in `fixtures/published-constants/constants.json` is
  over the `subsystems` array's contents, not over identifier names, and
  renaming it would touch thirty `apps/ml` test files to buy nothing.
- **`SUBSYSTEM_DECLARATION_ORDER`** — `N, NE, S, SE`. The `SubsystemCode` union's
  textual order, which is the Postgres enum's creation order and the interchange
  orientation basis. Exported from `packages/core/src/domain.ts`, beside the type
  it is the order *of*, rather than from `constants.ts` — it is not a constant of
  the domain, it is a property of the declaration.

The old name is not kept as an alias. It was the defect: a name that reads like
"the four codes" and is in fact one of two orderings of them.

**Both derivations were safe, and both hazards were measured first.**

- The `pgEnum`. The hazard is real: deriving it from the display order and
  running `apps/api/test/drizzle-snapshot.test.ts` — which generates against the
  committed metadata in a throwaway copy and requires drizzle-kit to find nothing
  to do — emitted a spurious enum migration (`0043_*.sql`; drizzle-kit names it
  randomly, so the two runs of this experiment produced two names). With
  `pgEnum("subsystem_code", [...SUBSYSTEM_DECLARATION_ORDER])` the same test
  emits nothing. The values are byte-identical to the literal, so drizzle-kit's
  snapshot diff has nothing to see.
- `SUBSYSTEM_ORDER`. Same array, so `rank()` is unchanged. Proved by a test that
  states the `S`–`SE` link in both orientations and asserts the canonical row is
  `S→SE` with the reversed row's sign flipped — the test fails, with `SE→S`, if
  the basis is display order.

**The technology `pgEnum` stays literal**, and `database/schema.ts` stays on the
allow-list for it alone. `TECHNOLOGIES` is typed `readonly Technology[]`, and
`pgEnum` needs a `[T, ...T[]]` tuple; narrowing `TECHNOLOGIES` to a tuple to suit
the schema breaks `.includes()` at its other call sites. A two-member vocabulary
whose one order matches its migration has no conflation hazard to fix, so this is
left as it is rather than paid for with a type change elsewhere.

**Guards, in `test/subsystem-order.test.ts` (12 tests, in `test:hygiene`).**

1. The two orders are both length 4, are the same four codes, and are **not** the
   same sequence — they differ at index 2. Collapsing one into the other, or
   re-deriving the declaration order from `SUBSYSTEMS`, fails here.
2. `SUBSYSTEM_DECLARATION_ORDER` equals the member sequence parsed out of
   `export type SubsystemCode` in `packages/core/src/domain.ts`.
3. It equals the values parsed out of `CREATE TYPE "public"."subsystem_code"` in
   `apps/api/drizzle/0000_hot_dakota_north.sql`.
4. The live `subsystemCode.enumValues` — the `pgEnum` as drizzle sees it — equals
   both of the above.
5. Import discipline: across `packages/core/src`, `apps/api/src` and
   `apps/web/src`, only the two files that need the orientation basis may import
   `SUBSYSTEM_DECLARATION_ORDER`, and neither of them may import
   `SUBSYSTEM_DISPLAY_ORDER`. A third site reaching for the orientation basis is
   a red test with the reason in the failure.
6. `SUBSYSTEM_CODES` is not reintroduced in TypeScript under either meaning.
7. Non-vacuity, per api-surface 25: each scan asserts its input is non-empty and
   contains named files, each parser asserts it found four members, and the
   import scan asserts it actually saw the two allow-listed files importing the
   constant. A parser that silently matched nothing would otherwise satisfy
   every equality above by returning `[]` on both sides.
8. Can-fail, in-process: the two parsers are run against display-order source and
   display-order SQL and shown to return `N, NE, SE, S`, so the equalities in 2
   and 3 are load-bearing rather than tautological.

`test/gateway-imports-core.test.ts` keeps its scanner and loses one allow-list
entry — `ingest/ons/interchange.ts` is no longer restating anything — and the
`database/schema.ts` justification is rewritten to say it now covers the
technology enum only. Its own can-fail test gains the exact literal from
`diagnosis-publication.ts`, the line that started this, and the display-order
spelling of it: both are hits.

`apps/api/test/ons-interchange.test.ts` had a third copy of the basis, in a test
assertion (`const order = ["N", "NE", "S", "SE"]`). It reads the published
constant now, which is what makes the new orientation test meaningful — a test
that restates the basis it is checking cannot catch the basis changing.

**Proof each new guard can fail.** Every mutation below was applied, run, and
reverted; the working tree was verified clean of them afterwards and
`bun run check` re-run green.

| Mutation | What went red |
| --- | --- |
| `SUBSYSTEM_DECLARATION_ORDER` re-spelled in display order (the conflation itself) | `subsystem-order` **5 of 12** — both distinctness tests plus all three pins |
| `SubsystemCode` union reordered in `domain.ts`, the constant left alone | `subsystem-order` 1 — "equals the `SubsystemCode` union's own textual order" |
| `subsystem_code` `pgEnum` spelled in display order | three independent guards: `subsystem-order` ("equals the pgEnum drizzle actually holds"), `gateway-imports-core` ("and so do the two that used to be allowed to restate it"), and `drizzle-snapshot` (which emitted `0043_crazy_typhoid_mary.sql`) |
| `SUBSYSTEM_ORDER` swapped for `SUBSYSTEM_DISPLAY_ORDER` | `ons-interchange` **7 of 23**, including the new S↔SE trio: `S→SE` came back as `SE→S`, and `reorientedRows` went 1→0 on the flipped row and 0→1 on the straight one |
| `interchange.ts` importing the display order alongside the basis | `subsystem-order` "and neither of them reads the display order by mistake", plus `gateway-imports-core` |
| a third file (`jobs/diagnosis-publication.ts`) importing the orientation basis | `subsystem-order` "nobody else does", naming the file in the diff |
| `SUBSYSTEM_CODES` re-added as a back-compat alias | `subsystem-order` "the ambiguous name … is not reintroduced" |
| **non-vacuity** — the file scan pointed at a directory that does not exist | 4 red, including "scanned a real tree, so a clean result means something" |
| **non-vacuity** — the union parser given a type name that does not match | 1 red, on its own `toHaveLength(4)` before the equality |
| **non-vacuity** — the SQL parser given an enum name that does not match | 2 red |
| **non-vacuity** — the allow-list naming a file that does not import it | 3 red, including "both allow-listed files really do import it" |

The last four are api-surface 25's property: no equality in this file can be
satisfied by a scanner or parser that quietly matched nothing.

**One thing the work found by being caught by its own guard.** The first draft of
the `diagnosis-publication.ts` comment quoted the offending array literally, and
`gateway-imports-core` flagged the *comment* as a restatement. That is correct
behaviour rather than a false positive — api-surface 25 catalogued the scanner
that stripped comments and ate the code it was meant to read — so the comment was
reworded and the scanner left alone. It now says why it does not quote the
literal.

**Full output.** `bun run check` exits 0: typecheck clean across all four
projects, biome clean over 525 files, hygiene **120 pass / 0 fail** (107 before
this ticket: +12 in the new guard file, +1 in `gateway-imports-core`), core
**471 / 0**, api **1237 pass / 541 gated skip / 0 fail** (1233 before; +4
orientation tests), web **189 / 0**. Zero failures anywhere.
