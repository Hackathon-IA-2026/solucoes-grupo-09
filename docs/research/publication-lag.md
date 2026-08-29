# Publication lag — what the sources actually do

The note the scheduled suite `apps/api/test/publication-lag-conformance.test.ts`
cites when a claim in it expires. Everything below is a **measurement**, with the
instant it was taken and the method that took it; where a number is still an
inference rather than an observation, it says so in those words.

The reason this note exists at all: `docs/specs/feature-engineering.md` is built
on conservative defaults that stand in for measurements, and they are load-bearing
in both directions. Too tight and the platform serves a leak; too loose and it
throws away usable actuals and the features built on them. Neither is discoverable
without asking the sources.

- **The configured lags** are seeded by
  `apps/api/drizzle/0021_lagged_actuals_behind_the_cutoff.sql` into
  `feature_publication_lag`. Nothing writes that table at runtime, so changing one
  is a migration.
- **The day-ahead programme's publication instant** is
  `PROGRAMME_PUBLICATION_HOUR_BRT` in `apps/api/src/ingest/ons/load.ts`. It is
  written into `published_at` at ingest, so changing it is a migration *and* a
  re-ingest.
- Either change moves which rows clear which gate, which moves the feature
  distribution the model was fitted on. **Both are retrain triggers**, and the
  suite's failure messages say so in the imperative.

---

## Method, and the two things it cannot see

For each observation dataset the suite asks one question:

> At this instant, what is the newest `valid_time` the source has actually
> published?

That is the quantity `actuals_cutoff` is about.
`actuals_cutoff(gate, dataset) = gate − publication_lag_hours[dataset]` promises
that every hour at or before the cutoff is published by the time the gate falls.
Read at an instant, the promise is exactly

```
now − newest_valid_time  ≤  publication_lag_hours[dataset]
```

and the suite fails when it is not. Two honest limits:

1. **The newest published hour does not prove there is no hole behind it.** A
   gap in the middle of the series is the ablation seam's job (seam 2), not this
   one. This measures lateness.
2. **`now − newest_valid_time` overstates the real lag**, because the file may
   have been published hours ago with nothing newer since. That is the right
   direction to be wrong in for an alarm — it is the operational quantity, "how
   stale is the freshest actual available to a gate falling right now" — and the
   tighter number, *lag at publication* (`Last-Modified − newest valid_time`), is
   published beside it on every run.

A third limit is about *when the suite runs*, and it matters more than either:
staleness is sawtoothed. It climbs through the day and drops when ONS publishes.
A single daily run samples one point on that tooth, so the series of runs is the
measurement, not any one of them.

---

## Measured 2026-08-29, 11:53 BRT (14:53 UTC)

One run of `bun run test:lag`, against the live sources. `staleness now` is the
quantity the configured lag is tested against; `headroom` is what was left.

| dataset (seed key) | configured | newest `valid_time` | source stamp | lag at publication | staleness now | headroom |
|---|---|---|---|---|---|---|
| `balanco-energia-subsistema` | 40 h | 2026-08-27 23:00 BRT | 2026-08-28 19:00 BRT | 20.01 h | 36.90 h | **3.10 h** |
| `intercambio-nacional` | 40 h | 2026-08-27 23:00 BRT | 2026-08-28 19:04 BRT | 20.07 h | 36.90 h | **3.10 h** |
| `restricao-coff` | 40 h | 2026-08-27 23:00 BRT | 2026-08-28 19:07 BRT | 20.12 h | 36.90 h | **3.10 h** |
| `restricao-coff-detalhe` | 40 h | 2026-08-27 23:30 BRT | 2026-08-28 19:08 BRT | 19.64 h | 36.39 h | 3.61 h |
| `carga-verificada` | 6 h | 2026-08-29 11:00 BRT | 2026-08-29 11:31 BRT | 0.52 h | 0.89 h | 5.11 h |
| `capacidade-geracao` | 24 h | 2026-08-28 19:00 BRT (the file itself) | same | — | 16.88 h | 7.12 h |

