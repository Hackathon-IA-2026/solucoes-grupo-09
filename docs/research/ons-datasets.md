# ONS Dados Abertos — datasets required by WattSteer

Primary-source survey of the ONS open-data holdings that WattSteer needs for a renewable
constrained-off decision engine. Every schema fact below comes from one of: the CKAN API at
`https://dados.ons.org.br/api/3/action/*`, the ONS-published data dictionaries (the JSON and PDF
`DicionarioDados_*` resources attached to each dataset), HTTP `HEAD` responses from the S3 bucket
that serves the files, or a header/row read of the actual published file. Where a fact is only
inferred empirically rather than documented, it is labelled as such; where it could not be
established at all it appears in **Open questions** at the end rather than being guessed. All
network access was available and every URL cited was fetched on **2026-08-28**.

Two findings dominate the design and are worth reading before the tables. First, the
constrained-off "per usina" datasets are **not** per-usina — they are per *reporting entity*, which
for Tipo II-C plants is a *conjunto*; the genuinely per-plant datasets (`*_detail`) carry no
restriction reason code at all. Second, ONS republishes historical months **years** after the fact
under the **same filename with no version marker**, so revision detection has to be built from S3
`Last-Modified`/`ETag` — there is no vintage you can ask for.

---

## Summary table

| # | Dataset | CKAN slug | S3 path segment | Grain | File split | Cadence | Formats | History |
|---|---------|-----------|-----------------|-------|-----------|---------|---------|---------|
| 1 | Constrained-off eólicas (entity) | `restricao_coff_eolica_usi` | `restricao_coff_eolica_tm` | 30 min × entity | monthly | daily 12h/19h | CSV, XLSX, PARQUET | 2021-10 → |
| 2 | Constrained-off eólicas (por usina) | `restricao_coff_eolica_detail` | `restricao_coff_eolica_detail_tm` | 30 min × usina | monthly | daily 12h/19h | CSV, XLSX, PARQUET | 2021-10 → |
| 3 | Constrained-off fotovoltaicas (entity) | `restricao_coff_fotovoltaica` | `restricao_coff_fotovoltaica_tm` | 30 min × entity | monthly | daily 12h/19h | CSV, XLSX, PARQUET | 2024-04 → |
| 4 | Constrained-off fotovoltaicas (por usina) | `restricao_coff_fotovoltaica_detail` | `restricao_coff_fotovoltaica_detail_tm` | 30 min × usina | monthly | daily 12h/19h | CSV, XLSX, PARQUET | 2024-04 → |
| 5 | Balanço de energia nos subsistemas | `balanco-energia-subsistema` | `balanco_energia_subsistema_ho` | hourly × subsistema | yearly | daily 12h/19h | CSV, XLSX, PARQUET | 2000 → |
| 6 | Carga de energia verificada | `carga-energia-verificada` | *(REST API only)* | 30 min × área de carga | n/a — API | continuous | JSON (API) | 2016-01-01 → |
| 7 | Carga de energia programada | `carga-energia-programada` | *(REST API only)* | 30 min × área de carga | n/a — API | continuous | JSON (API) | 2021-03-05 → |
| 8 | Carga de energia diária | `carga-energia` | `carga_energia_di` | daily × subsistema | yearly | daily 12h/19h | CSV, XLSX, PARQUET | 2000 → |
| 9 | Intercâmbios entre subsistemas | `intercambio-nacional` | `intercambio_nacional_ho` | hourly × pair | yearly | daily 12h/19h | CSV, XLSX, PARQUET(2023→) | 2000 → |
| 10 | DESSEM — balanço geral | `balanco_dessem_geral` | `balanco_dessem_geral` | 30 min × subsistema | **daily** | daily, D-1 | CSV, XLSX, PARQUET | 2025-05-23 → |
| 11 | DESSEM — balanço detalhado | `balanco_dessem_detalhe` | `balanco_dessem_detalhe` | 30 min × subsistema | **daily** | daily, D-1 | CSV, XLSX, PARQUET | 2025-05-23 → |
| 12 | Capacidade instalada de geração | `capacidade-geracao` | `capacidade-geracao` | unidade geradora (snapshot) | single file | daily 12h/19h | CSV, XLSX, PARQUET | snapshot only |
| 13 | Relacionamento conjunto ↔ usina | `usina_conjunto` | `usina_conjunto` | usina × relationship period | single file | daily | CSV, XLSX, PARQUET | SCD2 dates |
| 14 | Modalidade de operação de usinas | `modalidade-usina` | `modalidade_usina` | usina (snapshot) | single file | daily | CSV, XLSX, PARQUET | snapshot only |
| 15 | CMO semi-horário (DESSEM shadow price) | `cmo-semi-horario` | `cmo_tm` | 30 min × subsistema | yearly | daily | CSV, XLSX, PARQUET | 2020 → |

