# 25 — The DESSEM refusals, re-asked against the settlement fix, and the one that was ours

**What to build:** the first at-scale exercise of data-platform 22's settlement
machinery, and an answer — from real payloads — to the question ticket 21 left
open: of the 105 DESSEM reference days this platform refuses, how many are ONS's
data and how many are our reading of it.

**Blocked by:** None. Ticket 22 is merged and is what makes the question
askable: before it, a census had to pass `force: true` on every day because the
fingerprint state could not be trusted, and a refusal was not recorded anywhere.

**Status:** done. One day recovered, one assertion sharpened, two diagnoses in
ticket 21 corrected, and the 22% figure confirmed as very nearly right.

---

## The answer, first

**366 of 470 reference days load. 104 are refused, and 103 of those are
properties of what ONS published.** Ticket 21's headline — 22% of DESSEM's
history is unusable — survives the re-ask almost intact. What does not survive
is two of its three explanations.

| | ticket 21 (475 days) | this run, before the fix | after the fix |
| --- | --- | --- | --- |
| loaded | 370 | 365 | **366** |
| refused — `coverage` | 34 | 34 | **34** |
| refused — `forecast_integrity` | 68 | 68 | **70** |
| refused — `time_axis` | 3 | 3 | **0** |
| total | 475 | 470 | 470 |

The catalogue itself moved between the two censuses: ONS offers **470** CSV
reference days in range today against the 475 ticket 21 counted. That is the
dataset, not a measurement difference, and it is worth noting that a "fixed"
denominator for this source does not exist.

---

## 1. The settlement machinery works, and this is the first time it has been run at scale

Three passes over the whole published history, against a database migrated to
0047 and holding no DESSEM rows at the start.

| pass | HEADs | downloads | rows written | wall clock |
| --- | --- | --- | --- | --- |
| forced, pre-fix | 470 | 470 | 70,080 | 227.9 s |
| **no force, immediately after** | **470** | **0** | **0** | **98.1 s** |
| forced, post-fix | 470 | 470 | 192 | 229.9 s |

The middle row is the whole of ticket 22 in one line. 470 `HEAD`s, not one
byte downloaded, not one row written, **105 refusals still reported** with
`refusedThisRun: false` on every one of them — settled is not the same as
silent, exactly as the ticket claimed. And the state reads back the way ticket
22's own SQL says a healthy sweep should:

```
      dataset_slug      | ingested | refused | unsettled | total
 balanco_dessem_detalhe |      366 |     104 |         0 |   470
```

**Zero unsettled.** Every one of the 470 resources is now either a day that
landed or a day recorded as refused with a reason and ONS's own sentence. The
state that made ticket 21's census have to force everything — bytes held whose
parse neither landed nor was refused — does not exist in this database.

The third pass also demonstrates the half of the fix an adapter change needs:
`force: true` re-parsed all 470, and the day the fix recovers was **inserted**
(192 rows) while the 365 that already held were **unchanged** (70,080). A
recorded refusal is not cleared by an adapter fix on its own — it is cleared by
re-asking with force, which is what ticket 22 said and is now measured.

---

## 2. The 68: not our defect, and not what ticket 21 said they were

**The verdict `forecast_integrity` is right. The diagnosis behind it was wrong
for 58 of the 68 days, and the difference matters.**

Ticket 21 wrote that all 68 were files "ONS re-published *after* the day they
forecast", and concluded that "ONS overwrote the file, and with it the only
evidence of when the original vintage was published". Read against the
catalogue, that is true of **10** of them and false of the other **58**.

**There is no stamp inside the payload.** Checked on real bytes: the CSV's
columns are `din_programacaodia`, `num_patamar`, `cod_subsistema` and the nine
`val_*` measures, and `din_programacaodia` is the reference day, not an issue
instant. Nothing in the file says when DESSEM ran. The S3 object carries
`Last-Modified`, `ETag` and `Content-Length` and nothing else; there is no
object versioning.

**There is a second stamp in the dataset metadata, and the adapter was
throwing it away.** CKAN's `package_show` gives every resource both a
`last_modified` and a `created`. `readResources` folded them together —
`raw.last_modified ?? raw.created`, stored under the name of the first — and
that coalesce is what made the two cases below indistinguishable. Read apart,
they separate cleanly:

**(a) 58 days ONS never published in time at all.** `created` is *itself* after
the reference day, and `last_modified` is null — the resource entered the
catalogue once, late, and has never been touched since. These are not
re-publications. They are gaps ONS fills in batches, and the batching is the
proof:

| first catalogued | reference days published in that batch |
| --- | --- |
| 2025-10-23 | 10 |
| 2025-11-17 | 13 |
| 2026-01-13 | 6 |
| 2026-02-02 | 3 |
| 21 other dates | 1–2 each |

October 2025, day by day, is the clearest view of it. 2025-10-07 and -08 were
first catalogued on 2025-10-23 at 17:45 and 17:43; 2025-10-09, -10 and -11 —
sitting between them — were catalogued on 2025-10-08, -09 and -10 at ~19:23,
each on its own D−1 evening. A bucket-wide re-upload cannot produce that
pattern. Scattered missing days, filled later in a batch, can and did.