**Every configured lag held.** Nothing here is a licence to tighten one; see the
next section for why.

### balanco-energia-subsistema — measured lag

The yearly file is rewritten on the ONS 19:00 BRT cycle carrying hours through
the end of the *previous* civil day: 20.01 h of lag at publication. Measured
staleness 36.90 h against 40 h configured.

**The real lag is half the configured one, and the headroom is still three
hours.** Those two facts are not in tension, and the distinction is the whole of
what this note is for: the file advances once a day, so staleness climbs from
~20 h at publication towards ~44 h before the next one. 36.90 h was sampled at
11:53 BRT, before that day's first refresh cycle. The ticket's "throwing away a
full day of usable actuals" worry is real in the narrow sense — at `gate_late`
the configured cutoff falls at D−2 03:00 BRT while the source has in fact
published through D−2 23:00 BRT — but **tightening the 40 h on the strength of the
20 h figure would be a mistake**, because 20 h is the lag at the bottom of the
sawtooth and the gate can fall anywhere on it. See "What is still open".

**Follow-up, 2026-08-29 12:02 BRT — the 12h cycle republished this file without
advancing it.** It was rewritten at 12:00:34 BRT and its newest `din_instante` was
*still* 2026-08-27 23:00 BRT. So ONS's documented "Diariamente, as 12h e 19h"
cadence means two *publications* and — for this dataset, on this day — one
*advance*: the coverage moved forward only on the evening cycle, by a whole civil
day at a time.

That changes the shape of the sawtooth, and the consequence is sharp enough to
state plainly:

```
coverage advances only at ~19:05 BRT, to the end of the previous civil day
  ⇒ staleness just before the evening cycle
      = 18:45 BRT on D−1  −  23:00 BRT on D−3
      ≈ 43.7 h
  ⇒ against a configured 40 h
```

`gate_late` is D−1 19:00 BRT, and the evening publication was observed landing at
19:00:25 / 19:04 / 19:07 / 19:08 BRT on 2026-08-28 — **after the gate**. So a gate
falling at 19:00 computes `actuals_cutoff` at D−2 03:00 BRT while the source has
in fact published only through D−3 23:00, and the four hours in between are hours
that exist in training (they were backfilled long ago) and do not exist at serve
time. That is train/serve skew, and it is the direction the whole cutoff exists to
prevent.

Two caveats, because this is projected from two measured facts and not yet
directly observed at 18:45 BRT: it assumes no further refresh between 12:00 and
19:00 BRT, and it was measured on a **Saturday**, where a weekend cadence could
differ. The 21:45 UTC scheduled run measures it directly; see "What is still
open".

### intercambio-nacional — measured lag

Same yearly split, same cycle: 20.07 h at publication, and its file was rewritten
four minutes after the balance file's, on both observed cycles.

**But it does not advance in step with the balance file, and that is the day's
second finding.** A second run at 12:07 BRT, after the 12h cycle:

| | `Last-Modified` | newest `din_instante` | staleness |
|---|---|---|---|
| `balanco-energia-subsistema` | 2026-08-29 12:00:34 BRT | 2026-08-27 23:00 | 37.1 h |
| `intercambio-nacional` | 2026-08-29 12:04:28 BRT | **2026-08-28 23:00** | 13.1 h |

Both were republished four minutes apart; only interchange gained a day. So the
four bulk datasets are **released together and advanced independently**, and the
seed's "same publication regime as the balance file" rationale is right about the
cadence and wrong about the coverage. `system-context` — the balance file — is the
laggard of the group and is the one the 40 h is tight on. A single dataset's
measurement is not four, which is why the suite probes all six rather than
sampling one.

### restricao-coff — measured lag

The label's own series. 20.12 h at publication, 36.90 h stale when sampled, from
a whole month of `RESTRICAO_COFF_EOLICA_2026_08.csv` (28.5 MB, 99,144
entity-hours) parsed with the platform's own adapter — the same download the
`PAR` case counts reason codes over.

### restricao-coff-detalhe — measured lag