Datasets 13–15 are not in the brief's stated scope but are load-bearing: 13 and 14 are required to
make dataset 1/3 joinable to 2/4 at all (see [Cross-dataset join concerns](#cross-dataset-join-concerns)),
and 15 is the DESSEM price signal that pairs with 10/11.

**Canonical page URL pattern:** `https://dados.ons.org.br/dataset/<slug>` (verified HTTP 200 for
`restricao_coff_eolica_usi` and `balanco-energia-subsistema`).

**Resource URL pattern:** `https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/<s3-path-segment>/<FILE>.<ext>`.

Note that the S3 path segment is frequently **not** the CKAN slug (`restricao_coff_eolica_usi` →
`restricao_coff_eolica_tm`; `carga-energia` → `carga_energia_di`), and filenames are not reliably
derivable either — the CMO file is `CMO_SEMIHORARIO_2026.csv`, not `CMO_SEMI_HORARIO_2026.csv`
(constructing the latter returns S3 `NoSuchKey`). **Always read resource URLs from
`package_show`; never construct them.** A minority of older resources are served from the regional
host `ons-aws-prod-opendata.s3.us-west-2.amazonaws.com` instead of the global one (observed on
`RESTRICAO_COFF_EOLICA_DETAIL_2021_10.csv`) — another reason to use the URL CKAN gives you.

**File conventions** (verified by byte-reading `RESTRICAO_COFF_EOLICA_2026_08.csv`): CSV is
`;`-delimited, UTF-8, **no BOM** (first bytes are `69 64 5f 73` = `id_s`), `.` as decimal separator,
header row present.

---

## 1–4. Constrained-off (eólicas and fotovoltaicas)

ONS publishes four datasets here, in two shapes × two technologies. The shapes are **not**
"subsystem grain vs plant grain" as the brief anticipated — both shapes are plant-ish, and neither
is a subsystem aggregate. Getting this right matters:

- **The `_usi` / plain shape** (datasets 1, 3) is the *apuração* (settlement) view. It carries the
  restriction reason codes and the reference-generation values used to quantify curtailed energy. Its
  row key is a **reporting entity**, which is a *conjunto* for Tipo II-C plants and an individual
  plant for Tipo I / II-B.
- **The `_detail` shape** (datasets 2, 4) is the true per-usina view, with measured wind speed /
  irradiance and estimated vs verified generation per plant. It carries **no reason code and no
  reference generation** — you cannot compute curtailment volume from it directly.

Evidence for the entity-vs-plant claim, from a full scan of `RESTRICAO_COFF_EOLICA_2026_08.csv`
(198,311 data rows, 154 distinct `id_ons`):

```
id_ons starting "CJU_" (conjunto):  184,032 rows   — ceg is always "-"
individual plant code:               14,279 rows   — ceg always populated
```

This exactly matches the dictionary note on `ceg`: *"Os Conjuntos de Usinas não tem código CEG, e
está representado por um '-'"*
([dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_eolica_tm/DicionarioDados_RestricaoContrainedoff_UsiEolicas.json)).

### 1 & 3 — schema (identical across eólica and fotovoltaica)

Dataset pages:
[`restricao_coff_eolica_usi`](https://dados.ons.org.br/dataset/restricao_coff_eolica_usi) ·
[`restricao_coff_fotovoltaica`](https://dados.ons.org.br/dataset/restricao_coff_fotovoltaica)

Confirmed by header read of `RESTRICAO_COFF_EOLICA_2026_08.csv` and
`RESTRICAO_COFF_FOTOVOLTAICA_2026_08.csv`, and by the JSON dictionaries
([eólica](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_eolica_tm/DicionarioDados_RestricaoContrainedoff_UsiEolicas.json),
[solar](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_fotovoltaica_tm/DicionarioDados_RestricaoContrainedoff_UsiFotovoltaica.json)):

```
id_subsistema               Identificador do Subsistema
nom_subsistema              Nome do Subsistema
id_estado                   Sigla do Estado
nom_estado                  Nome do Estado
nom_usina                   Nome da Usina ou Conjunto de Usinas
id_ons                      Identificador da Usina ou do Conjunto de Usinas no ONS
ceg                         Código Único do Empreendimento de Geração (ANEEL); "-" for conjuntos
din_instante                Data/Hora
val_geracao                 Valor da Geração,                          MWmed
val_geracaolimitada         Valor da Geração Limitada por restrição,   MWmed
val_disponibilidade         Disponibilidade verificada em tempo real,  MWmed
val_geracaoreferencia       Geração de referência (ou estimada),       MWmed
val_geracaoreferenciafinal  Geração de Referência Final,               MWmed
cod_razaorestricao          Código da Razão da Restrição
cod_origemrestricao         Código da Origem da Restrição
dsc_restricao               Detalhamento do motivo da restrição   [added 2025; see below]
```

All five `val_*` columns are **MWmed** — explicitly stated in the dictionary, and reconfirmed by the
2025-03-31 dictionary revision *"Atualização do texto de descrição com as informações de unidade de
medida dos valores"*. Since the grain is 30 minutes, MWmed over a half-hour × 0.5 h gives MWh.

#### Restriction reason codes — confirmed

The brief's expected vocabulary was close but wrong in two ways. Verbatim from the ONS dictionary
(`cod_razaorestricao`), identical text in the eólica and fotovoltaica dictionaries:

> *Código da Razão da Restrição, podendo ser: REL – Razão de indisponibilidade externa (elétrica).
> CNF – Razão de atendimento a requisitos de confiabilidade. ENE – Razão energética
> PAR - Restrição indicada no parecer de acesso*

| Code | ONS definition (verbatim) |
|------|---------------------------|
| `REL` | Razão de indisponibilidade externa (elétrica) |
| `CNF` | Razão de atendimento a requisitos de confiabilidade |
| `ENE` | Razão energética |
| `PAR` | Restrição indicada no parecer de acesso |

Corrections to the brief's assumptions: there are **four** codes, not three, and **`REL` is not
"relaxamento"** — it is *indisponibilidade externa (elétrica)*, i.e. grid unavailability. `PAR` was
added on **2024-04-11** per the dictionary changelog (Versão 1.2: *"Adição do domínio PAR na coluna
'cod_razaorestricao'"*), so it cannot appear before that date.

`cod_origemrestricao` is confirmed as exactly two values: **`LOC` – Local**, **`SIS` – Sistêmica**.

Observed value distributions (full-file scans; blank = no restriction in that half-hour):

| File | `ENE` | `CNF` | `REL` | `PAR` | blank |
|---|---|---|---|---|---|
| `RESTRICAO_COFF_EOLICA_2026_08.csv` | 62,168 | 35,947 | 5,941 | 0 | 94,255 |
| `RESTRICAO_COFF_EOLICA_2025_03.csv` | 21,116 | 25,545 | 3,735 | 0 | — |
| `RESTRICAO_COFF_EOLICA_2025_11.csv` | 66,846 | 41,081 | 1,713 | 0 | — |
| `RESTRICAO_COFF_EOLICA_2026_04.csv` | 66,919 | 11,061 | 4,723 | 0 | — |
| `RESTRICAO_COFF_FOTOVOLTAICA_2026_04.csv` | 33,574 | 1,296 | 563 | 0 | — |

`cod_origemrestricao` on `RESTRICAO_COFF_EOLICA_2026_08.csv`: `SIS` 65,595 / `LOC` 38,461 / blank 94,255.
Note the origin and reason blanks coincide exactly (94,255), i.e. the two fields are populated
together.

**`PAR` is documented but was not observed** in any of the five months scanned. Treat it as a valid
domain member that is rare, not as dead code.

`dsc_restricao` is free text and high-cardinality — it names the specific network element or
operating instruction, e.g. `Controle de inequação: LIMITAÇÃO DA TRANSMISSÃO NAS LTS 500 KV AÇU III
/ QUIXADÁ – C1(V2), AÇU III / MILAGRES II – C1(C2) ... - IO-ON.NE.5NE`, or `Controle do fluxo:
FNESE # Fluxo Nordeste/Sudeste - Conforme SGI 67.632-25`. It is not a controlled vocabulary and
contains free-form SGI ticket references with inconsistent formatting (`SGI 67.632-25`, `SGI
67632-25`, and `SGI 16.426-26` / `SGI 16426-26` all observed within one month). A useful empirical
regularity: in `RESTRICAO_COFF_EOLICA_2026_04.csv` the string `Controle de frequência do SIN.`
occurs exactly 66,919 times — precisely the `ENE` count — so `ENE` maps 1:1 to frequency control in
that month.

#### Schema history (datasets 1 & 3)

From the PDF dictionary changelogs (*Evoluções do Conjunto de Dados*), which are the authoritative
record — [eólica PDF](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_eolica_tm/DicionarioDados_RestricaoContrainedoff_UsiEolicas.pdf),
[solar PDF](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_fotovoltaica_tm/DicionarioDados_RestricaoContrainedoff_UsiFotovoltaica.pdf):

| Date | Version | Change (eólica) |
|---|---|---|
| 2022-10-07 | 1.0 | Criação do dicionário |
| 2023-06-25 | 1.1 | **Added `id_ons` and `ceg`** |
| 2024-04-11 | 1.2 | **Added `PAR` to the `cod_razaorestricao` domain** |
| 2025-03-31 | 1.3 | Descriptions updated with units of measure |
| 2025-09-26 | 1.4 | **Added `dsc_restricao`** |

Solar: 1.0 2024-04-02 (creation), 1.1 2025-03-31 (units), 1.2 2025-09-26 (**`dsc_restricao` added**).

**Observed file-level reality differs from the changelog dates, and this is important.** Bisecting
actual published headers:

```
RESTRICAO_COFF_EOLICA_2024_12.csv   -> no dsc_restricao
RESTRICAO_COFF_EOLICA_2025_01.csv   -> HAS dsc_restricao
RESTRICAO_COFF_FOTOVOLTAICA_2024_12.csv -> no dsc_restricao
RESTRICAO_COFF_FOTOVOLTAICA_2025_01.csv -> HAS dsc_restricao
```

The column was introduced to the dictionary in September 2025 but is present in the **January 2025**
file. ONS **retroactively rewrote the whole 2025 back-catalogue** with the new column — corroborated
by the S3 `Last-Modified` of `RESTRICAO_COFF_EOLICA_2025_01.csv`, which is **2026-05-04**. So the
column boundary in the *files* is 2025-01, not 2025-09, and it moved after the fact. An ingestion
pipeline that pinned a schema per month based on a one-time observation would silently break.

Additionally, in `RESTRICAO_COFF_EOLICA_2025_03.csv` the `dsc_restricao` column exists but is
**empty for every row**, while `2025_11` is densely populated. Column presence ≠ column populated.

### 2 & 4 — `_detail` schema

Dataset pages:
[`restricao_coff_eolica_detail`](https://dados.ons.org.br/dataset/restricao_coff_eolica_detail) ·
[`restricao_coff_fotovoltaica_detail`](https://dados.ons.org.br/dataset/restricao_coff_fotovoltaica_detail)

Wind ([dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_eolica_detail_tm/DicionarioDados_RestricaoContrainedoff_UsiEolicas_DetalhamentoPorUsina.json)),
confirmed against `RESTRICAO_COFF_EOLICA_DETAIL_2026_08.csv`:

```
id_subsistema          Identificador do subsistema
id_estado              Sigla do Estado
nom_modalidadeoperacao Modalidade de Operação da Usina        e.g. "Tipo II-C"
nom_conjuntousina      Nome do Conjunto (only for Tipo II-C)
nom_usina              Nome da Usina
id_ons                 Identificador da Usina/Conjunto no ONS
ceg                    CEG (ANEEL)
din_instante           Data/Hora
val_ventoverificado    Vento verificado, em m3/s          [see caveat]
flg_dadoventoinvalido  1 = medida falhou >6 min na semi-hora
val_geracaoestimada    Geração estimada,  MWmed  (from wind × power curve, else from history)
val_geracaoverificada  Geração verificada, MWmed
```

Solar ([dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_fotovoltaica_detail_tm/DicionarioDados_RestricaoContrainedoff_UsiFotovoltaica_Detail.json)),
confirmed against `RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2026_08.csv` — identical except:

```
val_irradianciaverificado     Irradiância verificada, em W/m2
flg_dadoirradianciainvalido   1 = medida falhou >6 min na semi-hora
```

Note `val_ventoverificado` is documented as **"em m3/s"**, which is a units error in the ONS
dictionary — wind speed is m/s, and the observed values (5.079, 5.769, 7.18) are consistent with
m/s. Flagged as a documentation defect, not reproduced as fact.

**Boolean encoding is inconsistent between the two technologies** and has been stable since each
dataset's inception, so this is a permanent parsing difference, not drift:

```
RESTRICAO_COFF_EOLICA_DETAIL_2023_01.csv        flg_dadoventoinvalido       = 0.0     (numeric)
RESTRICAO_COFF_EOLICA_DETAIL_2026_08.csv        flg_dadoventoinvalido       = 0.0     (numeric)
RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2024_04.csv  flg_dadoirradianciainvalido = False   (boolean)
RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2026_08.csv  flg_dadoirradianciainvalido = False   (boolean)
```

Also note the `_detail` datasets have **`id_estado` but no `nom_estado`, and no `nom_subsistema`** —
unlike the entity-grain datasets. Do not assume symmetry.

`_detail` changelogs record only the same `id_ons`/`ceg` addition (2023-06-25, wind) and cosmetic
column reordering (2025-04-20, both) — **no `dsc_restricao`, no `PAR`**, consistent with these files
carrying no reason code.

### Coverage, cadence and revision behaviour (all four)

| Dataset | CSV coverage | PARQUET coverage |
|---|---|---|
| `restricao_coff_eolica_usi` | 2021-10 → 2026-08 (59 months) | **2023-10 → 2026-08 only (35)** |
| `restricao_coff_eolica_detail` | 2021-10 → 2026-08 (59) | **2023-01 → 2026-08 only (44)** |
| `restricao_coff_fotovoltaica` | 2024-04 → 2026-08 (29) | 2024-04 → 2026-08 (29) |
| `restricao_coff_fotovoltaica_detail` | 2024-04 → 2026-08 (30) | 2024-04 → 2026-08 (30) |

**Parquet does not cover the full history for the two wind datasets.** CSV is the only format with
complete coverage — relevant since Parquet would otherwise be the obvious ingest choice (the
2026-08 wind entity file is 3.3 MB as Parquet vs **29 MB** as CSV; the wind `_detail` file is 10 MB
vs **171 MB**). Recommended: Parquet where available, CSV fallback for pre-2023 wind.

Update cadence, from the CKAN `Schedule de Atualização` extra on all four packages: **"Diariamento,
as 12h e 19h"** (twice daily).

The revision pattern, from the full CKAN `last_modified` series for `restricao_coff_eolica_usi`
CSVs, is the single most important operational fact in this document:

```
2021-10 .. 2021-12   last_modified = 2024-05-22     <- rewritten ~2.5 years later
2022-01 .. 2022-12   last_modified = 2024-05-20
2023-01 .. 2023-09   last_modified = 2024-01-02
2023-10 .. 2023-12   last_modified = 2025-06-05
2024-01 .. 2024-12   last_modified = 2025-02-13 / 2025-02-24
2025-01 .. 2025-12   last_modified = 2026-04-30 / 2026-05-04   <- rewritten ~1 year later
2026-01 .. 2026-03   last_modified = 2026-04-30
2026-04             last_modified = 2026-05-31
2026-05             last_modified = 2026-06-30
2026-06             last_modified = 2026-07-31
2026-07             last_modified = 2026-08-28   <- still moving
2026-08             last_modified = 2026-08-28   <- current month
```

Three distinct regimes: (a) the current and immediately preceding month are rewritten on essentially
every publication cycle; (b) a month appears to "close" at the end of the following month; (c)
**bulk re-publication campaigns rewrite years of closed history at once** — the entire 2025 year was
rewritten on 2026-04-30/05-04, and 2021–2022 were rewritten in May 2024. Any assumption that
"closed months are immutable" is false at the multi-year horizon.

---

## 5. Balanço de energia nos subsistemas

- **Page:** https://dados.ons.org.br/dataset/balanco-energia-subsistema
- **Files:** `.../dataset/balanco_energia_subsistema_ho/BALANCO_ENERGIA_SUBSISTEMA_<YYYY>.csv` (also `.parquet`, `.xlsx`)
- **Grain:** hourly × subsistema. Verified: 24 rows for `SE` on 2026-01-01.
- **Coverage:** 2000 → 2026, yearly files, **all three formats cover the full range** (27 files each).
- **Cadence:** daily 12h/19h (CKAN `Schedule de Atualização`).
- **Cleanest ingest:** Parquet (1.4 MB vs 3.0 MB CSV for 2026).

Schema — [dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/balanco_energia_subsistema_ho/DicionarioDados_Balanco_Energia_Subsistema.json), confirmed against the 2000, 2023 and 2026 files (**identical header in all three — no schema drift, and the PDF changelog records only "Versão 1.0 02-05-2023 Criação"**):

```
id_subsistema     Código do Subsistema da Usina
nom_subsistema    Nome do Subsistema
din_instante      Data de Referência
val_gerhidraulica Geração hidráulica verificada,   MWmed
val_gertermica    Geração térmica verificada,      MWmed
val_gereolica     Geração eólica verificada,       MWmed
val_gersolar      Geração fotovoltaica verificada, MWmed
val_carga         Carga verificada,                MWmed
val_intercambio   Intercâmbio líquido verificado,  MWmed
```

**Two traps specific to this dataset.**

First, `id_subsistema` is **right-padded to three characters** — the literal values in the 2026 CSV
are `` `N  ` ``, `` `S  ` ``, `` `SE ` ``, `` `NE ` ``, `` `SIN` ``. Naive equality against `"SE"`
matches nothing. (The 2000 file is *not* padded — `NE` appears unpadded there — so the padding is
itself inconsistent across vintages.)

Second, the file contains a **`SIN` aggregate row** alongside the four subsystems, which will
double-count if not filtered. Verified on 2026-01-01 00:00:

```
N     carga = 7,622.61      NE  carga = 12,887.23
S     carga = 11,137.52     SE  carga = 41,048.46      -> sum 72,695.82
SIN   carga = 72,695.81                                 <- aggregate, must be excluded
```

Also note `nom_subsistema` for `SE` here is **`SUDESTE/CENTRO-OESTE`**, which differs from the name
used in every other dataset (see the vocabulary table below).

A third trap affects pre-2019 files only: at DST spring-forward this dataset emits a **placeholder
row with empty `val_carga` and `val_intercambio`** for the non-existent local hour (see
[Timezone](#timezone)). Row counts therefore stay at 24 even on a 23-hour day, so any completeness
check must test for non-empty values rather than row presence.

---

## 6 & 7. Carga de energia — verificada and programada

**These two datasets have no bulk files.** Unlike every other dataset in scope, `carga-energia-verificada`
and `carga-energia-programada` expose *only* a data dictionary and a REST API — CKAN
`package_show` returns 3 resources each, of format `PDF`, `API`, `JSON`, and **zero** CSV/Parquet/XLSX.
Confirmed for both slugs. Bulk-download ingestion is not possible; you must page the API.

- **Pages:** https://dados.ons.org.br/dataset/carga-energia-verificada · https://dados.ons.org.br/dataset/carga-energia-programada
- **API base:** `https://apicarga.ons.org.br/prd`
- **Swagger UI:** http://ons-dl-prod-opendata-swagger.s3-website-us-east-1.amazonaws.com (title: "API Carga Global")

The OpenAPI 3.0.1 document is not served at any conventional path (`/swagger.json`, `/v3/api-docs`
etc. all 404 on the UI host and 403 on the API host) — it is **embedded in the SPA JavaScript
bundle** at `/assets/index-94be9fcf.js`, from which it was extracted verbatim. All API facts below
come from that embedded spec plus live calls made on 2026-08-28.

**Authentication: none.** Live unauthenticated calls returned HTTP 200 with data.

### Endpoints

```
GET /cargaverificada   ?dat_inicio=YYYY-MM-DD &dat_fim=YYYY-MM-DD &cod_areacarga=<code>
GET /cargaprogramada   ?dat_inicio=YYYY-MM-DD &dat_fim=YYYY-MM-DD &cod_areacarga=<code>
```

All three parameters are `required: true`. Both endpoints are documented **"Limite de 3 meses por
chamada"**. Coverage per the spec summaries: verificada **"desde 01/01/2016"**, programada
**"desde 05/03/2021"**. Responses: 200 / 400 "Entradas inválidas" / 404 "Dados não encontrados".

### Response schema — verified by live call

`GET /prd/cargaverificada?dat_inicio=2026-08-01&dat_fim=2026-08-01&cod_areacarga=SECO` returned 48
rows (semi-horária confirmed), first row verbatim:

```json
{
  "cod_areacarga": "SECO",
  "din_atualizacao": "2026-08-28T03:19:10.800Z",
  "dat_referencia": "2026-08-01",
  "din_referenciautc": "2026-08-01T03:30:00.000Z",
  "val_cargaglobal": 41637.23,
  "val_cargaglobalcons": 41637.23,
  "val_cargaglobalsmmgd": 41519.25,
  "val_cargasupervisionada": 38118.35,
  "val_carganaosupervisionada": 3400.8977,
  "val_cargammgd": 117.98,
  "val_consistencia": 0
}
```

`GET /prd/cargaprogramada` (same params) also returned 48 rows:

```json
{ "cod_areacarga": "SECO", "dat_referencia": "2026-08-01",
  "din_referenciautc": "2026-08-01T03:30:00.000Z", "val_cargaglobalprogramada": 40992.41 }
```

Field semantics, verbatim from the ONS dictionaries
([verificada](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/carga_verificada_tm/DicionarioDados_Carga_Verificada.json),
[programada](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/carga_programada_tm/DicionarioDados_Carga_Programada.json)) —
all values **MWmed, integralizada no final do intervalo da semi-hora**:

| Field | Meaning |
|---|---|
| `val_cargaglobal` | Carga Global |
| `val_cargaglobalcons` | Carga Global **consistida** (the series ONS feeds to its forecast models) |
| `val_cargaglobalsmmgd` | Carga Global líquida de MMGD |
| `val_cargammgd` | Parcela atendida por micro e minigeração distribuída |
| `val_cargasupervisionada` | Parcela supervisionada pelo ONS (geração tipo I, IIA, IIB, IIC e intercâmbios) |
| `val_carganaosupervisionada` | Parcela do sistema de medição de faturamento da CCEE (geração tipo III) |
| `val_consistencia` | Parcela de consistências (correção de falhas de medida e dias atípicos) |
| `val_cargaglobalprogramada` | (programada) Carga Global Programada |

**Three discrepancies worth recording.**

1. The CKAN JSON dictionary names the field **`val_cargaglobalsmmg`**; the API spec and the **live
   response** both use **`val_cargaglobalsmmgd`** (trailing `d`). The live response is authoritative
   — use `val_cargaglobalsmmgd`.
2. **`din_atualizacao`** (`string`/`date-time`) is returned by `/cargaverificada` and is in the
   OpenAPI schema, but appears in **neither** the JSON nor the PDF data dictionary. This is a genuine
   per-row **vintage marker** and the only one found anywhere in ONS open data — see
   [Ingestion strategy](#ingestion-strategy-implications). `/cargaprogramada` does **not** return it.
3. `cod_areacarga` uses **`SECO`**, not `SE`. Passing `cod_areacarga=SE` returns **HTTP 200 with an
   empty array `[]`** — a silent failure, not a 400. Verified.

### `cod_areacarga` domain (33 values, verbatim from the spec enum)

```
Subsistemas:        SECO (Sudeste/Centro-Oeste), S, NE, N
Áreas geoelétricas: RJ, SP, MG, ES, MT, MS, DF, GO, AC, RO, PR, SC, RS,
                    BASE (Bahia/Sergipe), BAOE (Bahia Oeste), ALPE (Alagoas/Pernambuco),
                    PBRN (Paraíba/Rio Grande do Norte), CE, PI, TON (Tocantins),
                    PA, MA, AP, AM, RR
Perdas:             PESE, PES, PENE, PEN
```

This is a **finer geographic grain than any other dataset in scope** — it decomposes subsystems into
geoelectric areas, which is directly useful for locating curtailment against local load.

### Timestamps — explicitly UTC

Both dictionaries define `din_referenciautc` as *"Data de referência do final do intervalo da
semi-hora, **no fuso horário UTC+0h**"*, and the API description states *"O instante de tempo dos
dados (din_referenciautc) está na timezone UTC (horário de Greenwich)"*. These are the **only two
datasets in scope with an explicitly documented timezone**, and they are the **only two that are
UTC** — everything else uses `din_instante` in Brasília time. See [Timezone](#timezone).

---

## 8. Carga de energia diária

- **Page:** https://dados.ons.org.br/dataset/carga-energia
- **Files:** `.../dataset/carga_energia_di/CARGA_ENERGIA_<YYYY>.csv|.parquet|.xlsx`
- **Grain:** **daily** × subsistema. Coverage 2000 → 2026, all three formats (27 files each).
- **Cadence:** daily 12h/19h.

Schema — [dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/carga_energia_di/DicionarioDados_Carga_Energia_Diaria.json), header identical in the 2000 and 2026 files:

```
id_subsistema           Código do Subsistema
nom_subsistema          Nome do Subsistema
din_instante            Data de referência          (date only: "2026-01-01")
val_cargaenergiamwmed   Carga de Energia, MWmed
```

This dataset is **not** a daily rollup of dataset 6 and must not be treated as one: the CKAN notes
document three distinct definitional regimes, which is a methodology break, not a schema break:

> *Até fevereiro/2021, os dados representam a carga atendida por usinas despachadas e/ou programadas
> pelo ONS... Entre março/2021 e abril/23... mais a previsão de geração de usinas não despachadas
> pelo ONS. **A partir de 29/04/2023**, além dos dados anteriormente considerados, passou a ser
> incorporado o valor estimado da micro e minigeração distribuída (MMGD), com base em dados
> meteorológicos previstos.*

So the series has **level shifts at 2021-03 and 2023-04-29** with no column change to signal them.
`nom_subsistema` here is title-case (`Norte`, `Nordeste`) — different again from datasets 5 and 9.

---

## 9. Intercâmbios entre subsistemas

- **Page:** https://dados.ons.org.br/dataset/intercambio-nacional
- **Files:** `.../dataset/intercambio_nacional_ho/INTERCAMBIO_NACIONAL_<YYYY>.csv|.parquet|.xlsx`
- **Grain:** hourly × directed (origem, destino) pair.
- **Coverage:** CSV/XLSX 2000 → 2026 (27 each). **Parquet only 2023 → 2026 (4 files)** — use CSV for history.
- **Cadence:** daily 12h/19h.

Schema — [dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/intercambio_nacional_ho/DicionarioDados_Intercambio_Nacional.json):

```
din_instante              Data/hora (início do período de agregação)
id_subsistema_origem      Código do Subsistema de Origem
nom_subsistema_origem     Nome do Subsistema de Origem
id_subsistema_destino     Código do Subsistema de Destino
nom_subsistema_destino    Nome do Subsistema de Destino
val_intercambiomwmed      Intercâmbio verificado, MWmed
val_intercambioprogmwmed  Intercâmbio programado, MWmed      [2026 onward only]
```

Note `din_instante` here is documented as **"início do período de agregação"** — the only dataset in
scope where the interval-labelling convention is explicitly stated.

**Schema change — confirmed by header bisection across years:**

```
2023: ...;val_intercambiomwmed
2024: ...;val_intercambiomwmed
2025: ...;val_intercambiomwmed
2026: ...;val_intercambiomwmed;val_intercambioprogmwmed
```

Corroborated by the PDF changelog: *"04-05-2026 Versão 1.2 Inclusão de novo campo chamado
'val_intercambioprogmwmed'"*. Unlike `dsc_restricao` in the constrained-off datasets, this column
was **not backfilled** — 2025 and earlier files still have 6 columns. So the two datasets behave
differently on the same kind of change, and neither behaviour can be assumed.

Subsystem codes in the 2026 file are clean and unpadded (`N`, `NE`, `S`, `SE`), but **`nom_*` values
carry a leading space** (`" NORTE"`, `" SUDESTE"`) — verified by full scan. Only four codes appear;
there is no Itaipu/`IV` node in this dataset. Not all 12 directed pairs are present.

---

## 10 & 11. DESSEM — balanço de energia

Two datasets, both published by ONS as DESSEM *outputs*:

- **Geral:** https://dados.ons.org.br/dataset/balanco_dessem_geral — *"Informação simplificada da programação eletro energética, resultante do modelo DESSEM"*
- **Detalhe:** https://dados.ons.org.br/dataset/balanco_dessem_detalhe — *"...no formato detalhado"*

**Files are split per reference day, not per month or year** — this is the only daily-split scheme in
scope, and it means ~460 resources per dataset and growing:

```
.../dataset/balanco_dessem_geral/BALANCO_DESSEM_GERAL_<YYYY>_<MM>_<DD>.csv|.parquet|.xlsx
.../dataset/balanco_dessem_detalhe/BALANCO_DESSEM_DETALHE_<YYYY>_<MM>_<DD>.csv|.parquet|.xlsx
```

- **Coverage:** 2025-05-23 → 2026-08-28 for both. **No history before 2025-05-23** — this is by far
  the shortest series in scope and is a hard constraint on any DESSEM-conditioned backtest.
- **Cadence:** D-1. The file for reference day 2026-08-28 was created 2026-08-27T17:48 (CKAN
  `created`), i.e. published the evening before the day it describes.
- Files are tiny (~12–17 kB). Neither package carries a `Schedule de Atualização` extra.

Schemas — [geral dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/balanco_dessem_geral/DicionarioDados_Balanco_Dessem_Geral.json), [detalhe dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/balanco_dessem_detalhe/DicionarioDados_Balanco_Dessem_Detalhe.json).

**Geral** (confirmed against `BALANCO_DESSEM_GERAL_2026_08_28.csv`):

```
din_programacaodia      Data de Referência da Programação Diária
num_patamar             Número do Patamar
cod_subsistema          Código do Subsistema
val_demanda             Demanda,                         MW
val_geracao_renovavel   Geração renovável,               MW
val_geracao_hidraulica  Geração hidráulica,              MW
val_geracao_termica     Geração térmica,                 MW
val_cons_elevatoria     Consumo de usina elevatória,     MW
```

**Detalhe** — the published header **does not match the dictionary**. Dictionary says
`val_geracao_hidraulica` and `val_geracao_termica`; the actual file
`BALANCO_DESSEM_DETALHE_2026_08_28.csv` has `val_ger_hidraulica` and `val_ger_termica`. **Trust the
file:**

```
din_programacaodia;num_patamar;cod_subsistema;val_demanda;val_ger_hidraulica;val_ger_pch;
val_ger_termica;val_ger_pct;val_ger_eolica;val_ger_fotovoltaica;val_ger_mmgd;val_cons_elevatoria
```

with `val_ger_pch` (PCH), `val_ger_pct` (PCT), `val_ger_eolica`, `val_ger_fotovoltaica`,
`val_ger_mmgd` — all **MW**, not MWmed. The detalhe dataset is the one WattSteer needs: it is the
only source of a *forward-looking, per-subsystem, semi-hourly wind and solar dispatch expectation*.

**`num_patamar` — mapping to wall-clock time is undocumented but was established empirically.** The
dictionaries and both PDFs define it only as "Número do Patamar" with no time mapping. Verified: the
2026-08-28 geral file has exactly **48 distinct patamares, 1..48**, for each of 4 subsystems
(`N`, `NE`, `S`, `SE`) — 192 rows. Cross-checking `val_demanda` for `SE` against
`/cargaprogramada?cod_areacarga=SECO` for the same day:

| `num_patamar` | DESSEM `val_demanda` | Carga programada `din_referenciautc` | value |
|---|---|---|---|
| 1 | 43,821.06 | 2026-08-28T03:30:00Z | 43,832.49 |
| 2 | 42,487.60 | 2026-08-28T04:00:00Z | 42,497.04 |
| 3 | 41,290.58 | 2026-08-28T04:30:00Z | 41,297.13 |
| 4 | 40,360.01 | 2026-08-28T05:00:00Z | 40,366.26 |

Agreement to within 0.03%. So **`num_patamar` = k corresponds to the half-hour ending at
00:00 + k×30 min Brasília time** on `din_programacaodia`; patamar 1 is 00:00–00:30 BRT. This is an
empirical inference from a single day, not documented by ONS — treat it as high-confidence but
verify at DST-free year boundaries if it becomes load-bearing.

Note the subsystem code here is **`SE`** while the carga API calls the same subsystem **`SECO`**.

**Scope limit:** these are DESSEM *result balances*. The DESSEM **input decks** (the model's
entrada/saída files proper) are **not** on dados.ons.org.br — no package in the full 84-package
`package_list` corresponds to them. See **Open questions**.

Adjacent and relevant: **`cmo-semi-horario`** (https://dados.ons.org.br/dataset/cmo-semi-horario) is
the DESSEM shadow price, *"estimado pelo modelo DESSEM para cada barra do sistema em base
semi-horária"*, yearly files **2020 → 2026** — far longer history than the DESSEM balances. Schema
(confirmed against `CMO_SEMIHORARIO_2026.csv`): `id_subsistema;nom_subsistema;din_instante;val_cmo`,
`val_cmo` in **R$/MWh**. Also **`programacao_diaria`** gives semi-horária *per-usina* programmed
generation with `val_geracaoprogramada`, `val_disponibilidade`, `val_razaoeletrica` and
`val_ordemmerito` (all MWmed) — the plant-level counterpart to the DESSEM subsystem balance.

---

## 12. Capacidade instalada de geração

- **Page:** https://dados.ons.org.br/dataset/capacidade-geracao
- **Files:** `.../dataset/capacidade-geracao/CAPACIDADE_GERACAO.csv|.parquet|.xlsx` — **a single
  file, overwritten in place**, no per-year split.
- **Cadence:** daily 12h/19h. `Last-Modified` 2026-08-28T15:00:54 GMT at time of writing.

Schema — [dictionary](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/capacidade-geracao/DicionarioDados_Capacidade_Instalada_Geracao.json), confirmed against the live CSV:

```
id_subsistema          Código do Subsistema da Usina
nom_subsistema         Nome do Subsistema
id_estado              Sigla do Estado
nom_estado             Nome do Estado
nom_modalidadeoperacao Modalidade de Operação        e.g. "TIPO I"
nom_agenteproprietario Agente Proprietário
nom_agenteoperador     Agente Operador
nom_tipousina          EOLIELÉTRICA | FOTOVOLTAICA | HIDROELÉTRICA | NUCLEAR | TÉRMICA
nom_usina              Nome da Usina
ceg                    Código Único do Empreendimento de Geração (ANEEL)
nom_unidadegeradora    Nome da Unidade Geradora
cod_equipamento        Código do Equipamento – Unidade Geradora     [added 2024-04-12]
num_unidadegeradora    Código Operacional da Unidade Geradora
nom_combustivel        Combustível
dat_entradateste       Data da Liberação para Entrada em Comissionamento
dat_entradaoperacao    Data da Liberação para Entrada em Operação Comercial
dat_desativacao        Data de Desativação — NULL/vazio = unidade ativa
val_potenciaefetiva    Potência Nominal da Unidade Geradora (norma ANEEL), MW
id_ons                 Identificador da usina                       [added 2026-01-26]
```

**The grain is the *unidade geradora* (individual turbine/inverter block), not the usina.** Verified
by full scan of the live file:

| `nom_tipousina` | rows (unidades) | distinct `ceg` | active capacity (MW) |
|---|---|---|---|
| EOLIELÉTRICA | 2,152 | 1,058 | 33,719 |
| FOTOVOLTAICA | 1,228 | 560 | 22,203 |
| HIDROELÉTRICA | 819 | 180 | — |
| TÉRMICA | 1,467 | 244 | — |
| NUCLEAR | 2 | 2 | — |

(Active capacity = sum of `val_potenciaefetiva` where `dat_desativacao` is empty.) Aggregate to
usina via `ceg` before joining to anything.

**Capacity normalisation over time is possible despite the CKAN note.** The package notes say
*"Estes dados não possuem informações históricas"*, which is true of the *file* — it is a snapshot,
and yesterday's version is unrecoverable once overwritten. But the **rows carry
`dat_entradaoperacao` and `dat_desativacao` per generating unit**, so an as-of-date installed
capacity series can be reconstructed from a single current snapshot by filtering
`dat_entradaoperacao <= t < coalesce(dat_desativacao, ∞)`. This is exactly what capacity-weighted
weather aggregation and capacity normalisation need, and it means the missing history is not
blocking. The caveat is that it reflects *today's* record of the past — retroactive corrections to
`dat_entradaoperacao` are invisible unless you snapshot the file yourself daily.

**Scope caveat:** the dictionary is explicit that this covers only *"Unidades Geradoras de Usinas
despachadas pelo ONS... modalidade de operação Tipo I, Tipo II-A, Tipo II-B e Tipo II-C"* — Tipo III
and distributed generation are excluded. Since the constrained-off datasets also cover only Tipo I,
II-B and II-C, the two are compatible in scope.

Changelog (PDF): 1.0 2022-08-17 · 1.1 2023-04-28 layout · 1.2 2023-05-01 quality metadata · **1.3
2024-04-12 added `cod_equipamento`** · 1.4 2024-08-26 and 1.5 2025-04-11 restricted to the five
plant types · **1.6 2026-01-26 added `id_ons`**.

### The "Relação de empreendimentos" dataset does not exist on this portal

CKAN `package_search?q=empreendimento` returns **count 0**, and the full 84-entry `package_list`
contains no registry dataset of that name. The registry role the brief describes (CEG codes,
subsystem, state, capacity, entry-into-operation date) is filled by **`capacidade-geracao`**, which
carries all five attributes. Two companion datasets complete the registry picture:

**`usina_conjunto`** — https://dados.ons.org.br/dataset/usina_conjunto — *"Histórico de relação das
usinas Tipo II-C que compõem os Conjuntos de Usina"*. **This is the join table that makes the
constrained-off datasets usable**, and it is effectively SCD2:

```
id_subsistema; nom_subsistema; estad_id; nom_estado; id_tipousina; nom_tipousina;
id_conjuntousina; id_ons_conjunto; id_ons_usina; nom_conjunto; nom_usina; ceg;
dat_iniciorelacionamento; dat_fimrelacionamento
```

`id_ons_conjunto` carries values like `CJU_MAPLN` — exactly the `id_ons` values in the entity-grain
constrained-off files — and `id_ons_usina` (`MAEDT1`) matches the `id_ons` in the `_detail` files.
Note the field is `estad_id`, not `id_estado`, in this dataset alone. Despite the CKAN note claiming
no historical information, `dat_iniciorelacionamento`/`dat_fimrelacionamento` make plant-to-conjunto
membership time-resolvable.

**`modalidade-usina`** — https://dados.ons.org.br/dataset/modalidade-usina — `nom_usina; ceg;
nom_modalidadeoperacao; val_potenciaautorizada; sgl_centrooperacao; nom_pontoconexao; id_estado;
nom_estado; sts_aneel; id_ons`, where `sts_aneel` ∈ `A` (ativo), `I` (inativo), `P` (previsto),
`C` (cancelado), `O` (outros). Includes Tipo III plants, unlike `capacidade-geracao`.

---

## Cross-dataset join concerns

### The constrained-off grain problem

This is the central modelling constraint. The reason codes WattSteer needs exist **only** at the
entity grain, and the per-plant weather/generation data exists **only** at the plant grain, and the
two datasets do not share a row key:

| | reason code | reference generation | per-plant wind/irradiance | row key |
|---|---|---|---|---|
| `restricao_coff_*` (entity) | ✅ | ✅ | ❌ | `id_ons` = `CJU_*` for Tipo II-C, plant code otherwise |
| `restricao_coff_*_detail` | ❌ | ❌ | ✅ | `id_ons` = plant code always |

For Tipo I and Tipo II-B plants the two join directly on `id_ons` (and `ceg`). For **Tipo II-C
plants — 93% of wind rows in 2026-08** — the entity file gives a conjunto-level reason and the
detail file gives plant-level physics, and bridging them requires `usina_conjunto`
(`id_ons_conjunto` ↔ `id_ons_usina`). **Any per-plant attribution of curtailment reason for Tipo
II-C is therefore an allocation, not an observation** — the reason is genuinely only known at
conjunto level. This should be explicit in the data model rather than hidden behind a join.

Convenient cross-check: the `_detail` files carry `nom_modalidadeoperacao` and `nom_conjuntousina`
directly, so the modality and conjunto of each plant can be read without joining, even though the
reason cannot.

### Subsystem code vocabulary — genuinely inconsistent

Confirmed by full-file scans, not assumed. **There is no single subsystem vocabulary across ONS
datasets**; normalise on ingest.

| Dataset | Code for Sudeste/CO | Other codes | `nom_*` rendering | Notes |
|---|---|---|---|---|
| `balanco-energia-subsistema` | `` `SE ` `` (padded) | `` `N  ` ``, `` `S  ` ``, `` `NE ` ``, `` `SIN` `` | `SUDESTE/CENTRO-OESTE` | padded to 3 chars; **extra `SIN` aggregate row** |
| `intercambio-nacional` | `SE` | `N`, `NE`, `S` | `" SUDESTE"` (leading space) | no `SIN` |
| `carga-energia` (diária) | `SE` | `N`, `NE`, `S` | `Sudeste` (title case) | |
| `restricao_coff_*` | `SE` | `N`, `NE`, `S` | `SUDESTE` | |
| `balanco_dessem_*` | `SE` | `N`, `NE`, `S` | (no `nom_` column) | |
| **carga API (6 & 7)** | **`SECO`** | `S`, `NE`, `N` + 25 area/loss codes | (no `nom_` column) | **`SE` silently returns `[]`** |

So the answer to the brief's question is: the codes are `SE`/`S`/`NE`/`N` **everywhere except the
carga API**, which uses `SECO`; and `balanco-energia-subsistema` pads them to width 3 and adds
`SIN`. The `SECO` mismatch is the dangerous one because it fails silently with HTTP 200.

### Temporal grain mismatches

Four grains must be reconciled:

| Grain | Datasets |
|---|---|
| 30 min | constrained-off (all 4), carga verificada/programada, DESSEM (via `num_patamar`), CMO |
| hourly | balanço de energia, intercâmbio |
| daily | carga de energia diária |
| snapshot | capacidade-geracao, modalidade-usina, usina_conjunto |

Constrained-off is semi-horária but balanço and intercâmbio are horária, so **the primary curtailment
signal is twice as fine as the system context it must be explained by**. Downsampling constrained-off
to hourly (mean of MWmed, since MWmed averages cleanly) is the lossless direction; upsampling balanço
is not.

### Interval labelling — start vs end

**These conventions differ and the difference is exactly one half-hour**, which is enough to
systematically misalign curtailment against load:

- `intercambio-nacional`: documented as **"início do período de agregação"**.
- Constrained-off and `balanco-energia-subsistema`: the first row of a period is `00:00:00`
  (verified: `RESTRICAO_COFF_EOLICA_2026_08.csv` begins `2026-08-01 00:00:00`, then `00:30:00`,
  `01:00:00`; `BALANCO_ENERGIA_SUBSISTEMA_2026.csv` begins `2026-01-01 00:00:00`) — **start-of-interval**.
  Independently confirmed for `balanco` by lag analysis against the explicitly-UTC carga series: hour
  *t* aligns with the UTC semi-hour ends at *t*+3:30 and *t*+4:00, i.e. the local interval *(t, t+1h]*.
- Carga API (6 & 7): documented as **"final do intervalo da semi-hora"**, and the first row of local
  day 2026-08-01 is `2026-08-01T03:30:00Z` = 00:30 BRT — **end-of-interval**.
- DESSEM `num_patamar`: aligns 1:1 with the carga API series (table above), so it is
  **end-of-interval** too.

Result: constrained-off half-hour labelled `10:00` covers 10:00–10:30, while carga labelled
`13:00Z` (=10:00 BRT) covers **09:30–10:00**. Normalise every series to a single convention
(start-of-interval is the safer canonical choice) before joining.

### Timezone

**Verdict: `din_instante` is Brasília *local civil time* — DST-aware before 2019, effectively fixed
UTC−3 from 2019-02-17 onward. `din_referenciautc` is UTC. Neither fact about `din_instante` is
documented by ONS anywhere; it is established empirically.**

- **Documented for datasets 6 and 7 only.** `din_referenciautc` is defined in both ONS dictionaries
  as *"no fuso horário UTC+0h"*, and the PDF dictionary's *format* column gives it as
  `YYYY-MM-DDTHH:MM:SSZ` — with an explicit `Z` designator. Live responses carry the `Z`.
- **`din_instante` carries no documented timezone in any dataset.** Checked and found nothing: the
  JSON dictionaries for all 12 datasets; the PDF dictionaries (extracted with `pypdf` and read in
  full) for `balanco_energia_subsistema_ho`, `intercambio_nacional_ho` and `restricao_coff_eolica_tm`
  — these give the format as `YYYY-MM-DD HH:MM:SS` with **no zone designator**, which is itself an
  indirect documented contrast against the `...Z` format of `din_referenciautc`; the CKAN `notes` and
  `extras` of every package (the only `fuso|UTC|Brasília` matches are boilerplate org address text);
  and the embedded OpenAPI spec (**zero** occurrences of "fuso").
- **Empirically UTC−3 in the modern era**, established two independent ways. (i) The DESSEM/carga
  cross-check above: DESSEM `num_patamar` 1 on 2026-08-28 matches the carga value stamped
  `2026-08-28T03:30:00Z`, an offset of exactly −3 h. (ii) Cross-correlating `balanco` SE `val_carga`
  against the explicitly-UTC `cargaverificada` SECO series over June 2024 gives a best lag of **+3 h**
  (r = 0.9975, dropping to ~0.954 at ±1 h). A sanity check on solar shape agrees: SE mean
  `val_gersolar` by `din_instante` hour in 2024 peaks at **hour 11**, consistent with solar noon at
  UTC−3 and inconsistent with a UTC reading (which would peak at 14–15).
- **But `din_instante` was DST-aware before 2019, and this materially damages pre-2019 history.**
  The same lag scan run per-day pins the offset flips exactly on the dates prescribed by Decreto
  6.558/2008 (as amended by 9.242/2017 — *"primeiro domingo de novembro... até o terceiro domingo de
  fevereiro"*):

  ```
  2018-02-13..17  UTC−2        2018-10-30..11-03  UTC−3        2019-02-12..16  UTC−2
  2018-02-18..23  UTC−3        2018-11-04..09     UTC−2        2019-02-17..22  UTC−3
  ```

  (all correlations ≥ 0.998 at the winning lag). Brazil abolished *horário de verão* by **Decreto nº
  9.772, de 25 de abril de 2019** (ementa *"Encerra a hora de verão no território nacional"*, DOU
  26-04-2019; confirmed via [LexML](https://www.lexml.gov.br/urn/urn:lex:br:federal:decreto:2019-04-25;9772)
  and [MME](https://www.gov.br/mme/pt-br/assuntos/secretarias/secretaria-nacional-energia-eletrica/horario-de-verao)).
  The last DST period ended **2019-02-17**, so no transition has occurred on or after that date.

- **The DST transitions are handled lossily, and differently per dataset.** At spring-forward
  (2018-11-04) the non-existent local hour 00 is *absent* from `INTERCAMBIO_NACIONAL_2018.csv` (23
  rows — the only non-24-row day in the file), whereas `BALANCO_ENERGIA_SUBSISTEMA_2018.csv` emits a
  **placeholder row with empty values**:

  ```
  SE;SUDESTE/CENTRO-OESTE;2018-11-04 00:00:00;0E-8;0E-8;0E-8;0E-8;;      <- val_carga, val_intercambio empty
  SE;SUDESTE/CENTRO-OESTE;2018-11-04 01:00:00;29274.58299999;4405.44100000;...
  ```

  So **counting rows is not a valid DST test for `balanco`** — every day of 2018 has 24 rows; only
  counting rows with non-empty `val_carga` reveals the 23. At fall-back (2018-02-18) the duplicated
  local hour is **silently dropped**, not disambiguated — 24 rows, hours `00..23`. **Pre-2019
  timestamps are therefore genuinely ambiguous and one hour per year is unrecoverable.**

- **`din_instante` labels the START of the interval**, confirmed independently by this analysis: the
  +3 h alignment matched `balanco` hour *t* against the UTC semi-hour *ends* at *t*+3:30 and *t*+4:00,
  i.e. the local interval *(t, t+1h]*. This is the opposite convention from `din_referenciautc`,
  which the dictionary explicitly defines as the **end** of the semi-hour.

**Practical rules.**

1. Parse `din_instante` as `America/Sao_Paulo` (a full IANA zone, **not** a fixed −3 offset) whenever
   the data may predate 2019-02-17; a fixed UTC−3 is safe only for 2019-02-17 onward.
2. Parse `din_referenciautc` as UTC; store everything as UTC instants internally.
3. The constrained-off datasets (1–4) begin at 2021-10 and 2024-04, **entirely after the last DST
   transition** — they can safely be treated as fixed UTC−3. The DST hazard is confined to datasets
   5, 8 and 9, which reach back to 2000 and thus carry ~19 years of shifted data with one missing
   hour each November and one silently-dropped duplicate hour each February.
4. Reject or flag, rather than interpolate, the empty-valued DST placeholder rows in `balanco`.

### Other join hazards

- **String padding and stray whitespace** appear unpredictably: `id_subsistema` right-padded in
  `balanco-energia-subsistema` (2026 but not 2000); `nom_subsistema` left-padded in
  `intercambio-nacional`; `nom_subsistema`, `cod_equipamento`, `num_unidadegeradora`,
  `nom_tipousina` and `sgl_centrooperacao` all right-padded in `capacidade-geracao` /
  `usina_conjunto` / `modalidade-usina`. **Trim every string column on ingest, unconditionally.**
- **`ceg` is not a universal key.** It is `"-"` for all conjunto rows in the entity-grain
  constrained-off datasets (184,032 of 198,311 rows in 2026-08). `id_ons` is the more reliable join
  key across ONS datasets; `ceg` is the bridge to ANEEL.
- **Boolean encoding differs** between the wind (`0.0`/numeric) and solar (`False`/boolean) `_detail`
  datasets, permanently.
- **`SIN` rows** in `balanco-energia-subsistema` must be filtered before any subsystem-level sum.

---

## Ingestion strategy implications

### CKAN supports incremental fetch, and its `last_modified` is trustworthy

`package_show?id=<slug>` returns, per resource: `format`, `name`, `url`, `size`, `created`, and
`last_modified`. Comparing CKAN's `last_modified` against the S3 object's `Last-Modified` header for
five `restricao_coff_eolica_usi` CSVs spanning 2021–2026:

```
2021-10  CKAN 2024-05-22T22:12:15  |  S3 Wed, 22 May 2024 22:12:12 GMT
2023-01  CKAN 2024-01-02T15:13:31  |  S3 Tue, 02 Jan 2024 15:13:28 GMT
2025-01  CKAN 2026-05-04T15:15:50  |  S3 Mon, 04 May 2026 15:14:52 GMT
2026-07  CKAN 2026-08-28T15:10:56  |  S3 Fri, 28 Aug 2026 15:09:55 GMT
2026-08  CKAN 2026-08-28T15:09:24  |  S3 Fri, 28 Aug 2026 15:08:30 GMT
```

CKAN lags S3 by seconds to ~1 minute and is effectively UTC (the field has no timezone suffix — treat
as UTC, inferred from this comparison, not documented). **One `package_show` call per dataset is
enough to decide what to re-download**, so full-catalogue polling costs 15 cheap requests.

Caveat: `last_modified` is **not populated on every resource**. Coverage measured across CSV
resources:

```
balanco-energia-subsistema           27/27
carga-energia                        27/27
restricao_coff_eolica_usi            59/59
restricao_coff_eolica_detail         59/59
restricao_coff_fotovoltaica          29/29
restricao_coff_fotovoltaica_detail   29/30
intercambio-nacional                 12/27     <- 15 CSVs have last_modified = null
balanco_dessem_geral                 77/461    <- most are null
balanco_dessem_detalhe               75/459    <- most are null
```

Where `last_modified` is null, `created` is still present. For the DESSEM datasets — where files are
immutable-by-construction daily snapshots — null `last_modified` is fine. For `intercambio-nacional`
it means CKAN alone cannot tell you whether a pre-2012 year changed.

### The authoritative revision detector is an S3 `HEAD`

Every file responds to `HEAD` with the fields needed for change detection. Verified:

```
Last-Modified: Fri, 28 Aug 2026 15:08:30 GMT
ETag: "69a67d7634c320dba5ac8a3533af1b8f-6"
Content-Length: 28951839
Accept-Ranges: bytes
```

`Accept-Ranges: bytes` also means header rows can be read with `curl -r 0-1200` without pulling a
171 MB file — used throughout this document.

**There is no version or vintage marker.** No `x-amz-version-id` header is returned on any object,
so the bucket does not expose versioning and **prior vintages are unrecoverable**. Revised files are
re-published under the **same filename**. The `ETag` is a strong content fingerprint for
single-part uploads (plain MD5) but is multipart-suffixed for large files (`-6` above), where it is
a hash-of-hashes that depends on part size — so ETag equality is reliable for "unchanged", while
ETag inequality across a re-upload with different part sizing could theoretically differ without a
content change. Use the triple `(Last-Modified, Content-Length, ETag)` as the change key and treat
any difference as "re-download and diff".

### What this means for bitemporal storage

1. **Revisions are detectable but not describable.** You can always tell *that* a file changed; you
   can never ask ONS *what* changed or retrieve the version you previously ingested. **WattSteer must
   be the sole custodian of its own history** — every downloaded file (or its content hash plus the
   parsed rows) must be retained as the record of what was known at ingest time. There is no
   recovering it later.
2. **`valid_time` vs `transaction_time` are genuinely independent here, at multi-year distance.** The
   October 2021 constrained-off file was rewritten in May 2024; the whole of 2025 was rewritten in
   April–May 2026. A backtest asking "what did we believe about October 2021 as of mid-2023?" is
   answerable only from your own archive. Given a curtailment decision engine's exposure to exactly
   this question, this is the strongest argument for the bitemporal design.
3. **Refresh policy should be tiered**, matching the observed regimes:
   - Current and previous month: re-fetch on every cycle (they change constantly).
   - Months closed within the last ~2 months: weekly `HEAD`.
   - All closed history: `HEAD` sweep monthly — cheap (one `package_show` per dataset), and it is
     the only way to catch bulk re-publication campaigns, which are the highest-impact revisions
     because they silently restate years of settled data.
4. **Whole-file download and row-diff is unavoidable for the bulk datasets.** There is no delta API
   and no per-row timestamp. Practical mitigations: prefer Parquet (roughly 10× smaller than CSV —
   3.3 MB vs 29 MB for wind entity, 10 MB vs 171 MB for wind `_detail`), and fall back to CSV only
   for the pre-2023 wind history where Parquet is absent. Use `Content-Length` as a cheap
   first-pass change signal before downloading.
5. **The carga API is the one exception, and the one place with a real vintage marker.**
   `/cargaverificada` returns **`din_atualizacao`** per row — a genuine transaction-time stamp from
   ONS, allowing revision detection at row rather than file granularity, and allowing you to
   distinguish an ONS restatement from your own re-ingest. It is undocumented in the data
   dictionaries (found only in the OpenAPI spec and live responses), so treat it as
   observed-not-guaranteed. **`/cargaprogramada` does not return it** — programada revisions are
   detectable only by diffing values.
6. **Schema evolution must be handled per-file, not per-dataset.** Two different behaviours were
   observed for the same class of change: `dsc_restricao` was **backfilled** into older
   constrained-off files (so an old file's schema changed retroactively), while
   `val_intercambioprogmwmed` was **not** backfilled (2025 files still have 6 columns). Read the
   header of every file on every ingest and reconcile to a superset schema; never cache "the schema
   for month M".
7. **Read resource URLs from CKAN; never construct them.** The S3 path segment differs from the slug,
   filenames are irregular (`CMO_SEMIHORARIO` vs `CMO_SEMI_HORARIO`), and some older resources sit on
   a different regional S3 host.

---

## Open questions / could not confirm

1. **Documented timezone for `din_instante` — confirmed absent, not merely unfound.** Searched
   exhaustively and found no ONS primary source anywhere stating it: the JSON dictionaries for all 12
   datasets; the PDF dictionaries extracted in full with `pypdf`; the CKAN `notes` and `extras` for
   every package; the embedded OpenAPI spec (zero occurrences of "fuso"). There is **no open-data
   FAQ or "sobre" page on dados.ons.org.br addressing fuso horário**. No ONS *Procedimentos de Rede*
   submodule stating the convention was located either (ons.org.br search was unproductive). The
   UTC−3 / DST-aware conclusion in [Timezone](#timezone) is therefore **entirely empirical** —
   high-confidence (multiple independent methods, correlations ≥ 0.998, transition dates matching the
   decree exactly) but formally undocumented. It could change without notice.
2. **Verbatim article text of Decreto 9.772/2019.** Not confirmed — planalto.gov.br returned
   `ECONNRESET` on every attempt (both `D9772.htm` and `d9772.htm`), and the Câmara `legin` page
   serves metadata only. The decree's identity, ementa (*"Encerra a hora de verão no território
   nacional"*), publication date (DOU 26-04-2019) and the fact that it revokes Decreto 6.558/2008 as
   amended by 9.242/2017 **are** confirmed, via LexML and MME. Only the Art. 1º/2º wording is
   unverified — immaterial to the data conclusion, since the last transition (2019-02-17) is
   independently confirmed by the empirical offset scan.
3. **`num_patamar` → wall-clock mapping is inferred, not documented.** ONS defines it only as "Número
   do Patamar" in both the JSON and PDF dictionaries. The mapping (patamar k = half-hour ending
   00:00 + k×30 min BRT) rests on a single-day numerical match against `/cargaprogramada`. Not
   confirmed: whether the mapping is stable across all days, and specifically what happens on a day
   with anything other than 48 patamares. Only 2026-08-28 was checked in detail.
4. **DESSEM input decks (entrada/saída) are not on dados.ons.org.br.** Confirmed absent: the full
   `package_list` (84 packages) contains only `balanco_dessem_geral`, `balanco_dessem_detalhe`,
   `programacao_diaria` and `cmo-semi-horario` as DESSEM-related, all of which are *results*, not
   model decks. Where the decks are actually published (ONS Sintegre, which requires authentication,
   is the likely answer) was **not** investigated and is unconfirmed.
5. **Whether `PAR` ever appears in `cod_razaorestricao`.** Documented in the dictionary since
   2024-04-11 but observed zero times across five full months scanned (2025-03, 2025-11, 2026-04,
   2026-08 wind; 2026-04 solar). A full-history scan was not run.
6. **`val_ventoverificado` units.** ONS documents "m3/s", which is dimensionally wrong for wind
   speed. Observed magnitudes (5–7) are consistent with m/s. Not confirmed from any ONS source that
   corrects the error.
7. **`val_geracao_hidraulica` vs `val_ger_hidraulica` in DESSEM detalhe.** The dictionary and the
   file disagree. Confirmed the *file* uses `val_ger_*`; **not** confirmed whether the dictionary is
   stale or the file header changed at some point — only the 2026-08-28 file was header-checked, so
   an earlier rename cannot be excluded.
8. **CKAN `last_modified` timezone.** No timezone suffix on the field and no documentation found.
   Inferred to be UTC from the seconds-level agreement with S3 `Last-Modified` (which is GMT) across
   five samples. Not confirmed.
9. **Exact first available date for constrained-off solar.** The earliest resource is
   `2024-04`, and `restricao_coff_fotovoltaica_detail` has 30 CSV files versus 29 for
   `restricao_coff_fotovoltaica` — an off-by-one that was not investigated. Whether either dataset
   has a partial first month was not checked.
10. **Whether `dsc_restricao` was backfilled to pre-2025 months.** Confirmed present from 2025-01 and
    absent in 2024-12. Not confirmed whether ONS intends to extend it further back in a future
    re-publication campaign — given the observed backfill behaviour, this should be assumed possible.
11. **Rate limits / usage policy on `apicarga.ons.org.br`.** The 3-month-per-call limit is
    documented, but no rate limit, quota, or acceptable-use statement was found. The API is
    unauthenticated; sustained polling behaviour is untested.
12. **The carga API emits malformed JSON for some older data.** Observed during the timezone
    analysis: responses for older ranges contain `"val_cargammgd": ,` — a missing value, which is
    invalid JSON and will break a strict parser. The 2026 responses used in this document parsed
    cleanly. **Not confirmed**: from which date the defect starts, which fields are affected, or
    whether it also affects `/cargaprogramada`. A tolerant/repairing parser is required for
    historical backfill, and this should be characterised before relying on pre-2025 carga data.

---

## Addendum — the `_detail` files, resolved and corrected during ingest (ticket 03)

Established by full scans of `RESTRICAO_COFF_EOLICA_DETAIL_2026_08.csv` (1 365 984 rows),
`RESTRICAO_COFF_EOLICA_DETAIL_2021_10.csv` (1 084 896), `RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2026_08.csv`
(710 640) and `RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2024_04.csv` (478 464), on **2026-08-28**. Fixture
evidence for each is in `apps/api/test/fixtures/ons/FIXTURES.md`.

**The unit correction, recorded.** `val_ventoverificado` is documented "em m3/s"; a volumetric flow
rate cannot describe the wind driving a turbine, and every observed value is an ordinary surface
wind speed. WattSteer reads and stores the column as **m/s** — the database column is
`plant_detail_hour.measured_wind_speed_ms`, and the correction is declared in code as
`MEASURED_WIND_SPEED_UNIT_CORRECTION` with `conversionFactor: 1`. The factor is 1 deliberately: the
*label* is wrong, not the values, so scaling anything would invent data. This closes open question 6
for ingestion purposes; it remains unconfirmed against any ONS source that corrects the error.

**Open question 9 is resolved.** The 30-versus-29 CSV count for
`restricao_coff_fotovoltaica_detail` is not an extra month. `package_show` returns
`RESTRICAO_COFF_FOTOVOLTAICA_DETAIL_2024_09.csv` **twice** — two resource ids, the same URL,
created 2024-10-04 and 2024-09-03, recording different `size` values (67 028 501 and 66 254 356) and
one with a null `last_modified`. Both datasets cover 2024-04 → 2026-08 inclusive, 29 months. Because
the month selector matches on the URL basename it takes the first and is deterministic, and because
`published_at` comes from the S3 `HEAD` rather than from CKAN, the null `last_modified` is harmless.

**Four facts the survey did not record, all of which change the schema:**

1. **The `_detail` files contain no conjunto rows at all** — 0 of 1 365 984 wind rows and 0 of
   710 640 solar rows begin `CJU_`, and `ceg` is populated on every row with no `"-"` anywhere.
   These are genuinely per-usina, which is what makes them safe to key on `ons_plant_code` and what
   makes them the only source in scope that puts `id_ons` and `ceg` on one row for an individual
   plant. `capacidade-geracao` has no `id_ons` at all, so this is the identity bridge.
2. **ONS publishes one plant-half-hour twice, with different values.** `MGJCN` appears twice for all
   48 half-hours of 2024-04-13, differing in `val_geracaoestimada` and `val_geracaoverificada`. This
   is not a revision — a revision arrives in a later file — so both copies are rejected.
3. **Every measure can be empty, and the measurement pair empties together.** 117 209 rows of the
   2021-10 wind file publish no estimate; 480 publish neither wind speed nor flag (336 of those
   publish nothing at all, 144 an estimate only). No row in 1 084 896 blanks the measurement without
   also blanking its flag, which is what makes the pair a single value object.
4. **Negative irradiance is real and is flagged valid.** 3 069 rows of the 2024-04 solar file read
   between −1 and −2 W/m² at night with `flg_dadoirradianciainvalido = False`. A pyranometer offset,
   stored as published.

**The boolean-dialect finding is confirmed at scale**, not merely on the first row: the 2026-08 wind
file uses only `0.0` (1 229 489) and `1.0` (136 495), and the 2026-08 solar file only `False`
(603 206) and `True` (107 434).
