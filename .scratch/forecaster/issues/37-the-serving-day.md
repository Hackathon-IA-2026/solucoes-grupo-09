# 37 — The serving day never arrived, and the rails that passed once did not pass twice

**What happened.** The two blockers forecaster 36 named were waited out rather
than worked around. The first cleared: `fc18-pg` reached **48** drizzle
migrations and the sibling's re-settle finished. The second did not: the weather
ingestion is **quota-blocked at Open-Meteo** and has not moved its head off
**2026-09-10 11:00Z** in eighty minutes of polling, so the serving day still has
**zero** weather rows.

A clone was taken anyway and both lanes were re-minted through the unmodified
`python -m wattsteer_ml.retrain`, at an `as_of` of **now**, on data that is
strictly better than 36's — a day more curtailment, programmed and verified load
filled forward, the resource versions re-settled, the frozen centroid set
repaired.

**And the gate refuses at check 6 this time, not check 7.** `serving_smoke`
never ran, because `guardrails` vetoed first — in `gate_early` on
`p50_unbiasedness` **0.4390** against a 0.45 floor, and in `gate_late` on
`recall@0.5[pooled]` **0.8163** against a bound of 0.8689. Forecaster 36's
twelve-for-twelve is **not reproducible one day later on better data**, which is
the most useful thing this pass learned and the thing it would have been
easiest not to find out.

**Nothing promoted. api-surface 10's end-to-end was not run** and its box stays
open, for the third wave running.

Everything below is measured on this run.

---

## The wait, and what it was for

| | |
|---|---|
| `fc18-pg` migrations at 02:44Z | **48** — the sibling had finished; first blocker cleared |
| weather head at 02:44Z | 2026-09-10 11:00:00+00 |
| weather head at 03:53Z | **2026-09-10 11:00:00+00 — unmoved** |
| polled every 30 s for | **69 minutes**, across five blocking rounds |
| forward runner attempts in that window | 4 (02:36, 02:56, 03:17, 03:37), **every one rate-limited** |
| `ingestion_run` for source `weather`, UTC day 2026-09-11 | **2 ok, 27 failed** |

The runner asks Open-Meteo's `single-runs-api` for a five-day window
(2026-09-09..2026-09-13, run cycles 00Z and 12Z) and is refused with
`WeatherRateLimitError … rate-limited 6 times` on its *first* model run, before
it reaches a forward valid time at all. The endpoint returns no rate-limit
headers, so the client's backoff has nothing to obey but the status.

**This is a daily unit allowance on the free tier, not an hourly window.** It
did not reset at 00:00Z — the run at 02:36Z, 156 minutes after UTC midnight, was
refused exactly like the one before it. The way out is already in the code and
is not ours to take: `WATTSTEER_OPEN_METEO_KEY` and the commercial host
`https://customer-single-runs-api.open-meteo.com`
(`apps/api/src/ingest/weather/single-runs.ts:49`, `apps/api/src/config.ts:201`).
**Obtaining that key is a decision for a human with a budget.**

**The weather runner was not stopped**, no ceiling was lowered, no feature was
imputed, no `as_of` in the past was picked, and no promote line was written.

---

## The clone, and that it is not the stale one

    docker run -d --name fc37-pg -e POSTGRES_PASSWORD=wattsteer -p 5448:5432 postgres:17-alpine
    docker exec fc37-pg psql -U postgres -c 'CREATE DATABASE wattsteer'
    docker exec fc18-pg pg_dump -U postgres --no-owner --no-acl wattsteer \
      | docker exec -i fc37-pg psql -q -U postgres -d wattsteer

Dump **1,736,455,861 bytes**, 44 s wall, **exit 0, zero bytes on stderr on both
sides, zero `ERROR` lines**. `ANALYZE` before anything read it. `fc18-pg` was
**read only** — one `pg_dump` and a handful of `max(valid_time)` selects — and
`bun run ml:test:db` and `bun run test:db` were **never invoked**. The container
was `docker rm -f`'d when this ticket was written.

What the clone holds, counted on 5448:

| | 36's clone | this clone |
|---|---|---|
| drizzle migrations | 48 | **48** |
| `curtailment_report_hour` | 4,765,728 | **4,782,883** |
| `weather_forecast_hour` | 1,355,785 | **1,417,839** |
| `weather_forecast_hour` max `valid_time` | 2026-09-02 15:00Z | **2026-09-10 11:00Z** |
| `programmed_load_half_hour` max | 2026-09-09 02:30Z | **2026-09-12 02:30Z** |
| `verified_load_half_hour` max | — | 2026-09-11 02:30Z |
| `dessem_balance_half_hour` max | 2026-09-10 02:30Z | 2026-09-10 02:30Z |

Weather advanced eight days of *past* valid times and programmed load advanced
three days. **Both of 36's named gaps are smaller and neither is closed.**

---

## The run

    .venv/bin/python -m wattsteer_ml.retrain --run-id 2026-09-11T03:24:00Z \
      --root …/artifacts37 \
      --database-url postgres://…@localhost:5448/wattsteer

Unmodified module, no shortcut around `train_fold` or `save_artifact`, no
hand-edit of an artifact, a card or the promotion log. **764.009 s** wall clock
and **1,645.9 MB** peak RSS as the run's own `Resources` block measured them
(377.638 s / 1,409.2 MB for `gate_early`, 386.236 s / 1,645.9 MB for
`gate_late`). Exit 0; two lanes reached a decision; `promoted: []`.

`--run-id 2026-09-11T03:24:00Z` is **the wall clock at the moment the run
started**, not a chosen window. It was the only `as_of` tried. It puts the
serving day at **2026-09-12** in Brasília civil time, because
`serving_target_date` is `BRASILIA(as_of) + 1 day` and 03:24Z is 00:24 BRT —
the calendar had rolled past midnight during the wait.

| | 36 | this run |
|---|---|---|
| deciding fold | F6, `sha256:77ad81fc…`, 71 days | **F6, `sha256:113cf069…`, 72 days** |
| base fit | 2024-04-01 → 2026-04-01, 70,176 rows, 22,511 positive | identical |
| calibration | 2026-04-02 → 2026-06-30, 8,640 rows, 3,148 positive | identical |
| test window | → 2026-09-09, 6,816 rows, 3,201 curtailed | **→ 2026-09-10, 6,912 rows, 3,244 curtailed** |
| live `feature_hash` | `sha256:f755511b…` | **`sha256:f755511b…` — unchanged** |
| admitted inputs | 66/78 early, 78/78 late | identical |
| background | `artifact`, 128 × 96, seed 20260830, 9,830,400 B | identical |
| bundles | 4,023,545 / 5,622,988 B | **4,227,049 / 4,972,240 B** |

The feature contract is byte-identical to the one 36, 34 and api-surface 10 all
recorded. **The fold hash is not**, and should not be: the calendar advanced one
day, which is what a daily retrain does.

---

## Every check, both lanes

Straight off `promotions.jsonl`.

| check | `gate_early` | `gate_late` |
|---|---|---|
| 1 `lane_identity` | pass — no incumbent, cold start | pass |
| 2 `estimator_allow_list` | pass — `lightgbm` | pass |
| 3 `feature_contract` | pass — `sha256:f755511b…` both sides | pass |
| 4 `freshness_and_coverage` | pass — trained to 2026-09-10 (1 d), 72 test days ≥ 60 | pass |
| 5 `paired_block_bootstrap` | pass — `P = 1.000` | pass — `P = 1.000` |
| 6 `guardrails` | **FAIL — `p50_unbiasedness`** | **FAIL — `recall@0.5[pooled]`** |
| 7 `serving_smoke` | **not reached** (`null` in the log) | **not reached** (`null`) |

### Check 5, the bootstrap — still a third better than the rung

2,000 resamples of **71** whole target days, 6,816 hours, seed 20260913,
comparator `same_hour_7d`, cold start in both lanes:

| | `gate_early` | `gate_late` |
|---|---|---|
| candidate qloss | **320.09 MWh** | **320.83 MWh** |
| comparator qloss | 478.55 MWh | 479.59 MWh |
| `P(candidate better)` | **1.000** | **1.000** |
| ties | 0 | 0 |
| required | 0.90 | 0.90 |

Marginally *better* than 36's 322.36 / 324.66. The fit is not worse in the
quantity the gate's headline comparison measures.

### Check 6, every guardrail, with 36's value beside it