19.64 h at publication, 36.39 h stale. Measured from the **last 64 kB** of the
published CSV rather than the whole of it: the wind `_detail` file is 171 MB as
CSV and the question is about its newest row. The trade is stated in the run's
own output — the tail holds whichever reporting entity the file groups last, so
the instant is that entity's newest half hour and not provably the file's
maximum — and the suite asserts the tail is time-ordered rather than assuming it.

### carga-verificada — measured lag

A different regime entirely: a continuous REST API with a row-level
`din_atualizacao`, 0.52 h from the half hour to its stamp. The 6 h configured is
generous by an order of magnitude, and this is the only lag in the table whose
latency is *observed at the row* rather than inferred from a file.

**The carga API pre-fills the current day with zeros.** Every half hour of the
current civil day comes back with `val_cargaglobal = 0` until it is observed, and
the whole day shares one `din_atualizacao`. Reading the newest *row* would report
a negative lag. The newest **non-zero** row is the published frontier, and the
suite says so explicitly, because a zero here is a placeholder and not a load.

### capacidade-geracao — measured lag

The registry is one file overwritten twice a day and carries no valid time of its
own — its content is "the fleet as ONS records it now" — so the only staleness it
has is the age of the file. 16.88 h against 24 h configured, from a `HEAD`.

---

## The day-ahead programme's publication instant

**The open question this ticket owns, and it is not closed.**

`PROGRAMME_PUBLICATION_HOUR_BRT = 15` (D−1 15:00 BRT) is an inference, not an
observation. `/cargaprogramada` returns no row-level stamp of any kind, so the
programme's publication instant is not in the data; the constant was derived as
an upper bound from DESSEM's file creation time (D−1 17:48Z for target
2026-08-28) plus the 0.03% agreement between DESSEM demand and the programme.

### What was measured, 2026-08-29

