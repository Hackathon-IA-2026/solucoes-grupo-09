---
id: "008"
title: Feature engineering spec
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["002", "006", "007", "018", "019"]
---

## Question

Which features does the day-ahead model actually get, and how is each computed
under point-in-time constraints?

IDEA.md §4–§12 proposes: renewable surplus and renewable/load ratio, residual
load, ramp rates, lags (t-1, t-24, t-168), rolling means and standard
deviations, interchange flow and a utilisation proxy, cyclical calendar
encodings, holidays, regional weather, installed capacity and capacity factor.

The real questions:

- **The day-ahead constraint is the whole problem.** At D-1 you do not have
  D's actuals. Which of these features are available from DESSEM, which from
  weather forecast, and which must be replaced by their last-known value or
  dropped entirely? Every feature must be classified this way or the model
  learns on information it will never have.
- Is the interchange utilisation proxy (§9) obtainable at all — is there any
  published limit to divide by, or must it be estimated from historical maxima?
- Which curtailment threshold defines the positive class (§2: >1 / >5 / >10 MW)?
  Decide the default and whether it is configurable.
- Are features computed in SQL, in the Python service, or both? A single
  definition matters more than which side it lives on.
- Holiday calendar source for Brazil, including regional holidays.
- **Weather features carry a lead dimension now.** Training weather comes from
  the Single Runs API at a fixed D−1 lead, not the Historical Forecast archive,
  so every weather feature has a `publication_time` as well as a valid time and
  must be joined as-of that lead. The per-point train↔serve gap is an upper
  bound; recompute it on the real capacity-weighted centroids once the plant
  registry lands, because aggregation will shrink it.
- **The DESSEM A/B changes the shape of this ticket.** Two feature sets must be
  specified, not one: a DESSEM-free set over 2024-04→now and a DESSEM-augmented
  set over 2025-05→now. Say explicitly which features exist only in the second.
- **Timezone.** `din_instante` is Brasília local civil time and ONS documents
  this nowhere. Within the 2024-04→now window there are no DST transitions, but
  the ingestion contract must state the assumption rather than inherit it.
- How installed capacity is joined given it changes over time.

Use `/grilling`. Output: a feature specification document — one row per
feature, with its definition, its D-1 availability, and its source.

## Resolution

Spec: [`docs/specs/feature-engineering.md`](../../docs/specs/feature-engineering.md).

**The whole design is one SQL function called twice.** `gate_at(target_date,
gate_profile)` makes the D−1 cut-off a function of the *target date* rather than
of the caller, and every as-of join, lag offset and window frame inside
`feature_rows(...)` resolves against it. Training passes a date range, serving
passes tomorrow — the same expression over the same tables. Train/serve skew
stops being something to avoid and becomes something that cannot be expressed.

**Two gates, not one — and this is a second cost of DESSEM the map had not
recorded.** `gate_early` = D−1 09:00 BRT on the 00Z weather run; `gate_late` =
D−1 19:00 BRT on the 12Z run plus DESSEM. The DESSEM file for day D is created
the *evening* of D−1, so the augmented model can only ever run at the late gate.
DESSEM buys accuracy with **eleven hours of operator notice**, on top of the
shorter window already known.

**The cut falls on different axes for different table families, and conflating
them is the subtlest leak available.** `AsOf(gate)` filters `ingested_at`, which
in the backfill window (one shared `ingested_at`) filters nothing. Forecast
tables are still safe — a weather row's `published_at` *is* the run
initialisation — so forecast-sourced features are genuinely point-in-time even in
backfill. Observation tables are not: their `published_at` is an S3
`Last-Modified` that may be two years later. Observations are therefore cut on
`valid_time ≤ actuals_cutoff(gate, dataset)`, from a per-dataset
`publication_lag_hours` constant with deliberately conservative defaults (40 h
for the bulk files). **Consequence: at `gate_late`, no hour of D−1 is assumed
available; the nearest usable same-hour actual is t−48 h.**

**The rule that decides "last-known value" from "dropped": LKV is honest for a
level and dishonest for a local difference.** `load_mwh[t−168]` is a real
observation of a real hour. `solar_ramp_1h ← last observed ramp` is one number
broadcast across 24 hours that a tree will read as intraday shape. So every ramp,
every centred rolling window and every t−1…t−24 lag on *actuals* is dropped —
and each is replaced by its **forecast-side** equivalent, where the whole day-D
profile genuinely exists at the gate.

**Six availability classes, not the ticket's four.** `D` DESSEM · `W` weather ·
**`P` ONS day-ahead programming** · `K` last-known value · **`T` deterministic**
(calendar, astronomy, registry as-of) · `✗` dropped. The two additions are
load-bearing and are labelled as extensions rather than smuggled in. One row per
feature, with definition, class and source, is in the spec's feature table.

**`carga-energia-programada` is the find that changes the A/B.** The ticket
framed the DESSEM-free set as surviving on weather and lags alone. It does not:
ONS has published a day-ahead load programme since **2021-03-05** — the entire
window — and it agrees with DESSEM demand to 0.03%. That makes
`proxy_residual_load_mwh = programmed_load − expected_wind − expected_solar`
available over 880 days, so IDEA.md §5 (the best feature in the domain) survives
D−1 in *both* sets. It is also the one input whose publication timing the
research never established — the single largest risk in the spec.

**Answers to the specific questions:**