| rail | `gate_early` (36 → now) | `gate_late` (36 → now) | bound |
|---|---|---|---|
| `pr_auc[pooled]` | 0.9514 → **0.9542** (vs 0.9391) pass | 0.9544 → **0.9546** (vs 0.9380) pass | ≥ comparator − 0.02 |
| `pr_auc[N]` | 0.9111 → **0.9180** (vs 0.8898) pass | 0.9199 → **0.9133** (vs 0.8898) pass | ≥ comparator − 0.02 |
| `pr_auc[NE]` | 0.9698 → **0.9724** (vs 0.9618) pass | 0.9724 → **0.9751** (vs 0.9598) pass | ≥ comparator − 0.02 |
| `pr_auc[SE]` | 0.9626 → **0.9670** (vs 0.9393) pass | 0.9714 → **0.9717** (vs 0.9393) pass | ≥ comparator − 0.02 |
| `pr_auc[S]` | 0.8861 → **0.8812** (vs 0.8575) pass | 0.8851 → **0.8770** (vs 0.8575) pass | ≥ comparator − 0.02 |
| `recall@0.5[pooled]` | 0.9188 → **0.8943** (vs 0.9195) pass | 0.9172 → **0.8163** (vs 0.9189) **VETO** | ≥ comparator − 0.05 |
| `coverage_p10_in_band` | 0.9077 → **0.8565** over 1,665 of 3,244 — pass | 0.9005 → **0.8862** over 1,722 of 3,244 — pass | in [0.85, 0.97] over ≥ 98 rows |
| `coverage_p90` | 0.9185 → **0.9205** pass | 0.9182 → **0.9128** pass | in [0.85, 0.97] |
| `p50_unbiasedness` | 0.4536 → **0.4390** **VETO** | 0.4599 → **0.4504** pass | in [0.45, 0.55] |
| `ece` | 0.0432 → **0.0401** pass | 0.0435 → **0.0421** pass | ≤ 0.05 |
| `crossing_rate` | 0.000149 → **0.0000** pass | 0.0000 → **0.000587** pass | ≤ 0.01 |
| `floor_coverage` | not applicable — no incumbent | not applicable | ≥ incumbent − 0.05 |

**By how much each veto misses:**

- `gate_early` `p50_unbiasedness` = **0.4390**, floor **0.45** — short by
  **0.0110**.
- `gate_late` `recall@0.5[pooled]` = **0.8163** against the comparator's
  0.9189 less 0.05 slack, i.e. a bound of **0.8689** — short by **0.0526**.

**No threshold was moved.** `COVERAGE_GUARDRAIL = (0.85, 0.97)` and
`P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)` are byte-for-byte what forecaster 33
found them, and the 5% NULL-rate drift ceiling was not touched either — it was
never reached.

### The lower tail, still fitted, still widening

| | `gate_early` | `gate_late` |
|---|---|---|
| `δ_lo` (36 → now) | +148.39 → **+129.73** | +148.86 → **+74.58** |
| `δ_hi` | 459.41 → **479.08** | 444.63 → **447.00** |
| `conformal_method` | `one_sided_split_cqr_stated_lower` | same |
| `conformal_lower_calibration_rows` / `lower_rank` | **1,372 / 1,236** | **1,287 / 1,160** |
| `conformal_lower_tail_fitted` | True | True |
| marginal `coverage_p10` | 0.9544 → **0.9263** | 0.9531 → **0.9396** |
| `coverage_p10_where_stated` | 0.9109 → **0.8643** over 1,761 rows | 0.9024 → **0.8874** over 1,740 rows |
| `coverage_p90_where_stated` | 0.9272 → **0.9291** over 3,214 | 0.9222 → **0.9221** over 3,211 |
| `upper_correction_realised` | 0.9906 → **0.9908** | 0.9956 → **0.9898** |

Forecaster 35's change holds its direction on a second real fit — `δ_lo` is
positive in both lanes, the tail is fitted, and the rail is ranked over the rows
whose P10 is a positive number. Forecaster 34's τ-floor atom binds harder than
last time: the rail counts **1,665 of 1,761** and **1,722 of 1,740** stated
rows, so **96 and 18 rows** have a served P10 that is positive but at or below
`τ⁺`, against 57 and 29 on 36's run and 0 of 3,201 on the pair both tickets were
written about.

**But `coverage_p10_where_stated` fell below its 0.90 target in both lanes**
— 0.8643 and 0.8874 — where 36 measured 0.9109 and 0.9024. That is forecaster
35's own acceptance criterion, met once and **not met on the next fold**, and it
is the same instability the `p50_unbiasedness` veto is an instance of. It is
recorded here rather than smoothed over; the guardrail that gates on it
(`coverage_p10_in_band`) still passed, at 0.8565, **0.0065 above its floor.**

