# ANEEL SIGA as WattSteer's plant registry

Primary-source survey of the ANEEL **SIGA** registry, and a *measured* join against real ONS
constrained-off data. Every number below was computed on this machine from files fetched on
**2026-08-28**; every schema fact is cited to the ANEEL CKAN API, the ANEEL PDF data dictionary,
the ONS CKAN API, or the Open Data Commons licence text. Where a fact could not be established it
appears in [Open questions](#open-questions--could-not-confirm) rather than being guessed.

Measurement corpus: all **116** ONS constrained-off Parquet files covering the training window
**2024-04 → 2026-08** (wind + solar × entity-grain + `_detail`), the two SIGA CSVs, and the ONS
`capacidade-geracao`, `usina_conjunto` and `modalidade-usina` registries.

Three findings dominate and are worth reading before anything else.

1. **The join key the prior research proposed does not work.** `CodCEG` and ONS `ceg` differ in the
   version segment's zero-padding — SIGA writes `.1`, ONS writes `.01`. A verbatim equality join
   matches **0 of 1,614** plants. It fails *silently*: an inner join returns an empty frame, a left
   join returns all-NULL coordinates. Strip the version segment and the match rate is
   **1,614/1,614 = 100.00%**.
2. **SIGA is needed only for coordinates.** ONS's own `capacidade-geracao` covers 1,614/1,614 of the
   same plants and carries *better* capacity history than SIGA does — per-unit commissioning dates,
   a deactivation date, and no `Construção`-lag. The registry should be ONS-primary, SIGA-for-lat/lon.
3. **The fleet-composition leakage the weather research feared is real and large; the
   decommissioning error it feared is empirically zero.** 25.8% of today's curtailed-fleet MW was
   commissioned *after* the training window opens; fixed 2026-08 weights misplace **50.4%** of the
   SE solar weight mass at window start and move the SE solar capacity centroid **94 km**. Against
   that, ONS records **zero** wind or solar unit deactivations in the entire window — 3 of 3,380 VRE
   units carry a `dat_desativacao` at all, and that one predates the window.

---

## 1. What SIGA is, and how you get it

**Dataset:** [SIGA — Sistema de Informações de Geração da ANEEL](https://dadosabertos.aneel.gov.br/dataset/siga-sistema-de-informacoes-de-geracao-da-aneel)
(CKAN id `6d90b77c-c5f5-4d81-bdec-7bc619494bb9`). Facts below from
`package_show?id=siga-sistema-de-informacoes-de-geracao-da-aneel`:

| Field | Value |
|---|---|
| `license_id` / `license_title` | `odc-odbl` / Open Data Commons Open Database License (ODbL) |
| `metadata_created` | 2026-05-27 |
| `metadata_modified` | 2026-08-28T10:42:24 |
| author / maintainer | SCE/ANEEL · CEGDI/ANEEL (`dadosabertos@aneel.gov.br`) |
| extra "Frequência de atualização" | **"Mensal e diária"** |
| `num_resources` | 5 |

### There are two data files, not one, and the prior research cited the stale one

| Resource | `last_modified` | `DatGeracaoConjuntoDados` | rows |
|---|---|---|---|
| `siga-empreendimentos-geracao.csv` (monthly) | 2026-08-25T16:26:09 | 2026-08-25 | 25,133 |
| **`siga-empreendimentos-geracao-diario.csv`** (daily) | **2026-08-28T10:42:02** | **2026-08-28** | 25,127 |

Both carry an **identical 23-column header**; the daily file (resource id
`2f65a1b0-19b8-4360-8238-b34ab4693d55`, added 2024-12-17) is simply a fresher cut of the same
extract. [`docs/research/weather-sources.md`](weather-sources.md) cites only the monthly resource.
**Ingest the daily one.** XML mirrors of both exist at ~4× the size and buy nothing.

Diffing the two (3 days apart) is the cleanest evidence of how SIGA changes: **8 CodCEG present in
the monthly cut are gone from the daily one, 2 are new, and 1 record changed
`NomEmpreendimento`.** Rows are *deleted*, not tombstoned — see [§5](#5-snapshot-not-history).

### Access methods, measured

- **Bulk HTTP.** `GET .../download/siga-empreendimentos-geracao-diario.csv`, 8.4 MB, `;`-delimited,
  UTF-8, every field double-quoted, **decimal comma**, dates `YYYY-MM-DD`.
- **Conditional fetch works.** `HEAD` on the CSV returns `Last-Modified`, a strong `ETag`
  (`"1787675169.2103474-8448855-2068648745"`) and `Accept-Ranges: bytes`. Unlike ONS's S3 bucket
  the ETag is not multipart-suffixed, so `(ETag, Content-Length, Last-Modified)` is a clean change
  key. Note `Cache-Control: no-cache, must-revalidate` and `Vary: Cookie`.
- **CKAN Datastore API works and is genuinely useful.** Both CSV resources have
  `datastore_active: true`. `datastore_search?resource_id=11ec447d-…&limit=40000` returned **all
  25,133 records in a single call** (855 KB, `total: 25133`), and server-side filters work:
  `filters={"SigTipoGeracao":"EOL","DscFaseUsina":"Operação"}` → `total: 1137`. So you can pull just
  the wind/solar operating fleet without downloading the file.
- **`datastore_search_sql` is disabled** — returns `"Requisição incorreta - Action name not known:
  datastore_search_sql"`. Filter/paginate via `datastore_search`; do not plan on SQL.

**Cadence in practice.** ANEEL says "Mensal e diária" and the observed `last_modified` timestamps
(monthly 2026-08-25, daily 2026-08-28) bear that out. A daily `package_show` plus a conditional
`GET` is the whole ingestion contract.

### Schema (23 columns), per the ANEEL data dictionary

Source: [`dm-siga-sistema-de-informacoes-de-geracao-da-aneel.pdf`](https://dadosabertos.aneel.gov.br/dataset/6d90b77c-c5f5-4d81-bdec-7bc619494bb9/resource/25722a60-194d-4234-ab3b-b71354078402/download/dm-siga-sistema-de-informacoes-de-geracao-da-aneel.pdf),
dictionary version **1.2, dated 2023-03-30** (i.e. the dictionary is three years stale relative to
the data; it still says frequency "Mensal" only, and describes only the monthly file).

```
DatGeracaoConjuntoDados        extract timestamp
NomEmpreendimento              plant name
IdeNucleoCEG                   6-char CEG nucleus
CodCEG                         GGG.FF.UF.999999-D.VV        <- see below
SigUFPrincipal                 principal UF ("principal" is load-bearing)
SigTipoGeracao                 UTN|UTE|UHE|UFV|PCH|EOL|CGU|CGH
DscFaseUsina                   phase
DscOrigemCombustivel / DscFonteCombustivel / NomFonteCombustivel
DscTipoOutorga                 Registro | Autorização | Concessão
DatEntradaOperacao             "entrada em operação da PRIMEIRA unidade geradora"
MdaPotenciaOutorgadaKw         granted capacity
MdaPotenciaFiscalizadaKw       "potência que está em operação; caso não esteja mais,
                                é a última potência considerada em operação"
MdaGarantiaFisicaKw
IdcGeracaoQualificada
NumCoordNEmpreendimento        latitude, decimal degrees, "centróide de localização"
NumCoordEEmpreendimento        longitude
DatInicioVigencia / DatFimVigencia    outorga validity, NOT operational life
DscPropriRegimePariticipacao   ownership %, agent name, CNPJ, regime
DscSubBacia                    hydro only
DscMuninicpios                 "Município - UF" list
```

Two dictionary sentences do the heavy lifting later: `DatEntradaOperacao` is the **first unit only**
(§6), and `MdaPotenciaFiscalizadaKw` **retains the last operating value after a plant stops**, so a
zero never appears to mark a retirement (§5).

### Population

```
DscFaseUsina:  Operação 22,802 · Construção não iniciada 2,170 · Construção 161
SigTipoGeracao: UFV 18,982 · UTE 3,103 · EOL 1,569 · CGH 718 · PCH 537 · UHE 221 · UTN 3
```

**There is no revoked/decommissioned phase in the file** even though the CKAN `notes` claim coverage
"desde etapas anteriores à outorgas **até a revogação**". Only three phase values exist. Whatever
"revogação" means for this dataset, it is not a value you can observe.

**The operating-UFV count is a trap.** SIGA lists 17,260 operating UFV, which
[`weather-sources.md`](weather-sources.md) reports as the coordinate-coverage denominator. Their
**median capacity is 1 kW**; only **584** are ≥ 5 MW. SIGA's UFV population is overwhelmingly tiny
`Registro`-type installations, not the utility-scale fleet ONS dispatches. Operating EOL is 1,137,
which *is* the real fleet. Any capacity aggregation over SIGA UFV without a size or phase filter is
counting rooftops.

---

## 2. The join: measured, not assumed

**Population.** Every distinct plant appearing in the ONS per-plant `_detail` constrained-off
datasets over 2024-04 → 2026-08: **1,614 plants** (1,054 wind, 560 solar), from 58 monthly files.
`id_ons` ↔ `ceg` is 1:1 in this window (0 `id_ons` with two `ceg`, 0 `ceg` with two `id_ons`); 18
plants changed `nom_usina`. `ceg` is populated on **every** `_detail` row — the `"-"` problem is
confined to the entity-grain files.

### Match rates

| # | Key | Matched | Rate |
|---|---|---|---|
| **A** | `SIGA.CodCEG == ONS.ceg` **verbatim** | 0 / 1,614 | **0.00%** |
| B | de-padded version (`.01` → `.1`) | 1,597 / 1,614 | 98.95% |
| **C** | **version-stripped core** `GGG.FF.UF.NNNNNN-D` | **1,614 / 1,614** | **100.00%** |
| D | `IdeNucleoCEG` alone (6 digits) | 1,614 / 1,614 | 100.00% |
| E | key C, restricted to SIGA `DscFaseUsina = Operação` | 1,601 / 1,614 | 99.19% |

Weighting by curtailed energy changes nothing: C and D are 100.00% by MWh as well, E is 99.99%.

**Why A is zero.** The dictionary defines `CodCEG` as `GGG.FF.UF.999999-D.VV` where `VV` is the
version. ANEEL writes it **unpadded** (`1`, `2`, `3`, `4` — measured over all 25,133 rows); ONS
writes it **zero-padded to two digits** (`00`, `01`, `02`, `03`). Same semantics, different
rendering, zero overlap. Nothing in either data dictionary mentions the discrepancy.

**Why B is not good enough — and what it reveals about re-registration.** Cross-tabulating the two
version segments over the 1,614 matched plants:

| ONS `VV` | SIGA `VV` = 1 | = 2 | = 3 |
|---|---|---|---|
| `00` | **9** | 0 | 0 |
| `01` | 1,570 | **8** | 0 |
| `02` | 0 | 22 | 0 |
| `03` | 0 | 0 | 5 |

17 plants (1.05%) disagree. Nine — the Mauriti 1–9 solar plants in CE — carry ONS version `00`,
which SIGA never emits. Eight (Lins 01–02 CE, Panorama 01–03 PI, Ventos de Santa Luzia 11–13 RN) sit
at SIGA version 2 while ONS still says 1: **ANEEL bumped the CEG version and ONS did not re-emit.**
That is precisely the re-registration case the ticket asks about, and it is why the version segment
must be discarded rather than normalised.

**Key D is unambiguous.** Zero `IdeNucleoCEG` values in SIGA map to more than one `CodCEG`, and zero
version-stripped cores do either. Either C or D is safe; C is preferable because it keeps the
type/fuel/UF prefix as a validation check (technology agreement across the 1,614 matches is perfect:
1,054 ONS wind ↔ SIGA `EOL`, 560 ONS solar ↔ SIGA `UFV`, no crossovers).

> **Ingestion rule.** Derive `ceg_core = split(ceg,'.')[0..3]` on both sides at ingest, store it as
> the join column, and keep the raw strings for provenance. Never compare `ceg` to `CodCEG`
> directly. Assert `ceg_core` uniqueness on the SIGA side (it holds today: 3 duplicate `CodCEG` rows
> exist — Rio Timbó PCH, Agro Trafo PCH, Monte Alto UHE — but they are byte-identical duplicate rows
> and all three are hydro, outside WattSteer's scope).

### The entity grain and the conjunto bridge

The entity-grain constrained-off files yield **297 reporting entities** over the window:

| tech | conjuntos (`CJU_*`) | individual plants |
|---|---|---|
| wind | 164 | 14 |
| solar | 83 | 4 |

Conjuntos account for **98.6%** of all `val_geracaolimitada` energy, confirming the ONS-inventory
finding at window scale. Results:

- The 18 individually-reporting plants carry a real `ceg`: **100%** match on key C, **0%** verbatim.
- All **247** conjuntos resolve in `usina_conjunto` — no orphans. That bridge yields **1,789**
  membership rows / 1,630 distinct plants.
- Bridge members → SIGA on key C: **1,784 / 1,789 = 99.72%**; verbatim 0.00%.

**The 5 failures, characterised.** Four are `EOL.CV.RS.030784-0` / `030786-6` / `030756-4` /
`030762-9` — **Cerro Chato IV, V, VI and Cerro dos Trindade**, four Tipo II-C wind plants in Rio
Grande do Sul totalling 54 MW, all members of `CJU_RSCCH`. Their CEG **nuclei are absent from SIGA
entirely** — this is not a version mismatch; searching `IdeNucleoCEG` returns nothing. ONS
nevertheless considers them live: `modalidade-usina` gives them `sts_aneel = A`, and
`capacidade-geracao` lists their units with no `dat_desativacao`. Cerro Chato **I, II and III** *are*
in SIGA (as "Cerro Chato I (Antiga Coxilha Negra V)" etc.), so the gap is specific, not a whole-site
omission. The fifth is `SPUD42` "Dracena 4 2", whose `ceg` is **NULL in ONS's own bridge table** —
an ONS data gap, not a SIGA one.

**None of the five affects a single observed row.** All five are among the 31 bridge members that
never appear in any `_detail` file in the window. The match rate against *observed per-plant
constrained-off data* is 100.00%, and the 99.72% figure is a registry-closure statistic only.

### What the whole ONS fleet looks like through SIGA

Joining every plant in ONS `capacidade-geracao` (all technologies) on key C:

| ONS `nom_tipousina` | plants | in SIGA | rate |
|---|---|---|---|
| EOLIELÉTRICA | 1,058 | 1,054 | **99.62%** |
| FOTOVOLTAICA | 560 | 560 | **100.00%** |
| HIDROELÉTRICA | 180 | 180 | 100.00% |
| NUCLEAR | 2 | 2 | 100.00% |
| **TÉRMICA** | 244 | 166 | **68.03%** |

So: **SIGA fully covers the plant types that get curtailed, and would serve hydro unchanged, but it
is not a usable registry for thermal.** The 78 missing thermal plants are dominated by
`UTE.PE.*` (petróleo) emergency units and biomass plants that ONS still lists but ANEEL has dropped
— e.g. Presidente Médici (446 MW), Fortaleza (327 MW), Jaguarari (205 MW), Rio Largo Brasymbe
(177 MW). Against ONS `modalidade-usina` (which includes Tipo III) overall coverage is 77.30%, worst
for Tipo II-A at 49.02%.

---

## 3. Does ONS make SIGA unnecessary? — No, but it inverts the roles

This was an explicit precondition of the ticket. Attribute by attribute, over the 1,614 curtailed
plants (all 1,614 are present in ONS `capacidade-geracao`):

| Attribute | ONS | SIGA | Winner |
|---|---|---|---|
| **coordinates** | **none anywhere in the 84-package catalogue** (only `subestacao` has geometry) | lat/lon on every row | **SIGA — the sole reason to ingest it** |
| municipality | absent | `DscMuninicpios`, 100% populated | SIGA |
| installed capacity | `capacidade-geracao`, per **generating unit** | plant total, one number | ONS |
| commissioning date | per **unit** (`dat_entradaoperacao`) | plant, **first unit only** | ONS |
| decommissioning | `dat_desativacao` column exists | **no field at all** | ONS |
| subsystem | `id_subsistema` on every row | absent | ONS |
| state | `id_estado`, electrical assignment | `SigUFPrincipal`, "principal" only | ONS |
| operation modality (Tipo I / II-B / II-C) | `modalidade-usina`, `_detail` files | absent | ONS |
| conjunto membership, time-resolved | `usina_conjunto` (SCD2) | absent | ONS |
| owner | `nom_agenteproprietario` | `DscPropriRegimePariticipacao` with % and CNPJ | SIGA (richer) |

**Recommendation: ONS `capacidade-geracao` is the capacity-and-dates spine; SIGA contributes
`(lat, lon, municipality, ownership)` and nothing else.** This differs from
[`weather-sources.md`](weather-sources.md), which proposed SIGA as the source of capacity weights
*and* commissioning dates. Cross-checking the two on the 1,614 curtailed plants shows why ONS wins
on the numbers as well as the schema:

- SIGA plant MW vs ONS summed unit MW agrees within 5% for **1,592/1,614**; fleet totals 55,276 MW
  (SIGA) vs 55,918 MW (ONS), **−1.15%**.
- SIGA `DatEntradaOperacao` equals the ONS first-unit date **exactly** for 1,551/1,614 (96.1%) and
  within 7 days for 1,581 (98.0%); 19 differ by more than 90 days.

Two further ONS-side advantages are decisive for a *time-varying* weight:

- **SIGA lags on new entrants.** Twelve plants (Seriemas 1–8, Fótons de São George 2/4, Fótons de São
  Paulino 1/2 — all MS solar, SE subsystem) have been reporting to ONS `_detail` since
  **2026-08-22** but SIGA still shows them as `Construção`, `MdaPotenciaFiscalizadaKw = 0`, and
  `DatEntradaOperacao = 1900-01-03` (a sentinel — 10 operating SIGA rows carry it). Weighted by
  SIGA capacity they would carry **zero weight while actively being curtailed**. This is the entire
  gap between match rates C (100.00%) and E (99.19%).
- **SIGA's UF is "principal".** Five of the 1,614 disagree with ONS's state (Ventos de Santo Antero,
  Ventos de São Bernardo, Ventos de São Zacarias 09/10: ONS PI / SIGA PE; Ventos de São Rafael 11:
  ONS RN / SIGA PB). Consistent with the existing rule: never derive subsystem from state.

### Coordinate quality — "100% coverage" is true but misleading

`weather-sources.md` reports 100% coordinate coverage for operating EOL and UFV. Literally correct:
zero NULLs. But **316 of 18,397 operating EOL+UFV rows (1.72%) sit at exactly (0.0, 0.0)** — Null
Island in the Gulf of Guinea, which no bounds check on latitude alone would catch. By capacity that
is 294.9 MW of 57,819 MW = **0.51%**, and only six of them are ≥ 5 MW:

| CodCEG | name | MW | municipality |
|---|---|---|---|
| `EOL.CV.CE.028770-9.1` | Enacel | 31.5 | Aracati - CE |
| `UFV.RS.MG.049441-0.1` | Draco Solar 6 | 48.1 | Arinos - MG |
| `UFV.RS.MG.050789-0.1` | Jusante 6 | 10.0 | São Gonçalo do Abaeté - MG |
| `UFV.RS.CE.075429-3.1` | Cimento Apodi | 5.0 | Fortaleza - CE |
| `UFV.RS.BA.076048-0.1` | Malhada I | 5.0 | Malhada - BA |
| `UFV.RS.RN.076434-5.1` | CAIN | 5.0 | São Gonçalo do Amarante - RN |

Three of them (Enacel, Draco Solar 6, Jusante 6) are in the curtailed 1,614. `DscMuninicpios` is
populated on **all 316**, so the fallback is a municipality centroid — and Arinos MG and São Gonçalo
do Abaeté MG are inside the S6 Paracatu/Arinos cluster, so the fix matters. **Validate coordinates
against a Brazil bounding box (lat −34…+6, lon −74…−33) and reject exact zeros; do not trust
non-null as valid.**

---

## 4. What happens on rename, resale or re-registration

Measured, not inferred:

- **The CEG nucleus never changes.** No plant in the corpus changed nucleus. It is the durable key.
- **Rename keeps the old name inline.** SIGA writes the alias into the name field itself:
  242 rows carry an `(Antiga …)` parenthetical, 119 of them EOL/UFV — e.g. `Cerro Chato I (Antiga
  Coxilha Negra V)`, `Camilo Pontes I (Antiga Renascença I)`, `Caldeirão Grande III (Antiga Santa
  Veridiana)`. So `NomEmpreendimento` is *not* a clean display name; it is a name plus an unmarked
  historical alias, and it will not match ONS's `nom_usina` (normalised-exact agreement is only
  1,526/1,614 = 94.5%). **Never join on name; never render `NomEmpreendimento` raw.**
- **Re-registration bumps the version segment**, per the dictionary: `VV` is "a versão (Se 1 é a
  primeira, se maior que 1 sofreu alteração)". Measured: 243 SIGA rows at version 2, 23 at 3, 6 at 4.
  As shown in §2, ONS does not follow the bump — 8 of 1,614 disagree today. Stripping the version is
  what makes this a non-issue.
- **Resale is visible only as a value change.** `DscPropriRegimePariticipacao` (100% populated) is
  free text of the form `100% para <agent> - <CNPJ> (<regime>)`. There is no ownership-change date
  and no prior-owner field. Because SIGA is overwritten in place, an ownership change is
  **detectable only by diffing your own successive snapshots** — the same custodial obligation the
  ONS research established for ONS files.

---

## 5. Snapshot, not history

**SIGA is a current-state snapshot.** Evidence:

- One `DatGeracaoConjuntoDados` value per file; one row per `CodCEG`; no valid-from/valid-to on
  capacity, phase, name, ownership or coordinates.
- The CKAN dataset carries **no historical or archival resource** — five resources, all
  current-cut (2 CSV, 2 XML, 1 PDF).
- **`DatInicioVigencia` / `DatFimVigencia` are outorga validity, not operational life,** and are
  useless as a retirement proxy: of the 18,397 operating EOL/UFV rows, 16,701 have a NULL
  `DatFimVigencia` and **zero** have one in the past.
- The 3-day monthly-vs-daily diff shows records **deleted outright** (8 gone, 2 added), with no
  tombstone. That is how SIGA represents a plant leaving: it stops existing.

**Corroborating the deletion behaviour on real retirements.** Taking every plant ONS
`capacidade-geracao` shows as *fully* deactivated (all units carrying a `dat_desativacao`) — 84
plants, 5,205 MW, essentially all thermal — **78 are absent from SIGA entirely** and **6 are still
listed as `Operação` with 343 MW of `MdaPotenciaFiscalizadaKw`** (Camaçari, Willian Arjona, Tambaqui,
Povoação 1, Jaraqui, Pirarucu). So from a SIGA snapshot alone you can neither see that a retired
plant existed, nor when it left, nor — in a sixth of cases — that it left at all. This is exactly the
behaviour the dictionary implies when it says `MdaPotenciaFiscalizadaKw` is "a última potência
considerada em operação".

### Quantifying the two errors this forces

**(a) Reconstructed build-up — the error is large, and it is the one that matters.**
Filtering the 1,614 curtailed plants by `DatEntradaOperacao <= t`:

| as of | plants | MW | % of 2026-08 fleet |
|---|---|---|---|
| 2024-04-01 | 1,285 | 41,016 | 74.2% |
| 2024-10-01 | 1,397 | 45,451 | 82.2% |
| 2025-04-01 | 1,483 | 49,083 | 88.8% |
| 2025-10-01 | 1,518 | 50,924 | 92.1% |
| 2026-08-28 | 1,614 | 55,276 | 100.0% |

**25.8% of today's curtailed-fleet MW did not exist when the training window opens.** Using a fixed
2026-08 weight vector therefore contaminates the backtest badly. Measuring the contamination as
½·L1 distance between the fixed weight vector and the as-of-date one (i.e. the fraction of weight
mass misallocated), per subsystem × technology:

| subsystem | tech | plants | MW | at 2024-04 | at 2025-01 | at 2026-01 |
|---|---|---|---|---|---|---|
| NE | wind | 948 | 30,827 | **0.135** | 0.052 | 0.004 |
| NE | solar | 303 | 11,446 | **0.393** | 0.271 | 0.146 |
| SE | solar | 257 | 10,101 | **0.504** | 0.202 | 0.118 |
| S | wind | 85 | 2,215 | 0.121 | 0.028 | 0.000 |
| SE | wind | 6 | 261 | 0.500 | 0.500 | 0.000 |
| N | wind | 15 | 426 | 0.000 | 0.000 | 0.000 |

And as capacity-weighted centroid displacement (fixed 2026-08 weights vs 2024-04 weights):

| subsystem × tech | 2026-08 centroid | 2024-04 centroid | drift |
|---|---|---|---|
| SE solar | (−16.489, −45.633) | (−17.327, −45.758) | **94 km** |
| S wind | (−31.365, −52.629) | (−31.409, −52.179) | 43 km |
| NE solar | (−7.784, −40.175) | (−8.117, −40.327) | 40 km |
| NE wind | (−8.188, −39.292) | (−8.024, −39.189) | 21 km |

94 km is more than seven grid cells at Open-Meteo's 9–13 km resolution. **The weather research's
concern is confirmed and sized: time-varying weights are mandatory, not a refinement**, and they
matter most for SE and NE solar — which is also where solar constrained-off history is shortest.

**(b) Decommissioning invisibility — empirically zero for VRE in this window.** ONS
`capacidade-geracao` covers 3,380 wind and solar generating units. **Exactly 3 carry a
`dat_desativacao`** — three units of `BELMONTE 1-1` (`UFV.RS.PE.040725-9`), 50 MW, deactivated
2023-05-03, i.e. *before* the training window. **There are zero VRE deactivations on or after
2024-04-01.** For wind and solar over 2024-04 → now, the decommissioning error is **0 MW, 0.00%**.

That is a real finding, not an absence of evidence: the same column is heavily used for thermal
(980 units, 6,551 MW), so ONS clearly populates it when retirements happen. Brazilian VRE is young
and nothing has retired yet. **The mitigation is therefore an assertion, not a model:** carry
`dat_desativacao` from ONS in the registry, alert when it becomes non-null for any VRE plant, and
revisit the weighting then. Do not build a decommissioning estimator for an error that is currently
zero — and do not carry the assumption into any thermal or hydro extension, where SIGA is wrong for
6 plants / 343 MW today.

---

## 6. `DatEntradaOperacao` is the first unit only — and it barely matters

The dictionary defines it as "Data de entrada em operação da **primeira** unidade geradora". A plant
commissioned over months thus gets its full nameplate credited on day one. Measured against ONS's
per-unit dates for the 1,614 curtailed plants:

- Ramp (first unit → last unit): median **0 days**, p90 6 days, p95 26 days. 72 plants (4.5%) ramp
  over 30 days, 29 over 90 days, 3 over a year (max 2,730 days). Plants with a >90-day ramp are
  **2.7% of fleet MW**.
- Comparing month by month across the window, fleet MW under SIGA's step function vs ONS's per-unit
  accrual: **mean overstatement 0.17%, maximum 0.38%** (2024-04-01).

**So the step-function approximation costs at most 0.4% of fleet MW** — two orders of magnitude
smaller than the 25.8% fixed-weight error above. Using ONS per-unit dates removes it for free, since
`capacidade-geracao` must be ingested anyway; there is no reason to accept even 0.4%, but no reason
to panic about it either.

### If per-unit history from a single snapshot is ever not enough

Both ONS `capacidade-geracao` and SIGA reflect *today's record of the past*: retroactive corrections
to a commissioning date are invisible unless you snapshot daily. Two ANEEL datasets are genuine
append-only event logs and would close that gap:

- **[Liberação para operação comercial de empreendimentos de geração](https://dadosabertos.aneel.gov.br/dataset/liberacao-para-operacao-comercial-de-empreendimentos-de-geracao)** —
  `unidades-geradoras-liberadas-operacao-comercial-detalhado.csv`, 12.8 MB, **ODbL**, updated
  *quinzenal*, coverage from 1997. Columns include `CodCEG`, `NumUgUsina`,
  `MdaPotenciaLiberadaComercial`, `DatUGInicioOpComerOutorgado`, `DatLiberOpComerRealizado`,
  `NumDespachoComercial` — i.e. the ANEEL despacho that released each unit, with both the scheduled
  and realised date. This is the authoritative per-unit commissioning record and joins on the same
  `ceg_core` key.
- **[Atos de Outorgas de Geração](https://dadosabertos.aneel.gov.br/dataset/atos-de-outorgas-de-geracao)** —
  13.9 MB, ODbL, monthly, "documentos emitidos pela ANEEL referentes aos empreendimentos de geração
  **a partir de 2015**". The place a revocation or transfer would leave a dated trace.

Neither is needed for v1 — ONS per-unit dates suffice at 0.17% error — but they are the escalation
path, and they are cheap.

---

## 7. ODbL: what it obliges a product that publishes derived figures

SIGA's licence is **ODbL 1.0** (`license_id: odc-odbl`). Read from the
[full legal text](https://opendatacommons.org/licenses/odbl/1-0/). The licence draws one distinction
that decides everything:

- a **Produced Work** is "a work (such as an image, audiovisual material, text, or sounds) resulting
  from using … the Contents (via a search or other query)" — a chart, a KPI, a narrated paragraph;
- a **Derivative Database** is a database "based upon the Database", explicitly including
  "Extracting or Re-utilising the whole or a Substantial part of the Contents in a new Database".

**Commercial use is not restricted.** §3.1 grants a worldwide royalty-free licence and states the
rights "explicitly include commercial use, and do not exclude any field of endeavour." This
**corrects the framing in `.wayfinder/map.md`**, which groups SIGA with Open-Meteo under "licensing
has a commercial cliff". Open-Meteo's free tier does have one. ODbL does not — charging money
changes nothing about WattSteer's SIGA obligations. What ODbL imposes is share-alike, and that
applies from day one whether or not anyone pays.

### How the rules land on WattSteer

**WattSteer's `plant` table is a Derivative Database.** Loading 1,614 SIGA rows' coordinates,
capacities and dates into Postgres, joined to ONS keys, is textbook §4.4(b) Extraction into a new
database.

**Charts, KPIs and narration are Produced Works, not Derivative Databases** — §4.5(b): "Using this
Database … to create a Produced Work does not create a Derivative Database for purposes of Section
4.4." So the MWh-recovered headline, the SHAP panels and the maps do **not** themselves trigger
share-alike.

**But §4.4(c) closes the loop, and it is the operative clause here:**

> *A Derivative Database is Publicly Used and so must comply with Section 4.4. if a Produced Work
> created from the Derivative Database is Publicly Used.*

WattSteer publishes charts built from the plant table to a public, unauthenticated site. That
publicly uses a Produced Work derived from the Derivative Database, so the plant table itself falls
under share-alike even though it is never served directly. The §4.5(c) internal-use exemption does
**not** apply — it covers use "internally within an organisation", which a public site is not.

**Concretely, four obligations:**

1. **§4.3 notice on the Produced Works.** Every public surface showing SIGA-derived figures needs a
   notice "reasonably calculated" to tell viewers the content came from the database and is
   available under ODbL. The licence supplies satisfying text: *"Contains information from
   `<DATABASE NAME>`, which is made available here under the Open Database License (ODbL)"*, with
   `<DATABASE NAME>` hyperlinked to the dataset URI and "Open Database License" to the licence URI.
   A footer line plus a `/sobre-os-dados` page carries this; it must appear in **both** PT-BR and
   EN, so it is an i18n string, not a hardcoded footer.
2. **§4.4(a) licence the derivative database under ODbL** (or a compatible licence).
3. **§4.6 offer machine-readable access.** You must "offer to recipients … a copy in a machine
   readable form of (a) the entire Derivative Database; **or** (b) a file containing all of the
   alterations made to the Database or the method of making the alterations (such as an algorithm)",
   free of charge over the internet. **Option (b) is the cheap and honest route**: publish the
   ingestion transform — the `ceg_core` derivation, the coordinate validation, the ONS join, the
   as-of capacity reconstruction — as documented source, plus the SIGA source URI and snapshot date.
   Option (a) would mean shipping a CSV dump endpoint of the plant table.
4. **§4.7 no restrictive technological measures** on the derivative database, and — should WattSteer
   ever gate it — parallel distribution of an unrestricted version.

**Keep the ODbL boundary tight.** §4.5(a) exempts a *Collective Database*: incorporating an ODbL
database in a collection does not force the collection under ODbL, though ODbL still governs that
part. Practically: keep SIGA-sourced columns in their own table (`plant_geo`, say) with an explicit
`source = 'ANEEL SIGA'` and snapshot date, rather than smearing lat/lon across a wide table that
also holds ONS (CC-BY) and Open-Meteo (CC-BY, non-commercial free tier) fields. That keeps "the
alterations file" definable, keeps three incompatible attribution regimes separable, and means
share-alike does not have to be argued about for the whole schema.

**One un-obvious consequence:** §2.4 says ODbL does not cover rights in individual Contents, and
§4.2(c) requires keeping intact any notices. Nothing in the SIGA files carries a per-row notice, so
this is satisfied by the dataset-level attribution. But the ownership field
`DscPropriRegimePariticipacao` contains **CNPJs of named legal persons**; ODbL §2.4 explicitly
disclaims covering "data protection, privacy, or personality rights" in Contents. Ingest that field
only if it is used, and do not publish it as a bulk dump without a second look.

---

## 8. Recommendations

1. **Ingest the daily SIGA CSV**, not the monthly one, via conditional `GET` on `ETag` /
   `Last-Modified`. `datastore_search` with `filters` is the lighter alternative if only
   EOL/UFV/Operação is wanted.
2. **Join on `ceg_core` = the first four dot-segments of the CEG, version discarded.** Add an
   ingestion assertion that the verbatim match rate is 0% and the core match rate is ≥ 99% — the
   first would otherwise fail silently, and the second is the canary for an ANEEL format change.
3. **ONS `capacidade-geracao` owns capacity and dates; SIGA owns coordinates.** Reconstruct
   as-of-date capacity from ONS per-unit `dat_entradaoperacao` / `dat_desativacao`; take lat/lon,
   `DscMuninicpios` and ownership from SIGA.
4. **Weights must be time-varying.** Fixed 2026-08 weights misplace half the SE-solar weight mass at
   window start and move that centroid 94 km. This is settled by measurement now, not a caveat.
5. **Validate coordinates**: Brazil bbox, reject exact `(0,0)`, fall back to a municipality centroid
   from `DscMuninicpios`. 316 operating rows need it.
6. **Snapshot SIGA daily into the bitemporal store.** Deletions are how SIGA represents retirement
   and re-registration; nothing is recoverable after the fact. Same custodial rule as ONS.
7. **Never join or display on plant name.** 94.5% agreement, and SIGA names carry unmarked
   `(Antiga …)` aliases.
8. **Alert, don't model, on decommissioning.** Zero VRE deactivations exist in the window; wire an
   assertion on ONS `dat_desativacao` becoming non-null for a VRE plant.
9. **ODbL compliance is a v1 task, not a monetisation task**: bilingual §4.3 notice on every public
   surface carrying SIGA-derived figures, an ODbL declaration for the plant registry, and a
   published transform document satisfying §4.6(b).
10. **If WattSteer ever extends to thermal, SIGA does not serve it** (68% coverage; 6 retired plants
    still shown operating). Hydro is fine at 100%.

---

## Open questions / could not confirm

1. **Why Cerro Chato IV/V/VI and Cerro dos Trindade are absent from SIGA.** Confirmed absent by
   nucleus, not merely by version mismatch; confirmed live in ONS `modalidade-usina` (`sts_aneel =
   A`) and `capacidade-geracao` (no `dat_desativacao`); confirmed that Cerro Chato I–III *are*
   present. Whether this is an ANEEL registry gap, a revocation ONS has not reflected, or a
   consolidation into another CEG was **not** established — `atos-de-outorgas-de-geracao` was
   identified but not searched for these nuclei. Immaterial today (no observed rows), but it is the
   one live counter-example to "the join is total".
2. **Whether coordinates are plant sites or municipality centroids.** The dictionary says "ponto
   centróide de localização do empreendimento", which is ambiguous, and there is no independent
   coordinate source in ONS to cross-check against (only `subestacao` has geometry). If SIGA
   coordinates are in fact municipality centroids, the cluster centroids in
   [`weather-sources.md`](weather-sources.md) are unaffected (they were built by aggregating *by
   municipality* anyway) but per-plant siting would be weaker than it looks. Not tested.
3. **Absolute coordinate accuracy.** No ground truth was available. Only gross validity (null,
   zero, bounding box) was checked. A plant sited in the wrong municipality would pass every test
   applied here.
4. **Whether any SIGA snapshot history exists anywhere.** The CKAN dataset has none, and no
   `histórico` package appears in the 72-package ANEEL catalogue. Whether dados.gov.br, the SIGA
   web panel at `aneel.gov.br/siga`, or an Internet Archive capture preserves older cuts was not
   investigated. If one does, it would let the fixed-weight error in §5 be validated rather than
   only reconstructed.
5. **Rate limits and acceptable use for `dadosabertos.aneel.gov.br`.** None found on the CKAN
   pages; the API is unauthenticated. Sustained daily polling behaviour is untested.
6. **The meaning of "até a revogação" in the CKAN notes.** The description promises coverage through
   revocation but the file has only three phase values and no revoked state. Whether revoked
   empreendimentos are simply deleted (the deletion evidence suggests yes) or whether a fourth phase
   appears intermittently was not established — only two snapshots, 3 days apart, were compared.
7. **The 9 Mauriti plants' ONS version `00`.** ONS emits a version segment SIGA never uses. Whether
   `00` is an ONS placeholder for "unknown version" or a real CEG state is undocumented in either
   dictionary.
8. **Whether ODbL §4.6's "alterations file" route is satisfied by prose documentation of the
   transform** rather than executable code. The licence says "all of the alterations … or the method
   of making the alterations (such as an algorithm)", which reads permissively, but this is a legal
   reading of a clause with little public interpretation history and no Brazilian case law was
   sought. Worth a lawyer's eye before any commercial launch — not because of a commercial cliff
   (there is none) but because §4.6 is the obligation most likely to be got wrong.
9. **ONS's own licence compatibility with ODbL.** ONS data is Creative Commons Atribuição; CC-BY 4.0
   is not on any published ODbL compatible-licence list (§4.4(a)(iii) contemplates a proxy naming
   compatible licences; ODC has not named one for CC-BY). The Collective-Database structure in §8
   sidesteps the question rather than answering it. Not resolved.
10. **`DatGeracaoConjuntoDados` timezone.** A bare date, no time, despite the dictionary describing
    it as "Data e hora do processamento". Treated as a date label only.

---

*Fetched and computed 2026-08-28. SIGA monthly cut `DatGeracaoConjuntoDados = 2026-08-25`, daily cut
`2026-08-28`. ONS constrained-off files as published that day — note that ONS rewrites history in
place, so the 1,614-plant population is as-of this ingest.*

*Contains information from [ANEEL SIGA](https://dadosabertos.aneel.gov.br/dataset/siga-sistema-de-informacoes-de-geracao-da-aneel),
which is made available here under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).*