- **Interchange utilisation** — *no published limit exists*. The 84-package ONS
  catalogue contains no transfer-limit dataset at any grain; Sintegre was not
  investigated and is left as an open question. So it is estimated:
  `export_capability_estimate = P99.5 of directed flow over the trailing 365 days
  ending at actuals_cutoff(gate)` — a high quantile rather than a maximum (one
  outlier would otherwise define a year of denominators), trailing and
  gate-bounded so the *denominator* cannot leak the future, NULL below 300
  sample hours. The proxy works *because* of the tautology that a binding
  corridor's flow is its limit, which also means it is meaningful only for
  corridors that bind (NE→SE, N→NE). It cannot see a temporary derate — which is
  exactly what `REL` names.
- **Threshold** — 5 MW at subsystem grain per the domain model, passed as an
  *argument* to the feature function and stamped on every artifact, so the
  >1/>5/>10 sweep costs a parameter rather than a rebuild. `y_has_curtailment` is
  derived inside the function and never stored.
- **SQL or Python** — **SQL**, in the API's migration tree. Not on ergonomics
  (pandas wins there) but because the as-of read is already SQL and expensively
  tested; because the leak lives in a one-token window-frame difference that
  should exist in exactly one place; and because the API-owns-schema boundary is
  already settled. Python may do anything row-local and model-internal: **no
  window, no join, no time offset.**
- **Holidays** — the `holidays` package (MIT), `Brazil`, all 27 UF subdivisions,
  `categories=(PUBLIC, OPTIONAL)` so Carnival and Corpus Christi are in.
  **Materialised into a `calendar_day` table with the generator version pinned**,
  because a library upgrade that moves one feast would otherwise silently restate
  three years of training features with no diff and no test failure. National vs
  regional separated; the regional share is unweighted and *labelled* as crude —
  load is not published per state and no honest weight exists in our sources.
- **Installed capacity** — `InstalledCapacityAsOf(scope, tech, t)` as a
  **double as-of**: valid-time at the target date D, vintage at the gate. Without
  the first, today's fleet leaks into 2024 (25.8% of curtailed-fleet MW did not
  exist at window start); without the second, a unit ONS records after the gate
  enters a feature. Day-grain, broadcast across the 24 hours and marked as such.
  Pre-go-live it is `revision_optimistic`. Decommissioning is asserted, not
  modelled (zero VRE deactivations in the window).
- **The two sets** — `dessem_free_v1` (2024-04-01→now, ~84,500 rows, both
  gates) and `dessem_augmented_v1` (2025-05-23→now, ~44,200 rows, `gate_late`
  only). The 21 `dessem_*` columns are the only features unique to the second,
  and four of them carry the case: `dessem_residual_load_mwh`,
  `dessem_implied_net_export_mwh` (derived by energy identity — DESSEM publishes
  no exchange column), `dessem_export_utilisation` and
  `dessem_absorber_residual_load_mwh`. **The A/B needs three trainings, not two**
  — A-full, A-common, B-common — or window length is confounded with feature
  content.
- **Labels** — read `AsOf(now)` while features are read `AsOf(gate)`. The
  asymmetry is deliberate and is the one place point-in-time is broken on
  purpose: a model should predict reality, not ONS's first draft. Caveats
  recorded, including the methodology-break hazard.
- **Timezone** — the contract states rather than inherits: `din_instante` parsed
  as `America/Sao_Paulo` with the full IANA zone, `din_referenciautc` as UTC, no
  DST handling built but a **canary** asserting exactly 24 distinct local hours
  per target date, so a change in Brazilian law fails a test instead of
  duplicating an hour.

**Both decisions the data-platform spec deferred are settled.** Weather variable
list: **twelve**, pinned to `models=ecmwf_ifs` — `wind_speed_100m/120m`,
`wind_direction_120m`, `wind_gusts_10m`, `temperature_2m`, `surface_pressure`,
`relative_humidity_2m`, `precipitation`, `shortwave_radiation`,
`direct_normal_irradiance`, `diffuse_radiation`, `cloud_cover`. Each exclusion
has a stated reason; `boundary_layer_height` and `temperature_120m` are *not
requested at all* because they are null under the pinned model, so no run can
write a NULL column. Centroid set: the research's **20 points, generated from
SIGA by script rather than transcribed** (W11/W12 were never computed and are
regenerated), **frozen per feature-set version while weights vary with time**,
with grid-cell collision as a build error and a 25% capacity-weighted-distance
drift trigger that produces a `centroid_set_v2` and a retrain rather than an
in-place edit.

**The load-bearing artifact is a test, not the table.** *Gate ablation*: compute
a feature row; delete every source row with `published_at > gate` or
`valid_time > actuals_cutoff(gate)`; recompute; assert nothing changed. It is a
property, not a checklist, so it catches a leak nobody anticipated — including
one a future session adds because pandas made it easy. Paired with a train/serve
identity test, it is the acceptance gate for the whole spec.

**Where this is weakest, ranked:** (1) the `publication_lag_hours` defaults are
conservative guesses — if ONS's 12h publication does carry D−1's morning, several
dropped features return; measure early. (2) `calendar_holiday_state_share` is
unweighted. (3) **`cmo-semi-horario` has history to 2020 and curtailment is the
zero/negative-price regime** — if the published CMO is the D−1 DESSEM run's own
output rather than a settled restatement, it is a DESSEM-like signal reaching
back six years and the A/B should be restructured. Out of scope here, flagged
loudly.