| observation | value |
|---|---|
| Programme for **2026-08-30** (D+1) served at **11:53 BRT on D−1** | yes, 48 half-hours, `cod_areacarga=SECO` |
| Programme for **2026-08-31** (D+2) at the same instant | HTTP 200, empty array |
| `cod_areacarga=SE` for a day that exists | HTTP 200, empty array — the silent hazard, unchanged |
| DESSEM `val_demanda` vs programmed load, SE/SECO 2026-08-28 | 48 of 48 half hours matched, mean deviation **0.0358%**, worst 0.0639% |
| ONS `balanco_dessem_geral/detalhe` resource for reference day D | created D−1 **16:45–19:00 BRT** (2026-08-29's file: 2026-08-28T19:45Z) |
| ONS `programacao_diaria` resource for reference day D | created D−1 **20:50–22:20 BRT** (2026-08-29's file: 2026-08-28T23:52Z) |

So the upper bound tightens from the inferred **15:00 BRT** to an observed
**11:53 BRT**, and the horizon is exactly one day: the programme for D exists on
D−1 and the programme for D+1 does not.

### What this settles, and what it does not

- **`gate_late` (D−1 19:00 BRT) is safe.** The programme was there seven hours
  before it, on an observation rather than an inference.
- **`gate_early` (D−1 09:00 BRT) is NOT settled.** 11:53 BRT is after 09:00, so
  this run cannot say whether the programme existed at the early gate. Nothing
  observed here contradicts the current constant, and nothing supports moving it.
- **The only instrument that settles it is a run before 09:00 BRT.** With no
  publication stamp anywhere in the payload, presence at an instant is the whole
  of the evidence, and the question "was it there at 09:00" can only be asked at
  09:00. That is why
  `.github/workflows/publication-lag-conformance.yml` is scheduled at **11:00 UTC
  = 08:00 BRT** and why that hour is a design decision rather than a convenience.
  The case emits `PROVEN` / `not proven by this run` rather than a verdict it did
  not measure.
- **Circumstantial evidence points away from an early publication**, and is worth
  recording so nobody re-derives it: both neighbouring ONS artefacts for the same
  reference day — the DESSEM balance and the per-plant `programacao_diaria` — are
  created on the *evening* of D−1, at 16:45–22:20 BRT. The programme is served
  earlier than either, so it is not downstream of them; but nothing in the ONS
  publication calendar suggests a day-ahead programme completed before 09:00 the
  previous morning.

### Until it is settled, this is the state of the early gate

`programmed_load_mwh` is NULL at `gate_early`, and with it every `proxy_*`
residual-load column (`drizzle/0030_the_proxy_residual_load.sql`). The DESSEM-free
set therefore has **no programme and no residual load at the early gate**: its
early arm is weather, calendar and lagged actuals alone. That is a visible hole
rather than a leak, which is the failure mode the spec asks for — but it is a real
hole, and the A/B's early-gate arm should be read as a different experiment from
its late-gate arm until the 08:00 BRT run reports.

If a scheduled run ever finds the programme present at or before 09:00 BRT, the
suite **fails deliberately**, and the failure is good news: move
`PROGRAMME_PUBLICATION_HOUR_BRT`, re-ingest `carga-energia-programada` so the new
instant is written into `published_at`, rebuild both feature sets and retrain. The
early-gate feature distribution changes from all-NULL to a real column, which is
exactly the kind of change that must not happen quietly.

---

## The four monitoring signals

Measured in the same run.

| signal | state on 2026-08-29 |
|---|---|
| Bulk restatement of closed months | 27 months pinned (2024-04 … 2026-06, the modelling window); **0 restated, 0 withdrawn**. 2026-07 and 2026-08 are excluded and rewritten every cycle by design. |
| First appearance of reason code `PAR` | **0** occurrences across the current month of both technologies (ENE 49,092 / CNF 19,297 / REL 4,327 / PAR 0, 72,716 entity-hours carrying a cause). |
| A VRE unit's `dat_desativacao` becoming non-null in the window | 3,385 VRE units, 3 carrying any deactivation date (the pre-window BELMONTE 1-1 units), **0 inside the modelling window**. |
| DESSEM demand vs programmed load | 0.0358% mean deviation — the research's 0.03%, still. |

The restatement pins are `PINNED_RESTATEMENTS` in the suite. ONS runs bulk
re-publication campaigns that rewrite years of closed history at once
(`docs/research/ons-datasets.md` § "Coverage, cadence and revision behaviour");
the pins are what turns such a campaign from a silent re-ingest into a run that
fails and says which months moved. Re-pin them in the same commit as the note
that says whether the campaign corrected values or changed the definition of the
quantity — those two call for a retrain and a relabelling respectively.

---

## What is still open

1. **Whether the programme is published before D−1 09:00 BRT.** The 08:00 BRT
   scheduled run answers it; see above.
2. **Whether the 40 h configured for `balanco-energia-subsistema` and the two
   curtailment datasets is enough at the moment `gate_late` falls.** The follow-up
   above says it probably is not: for those three, coverage advanced only on the
   ~19:05 BRT cycle, so staleness just before it is ~43.7 h. (`intercambio-
   nacional` advanced at 12:00 BRT and is not in question today, which is itself
   the reason to keep measuring all six rather than one.) This is projected from two measurements taken hours apart on one
   Saturday, not observed at 18:45 BRT, and the 21:45 UTC run of this suite
   observes it directly. **If it confirms, the fix is a migration raising the four
   40 h rows — 46 h is the first round number that covers the peak with margin —
   landed beside a new feature-set version, and a retrain**, because every lag,
   trailing window and capacity factor behind the cutoff moves with it. It is not
   an `UPDATE`, and it is not a change to this suite's threshold.
3. **Whether a *tightened* lag is worth the retrain, if the peak turns out to be
   covered after all.** The lag at publication is ~20 h against 40 h configured,
   and 20 h of extra actuals at `gate_late` would return several dropped features.
   That is a decision to make on a series of these runs — never on one
   measurement. Note that the two open questions pull in opposite directions and
   the same series of runs answers both: what matters is the top of the sawtooth,
   not its bottom.
