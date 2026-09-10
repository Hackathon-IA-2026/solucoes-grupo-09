# 27 — Every checkable claim in the nine specs is verified against the tree

**What to build:** a sweep confirming the specs say true things, and a mechanism
so the checkable half cannot silently rot again.

This is the documentation analogue of api-surface 25, and it rests on the same
kind of evidence: a long list of claims that were **false when found**, each
discovered by accident while someone worked on something else.

* "eleven hours of operator notice" in five places — `gate_at` says **ten**
* the drizzle snapshots described 33 tables while the schema had 38
* one caching row count claimed three different numbers in three artefacts
* "21 columns" was 22 names over 21 rows
* a 90-day calibration table had three 91-day rows
* `observed_constrained_off_same_hour_exceedance_7d` was called unemitted in
  **five** places after migration `0036` made it the 112th attribute
* "there is no national band" survived in three places after forecaster 08 and 22
* `/v1/backtest` was "not served" in four places after replay 08 served it
* two tables were said to be absent from `schema.ts` that migration `0034` created
* an archive writer was called unbuilt while its column is `not null`
* a comment vouched for a 0.62 shrink factor as "the same one `grid.ts` uses"
  after `grid.ts` had moved to a drawn ensemble

None of these broke a test. Every one of them would mislead a reader, and several
misled an *agent* into building the wrong thing before the record was corrected.

**The work.** Go through `docs/specs/*.md` and verify the claims a machine can
check: counts (columns, rows, routes, attributes, tables, migrations, fixtures),
named files and symbols, numeric constants that also live in code or SQL, and
claims of the form "does not exist / is not built / is not served / today there
is no". Report each as **true**, **false and fixed**, or **not checkable**.

**Then leave behind a guard for the mechanical subset.** Counts and file
references are the two classes that rot silently and are cheaply derivable —
`cache-policy.test.ts` already parses the spec's own caching table and derives its
count rather than restating it, and `spec-examples.test.ts` binds fenced examples
by fence ordinal. Extend that idea to whichever claims can carry it. **Do not
invent a guard that needs a human to keep a list in step** — that is the failure
this ticket exists to end.

Be honest about the ceiling: prose claims about intent, judgement or the future
are not checkable, and a sweep that pretends otherwise is worse than one that
scopes itself. Say what you did not check and why.

**Blocked by:** None.

**Status:** done

- [x] Every checkable claim across the nine specs is reported true, fixed, or
      out of scope, with the check used
- [x] No false claim is left standing; corrections record what happened rather
      than deleting the history of what was found
- [x] Counts that can be derived are derived, and a guard fails when one drifts
- [x] The guard's inputs are proven non-empty — an empty parse must not pass
      (this repo has been bitten by that four times)
- [x] What was not checkable is listed, not hidden

## What landed

**220 machine-checkable claims across the nine specs. 201 true, 18 false and
fixed, 61 out of scope and named.** (The three sets overlap only in the sense
that a spec sentence can carry more than one claim; each row below is one
assertion about the tree.)

`test/spec-claims.ts` + `test/spec-claims.test.ts` — the standing guard, in the
root hygiene suite (`bun run test:hygiene`, 32 tests). Nine derivations, and
**not one list a human keeps in step**: `feature_row`'s attributes replayed from
`CREATE TYPE` / `ALTER TYPE … ADD ATTRIBUTE` across the migrations;
`feature_dictionary_entry`'s seeded rows with their six booleans; `gate_at`'s two
local hours out of `0016`; `ERROR_STATUS`'s codes and statuses out of
`errors.ts`; every route registration under `apps/api/src/api` (all three literal
forms — a plain path, `${CANONICAL_BASE_PATH}/…`, `canonicalReadPath("…")`); the
schemas that declare a `next_cursor`; the distinct refusal codes in
`fixtures/scenario-validation/refusals/`; the `DriverCode` union; and the
working-tree file listing.

Each derived number is then bound to the spec's own words **by a regex over the
prose, not by a line number** — which is the property that makes it maintenance
-free: a sentence stating the quantity is checked whether or not anybody thought
to register it, and a sentence added next year is checked the day it is written.
Both directions are asserted where both exist: a route served with no row in the
endpoint list fails, *and* a row naming a path nothing serves fails.

### The eighteen false claims

