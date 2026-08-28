---
id: "001"
title: ONS dataset inventory — what exists, in what shape
type: wayfinder:research
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Exactly which ONS Dados Abertos datasets does WattSteer ingest, and what is
each one's real shape?

For every dataset needed by the decided data scope — constrained-off (solar and
wind, **subsystem grain and per-plant grain**), balanço de energia nos
subsistemas, carga de energia (verificada and programada), intercâmbio entre
subsistemas, and DESSEM — establish:

- canonical dataset URL and resource URLs on dados.ons.org.br
- available formats (CSV / Parquet / XLSX) and which is cleanest to ingest
- exact column names, units (MW vs MWmed vs MWh) and time zone
- temporal grain (hourly / semi-horária / daily) and whether grains differ
  between datasets that must be joined
- coverage: does each go back to 2023, and are there schema changes mid-history
- update cadence, and how revisions are published — critical for the bitemporal
  decision, since we need to know whether a revision is detectable
- whether a CKAN API allows incremental fetch, or whether ingestion is
  whole-file download and diff
- the constrained-off **reason codes** (ENE / CNF / REL) — are they published,
  at which grain, and with what exact values
- whether installed capacity per subsystem/plant over time is available (needed
  for §12 capacity normalisation and for weather weighting)

Record findings as a Markdown file in the repo and link it from this ticket.
Prefer primary sources: dados.ons.org.br dataset pages, the resource dictionaries,
and ONS's own documentation.

## Resolution

Full inventory: [`docs/research/ons-datasets.md`](../../docs/research/ons-datasets.md) — 15
datasets, every schema fact taken from the CKAN API, ONS `DicionarioDados_*` JSON/PDF dictionaries,
S3 `HEAD` responses, or a header read of the published file, each cited inline.

Headlines that change the build:

- **Constrained-off is two datasets per technology, and they do not join cleanly.** The `*_usi` /
  entity files carry the reason codes but are per *reporting entity* — a **conjunto** for Tipo II-C
  plants (93% of wind rows). The genuinely per-plant `*_detail` files carry no reason code at all.
  Per-plant reason attribution is an **allocation, not an observation**, and must be modelled as such.
- **Reason codes:** `cod_razaorestricao` ∈ `REL` / `CNF` / `ENE` / **`PAR`** — four, not three, and
  `REL` is *indisponibilidade externa (elétrica)*, not "relaxamento". `cod_origemrestricao` ∈
  `LOC` / `SIS`. Grain: 30 min × entity only.
- **Coverage falls short of 2023 in places.** Wind constrained-off starts 2021-10, but **solar only
  2024-04** and **DESSEM balanço only 2025-05-23**. Balanço/carga/intercâmbio go back to 2000.
- **Revisions are detectable but not describable.** ONS rewrites historical months in place under
  the same filename with no version marker — the whole of 2025 was rewritten in 2026. Detection is
  S3 `Last-Modified`/`ETag` only; WattSteer must be the sole custodian of its own vintages. This is
  the strongest evidence yet for the bitemporal decision.
- **Carga verificada/programada are a REST API, not files** (`apicarga.ons.org.br`), and verificada
  returns a per-row `din_atualizacao` — the one real ONS-side vintage marker anywhere in the stack.
- **Subsystem codes are not one vocabulary.** `SE`/`S`/`NE`/`N` everywhere except the carga API,
  which uses **`SECO`** and returns `[]` with HTTP 200 for `SE`. Normalise on ingest.
- **Installed capacity exists** (`capacidade-geracao`, per unidade geradora with
  `dat_entradaoperacao`) but is a **snapshot overwritten daily** — a capacity *time series* has to
  be reconstructed from entry dates or accumulated by WattSteer from day one.
- Units are **MWmed** on all constrained-off `val_*`; CSV is `;`-delimited UTF-8, Parquet is ~10×
  smaller and is the ingest format of choice.
- **Timezone is documented nowhere by ONS** (confirmed absent across all 12 JSON dictionaries, 11
  PDFs, CKAN metadata and the OpenAPI spec), and the empirical answer is not simply UTC−3:
  `din_instante` is Brasília *local civil time* — **DST-aware before 2019-02-17**, fixed UTC−3 after.
  Pre-2019 DST transitions are handled lossily and inconsistently per dataset (one hour per year is
  unrecoverable). Our 2023→now scope is unaffected; any pre-2019 backfill is not.

Ten further unresolved items are listed in the file's *Open questions / could not confirm* section.