For these days **no day-ahead vintage was ever offered**, so there is nothing
for a corrected reading to recover. `published_at` is already being read from
the right place for them: with `last_modified` null, the adapter was falling
through to `created`, which is the honest first-publication instant, and it
is after the day.

**(b) 10 days published on time and overwritten afterwards.** `created` is the
D−1 evening; the bytes in hand were written anywhere from eight hours to five
months later.

| reference day | first catalogued | overwritten |
| --- | --- | --- |
| 2025-12-04 | 2025-12-03 17:10 | 2026-01-13 21:03 |
| 2025-12-11 | 2025-12-10 16:44 | 2025-12-11 12:19 |
| 2025-12-12 | 2025-12-11 16:06 | 2026-01-13 20:53 |
| 2026-02-09 | 2026-02-08 16:01 | 2026-03-04 20:02 |
| 2026-03-04 | 2026-03-03 19:26 | 2026-03-04 20:24 |
| 2026-03-14 | 2026-03-13 18:42 | 2026-08-18 18:45 |
| 2026-03-15 | 2026-03-14 16:55 | 2026-03-16 17:41 |
| 2026-06-04 | 2026-06-03 22:52 | 2026-06-04 06:53 |
| 2026-09-01 | 2026-08-31 20:03 | 2026-09-01 18:47 |
| 2026-09-04 | 2026-09-03 19:21 | 2026-09-07 00:08 |

For these, ticket 21's sentence is half right. The *instant* of the original
vintage is recoverable — `created` has it. The *values* are not: what this
platform holds is the rewrite.

**And that is why `published_at` does not change.** Stamping the rewritten
bytes with `created` would place values ONS wrote in January under a
publication instant in December, and `canonical_day_ahead_balance` cuts
forecast features on `published_at ≤ gate` precisely so that a feature can only
see what was knowable (`docs/specs/feature-engineering.md`). Ten days of
leakage into the gate is a worse outcome than ten days of absence, and it is
the exact failure the gate exists to prevent. `published_at` is the vintage of
the bytes in hand, and the bytes in hand were asserted at the rewrite.

So: **no day is recovered by reading the publication instant differently, and
`published_at` is unchanged for every consumer of it.** No column moves, no
canonical read answers differently, no gate admits a row it did not admit
before. What changes is only what the platform can *say*.

### What did change

`CatalogueResource` now carries `firstPublishedAt` — CKAN's `created` — beside
`lastModified` instead of hidden behind it, `acquireBulkResource` passes it
through, and a DESSEM day refused for `forecast_integrity` now names which of
the two upstream facts produced it, in ONS's own timestamps. The refusals read:

> …A row with published_at ≥ valid_time is an observation, and this table holds
> forecasts. **ONS first catalogued this file at 2025-10-23T17:45:18.296Z,
> itself at or after that half hour: the day was published late for the first
> time, so no day-ahead vintage of it was ever offered and none can be
> recovered.**

against

> …**ONS first catalogued this file at 2026-09-03T19:21:48.071Z, before that
> half hour, and overwrote it afterwards: a day-ahead vintage existed, but the
> bytes in hand are the rewrite. Stamping them with the earlier instant would
> admit values through a gate that could not have seen them.**

That distinction is the whole reason ticket 21's diagnosis was wrong by 58
days, and it is now in the row rather than in a census someone has to re-run.

---

## 3. The 3 solar-in-local-night days: overturned. This one was ours

**`assertDaylightAlignment` was asserting something about the data that was
never true, and it refused three complete days over it.**

All three days — 2025-10-18, 2025-12-03, 2025-12-24 — carry a full 48
patamares for all four subsystems. Read the payloads:

| day | offending patamar | local hour | `val_ger_fotovoltaica` | `val_ger_mmgd` | midday peak |
| --- | --- | --- | --- | --- | --- |
| 2025-10-18 | 43 (N), 44 (SE) | 21:00, 21:30 | **0.000** | 6, 3 | 17,310 MW |
| 2025-12-03 | 43 (SE) | 21:00 | **0.000** | 3 | 17,358 MW |
| 2025-12-24 | 43 (SE) | 21:00 | **0.000** | 6 | 21,415 MW |

Photovoltaic output — the quantity the assertion's reasoning is actually about,
the one that is zero in darkness as a matter of physics — is **exactly 0.000
through the entire evening on all three days**. What fired the assertion is
`val_ger_mmgd`, which the check was summing into "solar". MMGD is micro and
mini distributed generation: mostly rooftop PV, but it carries small hydro,
biogas and cogeneration, and those run after sunset. Six megawatts is 0.03% of
that day's midday peak.

The evening profile of 2025-10-18, subsystem N, settles that it is not a
shifted index:

```
  patamar 36  17:30h   pv=0.000   mmgd=135.000
  patamar 37  18:00h   pv=0.000   mmgd= 15.000
  patamar 38  18:30h   pv=0.000   mmgd=  2.000
  patamar 39–42  19:00–20:30h     mmgd=  0.000
  patamar 43  21:00h   pv=0.000   mmgd=  6.000
  patamar 44–48  21:30–23:30h     mmgd=  0.000
```

A solar day walked into the night by an offset is monotone. This is a lone blip
with zeros on both sides of it, three hours after the MMGD sunset decay had
already reached zero.

The fix drops MMGD from the **night** window only and leaves it in the midday
window, where it is a floor and more terms clearing a floor is the safe
direction. The guard gets **sharper**: the only quantity that could satisfy it
without the mapping being wrong is the one removed. Two tests hold both halves
— a six-hour patamar shift still throws, and photovoltaic output in the same
half hour that MMGD is now allowed in still throws.

**One day recovered: 2025-10-18, 192 rows.** The other two turn out to be
doubly defective — 2025-12-03 was also overwritten (2026-01-13) and 2025-12-24
was also first catalogued late (2026-01-13), so with the night assertion out of
the way they reach `writeDessemBalance` and are refused there instead. That
they moved from `time_axis` to `forecast_integrity` is the right outcome: the
night assertion had been masking a second, genuine defect on both.

---

## 4. The 34 short civil days: refusal confirmed, reason corrected

Every one of the 34 was re-read from its payload. They are not what the
adapter's comment said they were, and they are not loadable either.

**They are not days with holes in them.** Every one is a *contiguous* run: 23
are a prefix starting at patamar 1 (1…21, 1…43, 1…46) and 11 are a suffix
ending at patamar 48 (45…48, 42…48, 15…48). Not one has an interior gap. And
they are short in *every* subsystem, not one — the refusal naming subsystem `N`
was only naming the first key the map iterates.

**The stated reason for refusing them is wrong.** The comment said a short day
"may mean something other than what this adapter assumes" about the period
index. It does not: on **29 of the 34** the solar profile sits exactly where
`assertDaylightAlignment` requires it, 12–22 GW at midday and nothing at all at
night, which pins the index absolutely. The other five are too short to contain
a midday at all. The files disprove the worry.

**They stay refused for a different reason, and it is a good one.** A
46-patamar day written into `dessem_balance_half_hour` is indistinguishable
from a 48-patamar one. There is no column that says "this reference day was
published two half hours short"; `canonical_day_ahead_balance` would simply
answer 46 rows for it, and every consumer that divides by a day, or assumes a
contiguous horizon, would be quietly wrong. `coverage` is exactly the right
name for that, and admitting a partial publication is a schema question — it
needs somewhere to record the shortfall — not an adapter one.

So the refusal is kept, the comment is rewritten to say what was measured, and
the refusal detail now carries the shape so nobody has to re-download 470 files
to learn it again:

> Reference day 2026-01-14 has 46 patamares for subsystem N; the local civil
> day is 48 half hours long. **The patamares present are the contiguous prefix
> 1…46: a publication cut short, not a shifted index.**

---

## What remains genuinely unusable

**104 of 470 reference days, 22.1%.** Three groups, none of them recoverable by
anything this platform can do:

- **60 days ONS never catalogued until after the day had passed.** No
  day-ahead vintage was ever offered. Nothing recovers these, ever.
- **10 days published on time and overwritten afterwards.** The original
  instant survives in CKAN's `created`; the original values do not, and using
  the instant without the values is leakage.
- **34 days published short** — a contiguous prefix or suffix of the civil day.
  Physically readable, structurally unstorable.

The honest statement of DESSEM's usable history is **366 reference days out of
the 470 the catalogue offers**, 2025-05-23 → 2026-09-12, with 104 holes in it.
Any A/B that wants a contiguous DESSEM window still has to be planned around
the holes; there are one fewer of them than ticket 21 said, and the reasons for
the rest are now on the rows.

## Two things this ticket deliberately does not do

- **It does not admit partial days.** 29 of the 34 short days carry real DESSEM
  forecast half hours under a mapping the file itself confirms, and refusing
  them is throwing away data that is arguably good. Admitting them needs a way
  for `dessem_balance_half_hour` and `canonical_day_ahead_balance` to say a
  reference day is incomplete — a column and a read change, decided with the
  forecaster lane, not an adapter loosened on the way past. **Worth its own
  ticket**; the measurement is above and does not need repeating.
- **It does not touch `fc18-pg`.** The wave database stands at 43 migrations
  and the operator instruction for this work was not to migrate it while a
  weather ingestion was running against it. The settlement columns 0047 adds
  are what this whole ticket exercises, so the three passes ran against a
  throwaway Postgres migrated to 0047, on its own port, with its own archive
  directory. **`fc18-pg` therefore still holds ticket 21's 69,888 DESSEM rows
  over 364 run labels and no `ingested_at` at all**, and applying 0043–0047 and
  re-running the history against it is an operator step this ticket has not
  taken. All four pending migrations are purely additive — one new table, one
  check constraint on it, two enum members, four nullable columns — and none of
  them touches a weather table.