**The gate interval, in five places — the one this ticket predicted.**
`feature-engineering.md` priced the augmented feature set's lost operator notice
at **eleven hours** in five sentences, including a table row reading "D−1 09:00
BRT … **eleven hours later** … D−1 19:00 BRT". `gate_at` maps `gate_early` to
local hour 9 and `gate_late` to 19: the interval is **ten**. `forecaster.md` had
the identical defect and forecaster 18 had already corrected it there, so the
two specs disagreed with each other as well as with the SQL. Corrected, with the
provenance kept: `0025`'s comment says where the eleven came from — "eleven,
counting from the 08:00 BRT dispatch desk" — which is the desk-to-gate *wait*,
a different quantity from the notice one set gives up relative to the other. The
migration is not rewritten; the note names both quantities.

`apps/api/test/features-gate.test.ts` had to change too, and it is the more
interesting half: its assertion read `expect(table).toContain("eleven hours")`.
**A guard was pinning the false number into the spec.** It now derives the gap
from `gate_at`'s own hours in `RAW` and asserts the spec states that, so it
cannot pin the next wrong one either.

**The code table was not the code table.** `api-surface.md` calls its error
table "the union of the optimizer's eighteen validation codes, Replay's five
refusals, and the eleven this spec adds". Thirteen rows plus twenty-five named
verbatim is 38; `errors.ts` publishes **49**. Ten codes appeared in the document
nowhere at all — the five framework-level refusals (`BAD_INPUT`,
`REQUEST_INVALID`, `ROUTE_NOT_FOUND`, `INTERNAL`, `SERVICE_BUSY`) and five of the
six `ml-proxy` mappings — and the eleventh, `OPTIMIZER_NOT_READY`, appeared once
in the `/v1/backtest` paragraph **with the wrong status** (`502` against the
enum's `503`). All eleven are now rows in the spec, with the structural reason
they went missing recorded: the `ml-proxy` vocabulary is settled in a prose
section, and a vocabulary split between a table and two paragraphs has no single
reader.

**The endpoint list was fourteen rows over seventeen served paths.** `GET
/v1/model/card/raw` and `POST /v1/replay/observed-only` are mounted, cached and
rate-limited and were named nowhere in `api-surface.md`; `GET
/v1/replay/days/<date>` is argued twice in its prose and had no row. The header
line and the Out-of-Scope line both said fourteen, and "two fixed-by-spec POST
contracts" was three. Fixed, and the pattern named: each of the three is *the
second representation of a row already there*, and a list organised by screen
has no slot for "the same thing, differently".

**Pagination was on one route, not two.** `next_cursor` is declared in one
schema and issued by one handler (`GET /v1/curtailment/hours`). `episodes` was
the presumed second because it takes the same range; it accepts no `cursor` and
returns none, and `reasons` bounds itself with `limit`. Said twice, wrong twice —
and the §5–7 route line for `hours` omitted its `cursor=` parameter, so the one
route that *does* page was the one the spec did not spell.

**"The code alone travels" was true of the domain and false of the wire.**
`api-surface.md` withdrew the `label` → `labelCode` rename on the grounds that it
"would reintroduce a field the current design deliberately does not have". There
are two `Driver`s: the domain one (`packages/core/src/domain.ts`) has neither
field, and the **wire** one, generated from `diagnosis.schema.json`, carries
`label_code` as a **required** member. Nothing in the code needed changing —
`label_code` is a `t()` key, which is the property the withdrawal was protecting
— so the record says the claim's *scope* was wrong rather than editing the
sentence to fit.

**Five paths named files that had been deleted or renamed, in four specs.**
`apps/web/src/lib/domain.ts` was "the single frontend definition" in
`api-surface.md` and the file a change was "required to" in `diagnosis.md`, two
tickets after api-surface 03 promoted it into `packages/core` and 07 deleted it.
`apps/web/src/lib/economics.ts` was still "the single place it is written down"
in `flex-optimizer.md` — the live cross-language bug api-surface 03 was written
to close. `i18n.md` offered a sibling test as `test/i18n-hygiene.test.ts`; it
landed as `test/i18n-hardcoded-copy.test.ts`. `i18n.md` also named a `pt.json`
bundle that has never existed — the bundles are `copy.pt.ts` / `copy.en.ts`,
which is what makes a missing key a type error. And `strip-and-rename.md`'s
Problem Statement described `apps/api/src/index.ts` in the present tense; it now
says the file was deleted by that ticket.

### Proving the guard fails, and that it cannot pass empty

Both were measured against the real tree, not argued:

| Mutation | Result |
|---|---|
| `112 attributes` → `113` in the spec | 1 fail — `feature_row attributes: derived 112` |
| `ten hours less` → `eleven hours less` | 1 fail — `operator notice: derived 10` |
| a row deleted from the endpoint list | 1 fail — "lists every `/v1` path the gateway serves" |
| `ml-proxy.ts` → `ml-bridge.ts` in a spec | 1 fail — the unresolved-path census |
| a code added to `ERROR_STATUS` | 1 fail — "names every code the enum can return" |
| the `feature_row` parse broken to match nothing | **3** fails, one of them the non-emptiness check |

`describe("the guard is not vacuous: an empty parse does not pass")` holds the
polarity in-process: an empty spec corpus, an empty file listing and an empty
derivation each make the assertion go red rather than green. The empty file
listing is the one worth naming — it marks *every* reference unresolved, never
resolved, which is the opposite polarity to the parity READMEs' defect that read
green over a directory they never listed.

### What was not checkable, and why — 61 items

- **52 bare-name file references** (`grid.ts`, `replay.ts`, `pt.json`,
  `ordered_features.yaml`). This tree holds three files called `grid.ts` and two
  called `replay.ts`, so "a file of that name exists" is true of nearly any name
  and proves nothing about the one the spec meant. Only the 135 **path-form**
  references are in the guard. The bare names were swept by hand this once, which
  is how `pt.json` was found.
- **`IDEA.md`**, cited by section number in five specs and exempted by
  `test/repo-hygiene.test.ts` as "the historical source document". It is in no
  commit in this repository's history and not in a fresh worktree, so its absence
  here cannot be distinguished from an untracked local file. Reported, not
  "fixed" — deleting five specs' provenance citations on this evidence would be
  the wrong call.
- **Counts that exist only inside a live Postgres.** The nine rows of
  `canonical_read_go_live` (derived at runtime from `canonical_read_source()`);
  "the thirty-five uncommented attributes" (needs `col_description`); the eleven
  feature blocks (plpgsql bodies, not statically enumerable with confidence).
  The gated `database-features.test.ts` is where these belong and already
  measures the first.
- **Row counts over real data**: ≈84,500 and ≈44,200 rows per set, 210,432,
  11,904 over 62 target dates, 500 × 24 paths, 848 rows/year (the *arithmetic*
  22 848 × 6 = 137 088 was checked and is right; the 22 848 itself is data).
- **Measured physical quantities**, which trace to `docs/research/` and are the
  evidence base rather than a derivable fact: RMSE 4.38 vs 4.76 km/h on
  `wind_speed_120m`, the 0.03% DESSEM/`carga-energia-programada` agreement, the
  S3 `Last-Modified` 19:42:43 GMT against CKAN's `created`, DESSEM's 14:48–16:42
  BRT creation window.
- **"Four constants move"** in `api-surface.md` §`packages/core`, which then
  names six. Genuinely ambiguous — four of the six may be the ones that *moved*
  as opposed to being newly published — so it is left alone rather than guessed
  at.
- **Everything about intent, judgement and the future**, which is most of every
  spec and rightly so. "A refusal is legible; a repair is a plausible answer to a
  question nobody asked" is an argument, not a fact about the tree, and no guard
  should pretend otherwise.

### Two things this ticket names rather than closes

**1. The absence exemption is the weak half, and it is measured rather than
trusted.** A path reference that does not resolve is excused when its own
paragraph says the file is gone, in the ordinary English the specs already use
(`ABSENCE_MARKERS`: "deleted", "retired", "before commit", "no longer", …). That
is a closed vocabulary rather than a list of files — it needs no edit when a spec
changes — but a paragraph that legitimately uses one of those words *and* carries
a rotted path gets a free pass. So the suite asserts the exempt set is non-empty
**and under a quarter of the corpus** (it is 14 of 135), so that the day the
exemption starts governing everything, somebody is told.

**2. Correction notes are recognised by sentence, not by paragraph, and that was
a bug caught in the making.** The specs correct themselves by quoting the wrong
number back, so a binder must not read those quotations as live claims.
Paragraph scope was tried first and was far too generous: three live counts — the
attribute total, the proxy census, the model-input pair — sit inside long notes
whose *other* sentences correct something else, and a paragraph-scoped exemption
silently stopped governing all three while every test stayed green. Sentence
scope fixed it, and the emptiness assertion on each binder is what surfaced it.

### Commands

```
bun run test:hygiene   #  91 pass, 0 fail (32 of them this ticket's)
bun run test           # 1219 + 471 + 189 + 91 pass, 0 fail, 524 skip (gated)
bun run lint           # 517 files, clean
bun run typecheck      # clean
```
