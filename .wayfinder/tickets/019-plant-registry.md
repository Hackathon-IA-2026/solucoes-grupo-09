---
id: "019"
title: Plant registry — ANEEL SIGA as the coordinate and capacity source
type: wayfinder:research
status: closed
assignee: research-agent
blocked_by: ["001"]
---

## Question

Surfaced by **Weather source and regional aggregation**: ONS publishes no plant
registry carrying coordinates, but WattSteer needs one twice over — per-plant
observed curtailment is in scope, and capacity-weighted weather aggregation
needs plant locations and commissioning dates. The prior research identified
ANEEL SIGA as the answer (public, ODbL, 100% coordinate coverage for operating
wind and solar, with commissioning dates) and proposed joining SIGA `CodCEG` to
ONS `ceg`.

This ticket confirms that SIGA becomes an ingested source, and establishes what
ingesting it involves. Wait for **ONS dataset inventory** first — it may show
ONS carries enough plant metadata to make SIGA unnecessary, or may change the
join key.

Establish:

- SIGA's access method: bulk download, API, or scrape; update cadence; whether
  it is versioned or a live snapshot
- exact join reliability against ONS `ceg` — measured match rate on real data,
  not assumed. What fraction of ONS constrained-off plant rows find a SIGA row,
  and what the unmatched ones have in common
- whether SIGA is a current-state snapshot or carries history. If it is a
  snapshot, time-varying capacity weights must be reconstructed from
  commissioning dates, and **decommissioning is invisible** — quantify that
  error before relying on it
- what happens to a plant that is renamed, resold, or re-registered
- whether SIGA covers the plant types that actually get curtailed, and whether
  the same registry serves hydro and thermal if later needed
- the ODbL share-alike obligation and what it requires of a product that
  publishes derived figures

Record findings in `docs/research/` and link them from this ticket.

## Resolution

**SIGA is ingested — but only for coordinates, and the proposed join key does not work.**
Findings: [`docs/research/plant-registry.md`](../../docs/research/plant-registry.md).

- **Measured match rate.** `SIGA.CodCEG == ONS.ceg` **verbatim matches 0 of 1,614 plants
  (0.00%)** — ANEEL writes the CEG version segment unpadded (`.1`), ONS zero-pads it (`.01`).
  It fails silently. Joining on the **version-stripped core** `GGG.FF.UF.NNNNNN-D` gives
  **1,614/1,614 = 100.00%** (and 100.00% by curtailed MWh), over every per-plant
  constrained-off row in 2024-04 → 2026-08. Merely de-padding the version is *not* enough
  (98.95%): ANEEL bumps the version on re-registration and ONS does not follow.
- **The unmatched.** Against the full `usina_conjunto` bridge the rate is 99.72%; the 4 misses
  are Cerro Chato IV/V/VI and Cerro dos Trindade (RS, 54 MW), whose CEG nuclei are absent from
  SIGA entirely while ONS still lists them active — plus one plant whose `ceg` is NULL in ONS's
  own bridge. All 5 are among the 31 bridge members that never appear in a `_detail` file, so
  **zero observed rows are affected**.
- **ONS does not make SIGA unnecessary, but it inverts the roles.** ONS has no coordinates
  anywhere in its 84-package catalogue. But `capacidade-geracao` covers 1,614/1,614 of the same
  plants with *better* capacity history — per-**unit** commissioning dates, a `dat_desativacao`
  column, subsystem, modality. **ONS owns capacity and dates; SIGA contributes lat/lon,
  municipality and ownership only.** This amends the weather ticket's proposal.
- **SIGA is a current-state snapshot** — one row per CEG, no valid-from/to, no historical
  resource, and retirements are represented by **deleting the row** (verified on a 3-day diff:
  8 deletions, 2 additions, no tombstones; and 78 of 84 ONS-retired plants absent from SIGA,
  6 still shown `Operação` with 343 MW).
- **The two snapshot errors, quantified.** Fixed 2026-08 weights misallocate **50.4%** of the
  SE-solar weight mass at window start (NE solar 39.3%, NE wind 13.5%) and move the SE-solar
  capacity centroid **94 km** — 25.8% of today's curtailed-fleet MW post-dates 2024-04.
  **Time-varying weights are mandatory, now settled by measurement.** Against that,
  **decommissioning invisibility is empirically zero**: 3 of 3,380 ONS VRE units carry a
  `dat_desativacao` at all and **none since 2024-04**. Wire an assertion, do not build a model.
  SIGA's first-unit-only `DatEntradaOperacao` costs at most **0.38%** of fleet MW and is
  removed for free by ONS per-unit dates.
- **Rename / resale / re-registration.** The CEG *nucleus* is stable. Renames are folded into
  `NomEmpreendimento` as unmarked `(Antiga …)` aliases (242 rows) — never join or display on
  name. Re-registration bumps the version segment. Resale shows only as a value change in
  `DscPropriRegimePariticipacao`, detectable only by diffing your own snapshots.
- **Coverage.** Wind 99.62%, solar 100%, hydro 100% — but **thermal only 68.03%**, so the same
  registry would serve a later hydro extension and would **not** serve thermal.
  "100% coordinate coverage" is misleading: 316 operating EOL/UFV rows sit at exactly `(0,0)`.
- **ODbL corrects a map assumption.** §3.1 grants commercial use explicitly — **there is no
  commercial cliff on SIGA**, unlike Open-Meteo. What ODbL requires applies from day one: the
  plant table is a Derivative Database, and §4.4(c) pulls it under share-alike because public
  charts built from it are Publicly Used Produced Works. Obligations: a bilingual §4.3 notice on
  every public surface, an ODbL declaration for the registry, and §4.6 machine-readable access —
  satisfiable by publishing the ingestion transform rather than a data dump.