---

## What this pass actually establishes about the rails

Forecaster 33 wrote that `p50_unbiasedness` has almost no headroom against a
right-by-construction model, measured a day-block standard error of **0.021**,
and predicted the statistic would land on either side of the 0.45 edge in
roughly two runs in five. Three consecutive daily fits now read **0.4439 /
0.4464** (vetoed), **0.4536 / 0.4599** (passed), **0.4390 / 0.4504** (vetoed in
one lane). That is 33's prediction coming true on the nose, and it means
**36's twelve-for-twelve was a draw from a distribution, not a state the system
had reached.** Whatever the weather key buys, it does not buy a promotion on its
own.

`recall@0.5[pooled]` at `gate_late` is the new finding and the larger one:
**0.9172 → 0.8163 in one day**, a 0.10 drop in the lane with *more* features,
while every `pr_auc` in the same lane held or improved. A rail that moves that
far between adjacent folds, in the one lane whose extra inputs
(`programmed_load_*`) were being filled forward by an ingestion during the
window this fold covers, is a **vintage question and not a fit question** — and
it is stated here as a hypothesis with its evidence, not as a conclusion. The
measurement that would settle it is the same fold re-scored against the
programmed-load vintage as of 36's run, and it was not taken.

---

## Check 7 was not reached, and what it would have found

`serving_smoke` is `null` in both decision lines — the gate short-circuits at
the first failed check. The serving day would nonetheless have refused, and the
counts are on the clone rather than on a message. The serving day is
**2026-09-12** in Brasília civil time, i.e. UTC `[2026-09-12 03:00,
2026-09-13 03:00)`:

| | rows on 5448 |
|---|---|
| `weather_forecast_hour` for the serving day | **0** |
| `weather_forecast_hour` for 2026-09-11 BRT | **0** |
| `programmed_load_half_hour` for the serving day | **0** |
| `programmed_load_half_hour` for 2026-09-11 BRT | 192 |

So the serving-day gap is **wider than 36's, not narrower**, and for a reason
that has nothing to do with the ingestions: the wait crossed Brasília midnight,
so the serving day advanced from 2026-09-11 to 2026-09-12 while the data stood
still. Programmed load, which now reaches 2026-09-12 02:30Z, covers the serving
day 36 was refused on and **not** the one this run asked for. **Every hour spent
waiting for weather costs a day of programmed-load coverage at midnight BRT.**

---

## What stands between this repository and a published forecast

Two things now, where 36 could say one:

1. **The serving day needs weather.** A commercial Open-Meteo key
   (`WATTSTEER_OPEN_METEO_KEY` + the `customer-` host the client already
   supports) is what buys the forward window. This is a purchase decision, not
   an engineering one, and no amount of retrying buys it.
2. **The calibration rails need to pass on the day the weather lands**, and
   this pass is direct evidence that they do not pass every day.
   `p50_unbiasedness` is a coin flip against its floor and
   `recall@0.5[pooled]` at `gate_late` moved 0.10 in twenty-four hours.
   **Neither is a reason to widen a bound**; both are a reason to find out why
   the statistics are this unstable before a promotion is expected to be
   repeatable.

---

**Status:** decided, nothing promoted, no threshold moved. **The quota half is
now addressed without a key** — see data-platform 31. The commercial key is
still needed before WattSteer monetises, but for a licence reason rather than a
capacity one, and it no longer blocks the serving day.

- [x] Waited **69 minutes** on the two blockers 36 named, polling every 30 s.
      `fc18-pg` reached **48** migrations and the first blocker cleared; the
      weather head did not move off **2026-09-10 11:00Z** and the second did
      not
- [x] The quota is named precisely rather than guessed at: `ingestion_run`
      shows **2 ok / 27 failed** for source `weather` on UTC 2026-09-11, every
      failure an Open-Meteo rate limit, and the 02:36Z attempt — 156 minutes
      after UTC midnight — was refused exactly like the ones before it, so it
      is a **daily unit allowance and not an hourly window**
- [x] Cloned `fc18-pg` at 48 migrations to `fc37-pg` on **5448** — 1,736,455,861
      bytes, restore exit 0, zero stderr bytes, zero `ERROR` lines, `ANALYZE`
      before any read — and re-minted both lanes through the unmodified
      `python -m wattsteer_ml.retrain` at an `as_of` of **now**: 764.009 s,
      1,645.9 MB peak RSS, exit 0, two decision lines, `promoted: []`
- [x] Checks 1–5 passed in both lanes; the bootstrap is **`P = 1.000`** over
      2,000 resamples of 71 whole days, qloss **320.09 / 320.83** against the
      `same_hour_7d` baseline's 478.55 / 479.59, 0 ties
- [x] **Check 6 refuses both lanes**, and by how much is printed:
      `p50_unbiasedness` **0.4390** short of its 0.45 floor by **0.0110** at
      `gate_early`; `recall@0.5[pooled]` **0.8163** short of its 0.8689 bound
      by **0.0526** at `gate_late`. Every one of the other ten rails is
      reported above beside its value on 36's run
- [x] **36's twelve-for-twelve did not reproduce**, one day later on strictly
      better data, at unchanged thresholds — which confirms forecaster 33's
      measured 0.021 day-block standard error on `p50_unbiasedness` and
      demotes 36's pass from "a state reached" to "a draw taken"
- [x] Check 7 was **not reached**, and the serving-day gap is counted anyway:
      **0** weather rows and **0** programmed-load rows for the serving day
      2026-09-12 BRT. The gap widened rather than closed, because the wait
      crossed Brasília midnight and moved the serving day forward a day while
      the data stood still
- [x] `bun run ml:test` and `bun run check` run and reported below
- [ ] **Nothing promoted, so api-surface 10's end-to-end box stays open.** It
      now waits on two things, not one: a commercial Open-Meteo key for the
      serving day's weather, and calibration rails that pass on the day it
      lands

---

## Verification

| Suite | Result |
|---|---|
| `bun run ml:test` | **1,784 pass · 93 skip · 0 fail**, 142.29 s, exit 0 — unchanged; this ticket changed no source file |
| `bun run check` | **exit 0** — typecheck clean, biome clean, **273 hygiene · 471 core · 1,284 api (583 skip) · 189 web pass, 0 fail** |
| `python -m wattsteer_ml.retrain`, both lanes, real history | 764.009 s, 1,645.9 MB peak RSS, 2 artifacts, 2 `refuse` lines, `promoted: []`, exit 0 |
| the clone against the dump | dump 1,736,455,861 B, restore exit 0, zero stderr bytes, zero `ERROR` lines, `curtailment_report_hour` 4,782,883, migrations 48 |
| the candidate `feature_hash` | `sha256:f755511b…`, identical to 36's and to the refused pair's |

`bun install` was run once in this worktree before `bun run check`: the fresh
worktree had no `node_modules`, and `packages/core` failed to typecheck on
`ajv/dist/2020.js`. That is a worktree-setup fact, not a repository one.

## What was deliberately not done

- **No threshold was moved.** `COVERAGE_GUARDRAIL`,
  `P50_UNBIASEDNESS_WINDOW`, the `recall@0.5` slack of 0.05 and the serving
  smoke's 5% NULL-rate drift ceiling are all byte-for-byte what they were.
- **No second `as_of`.** One run, at the wall clock when it started. The
  refusal is a reason to say so, not a reason to look for a friendlier window —
  and note that a *later* `as_of` would make the serving-day gap worse, not
  better.
- **No feature was imputed and no vector was hand-edited.**
- **No forced promotion, and therefore no end-to-end.** api-surface 10's last
  box is left open with its reason widened rather than ticked on a promote line
  written by hand. Four previous passes refused to tick it; this is the fifth.
- **The weather runner was not stopped**, and the weather gap was not filled by
  any other route. The commercial key is the route, and it is not ours to buy.
- **`bun run ml:test:db` and `bun run test:db` were never invoked**, and
  `fc18-pg` was read for one dump and a handful of `max(valid_time)` selects and
  never written, migrated or tested against. The clone `fc37-pg` on 5448 was
  `docker rm -f`'d.
- **No source file changed.** Nothing under `apps/ml/src` needed one.
- **Nothing under `test/`, `apps/api/src/ingest/`, `apps/api/src/database/`,
  `docs/specs/` or `drizzle/` was touched** — siblings were running against
  this tree.
- **No artifact, card or promotion log is in this commit**; they live in this
  session's scratch directory.
