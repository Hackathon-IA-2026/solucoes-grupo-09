# ONS fixtures

Real captured payloads, not hand-written approximations. Every one was fetched
from the live source on the capture date below and is committed byte-for-byte
(the CSV files as a contiguous line range of the real file, noted per entry).

Recapture with `curl`; the URLs come from `package-show-…json` and are never
constructed.

| File | Captured | Source | Notes |
|---|---|---|---|
| `package-show-balanco-energia-subsistema.json` | 2026-08-28 | `https://dados.ons.org.br/api/3/action/package_show?id=balanco-energia-subsistema` | Whole response, unedited. 27 CSV + 27 PARQUET + 27 XLSX resources. |
| `BALANCO_ENERGIA_SUBSISTEMA_2026.head.csv` | 2026-08-28 | `.../balanco_energia_subsistema_ho/BALANCO_ENERGIA_SUBSISTEMA_2026.csv` | Header + first 25 rows (5 hours × 5 codes). Padded `id_subsistema`, `SIN` aggregate row. |
| `BALANCO_ENERGIA_SUBSISTEMA_2000.head.csv` | 2026-08-28 | `.../BALANCO_ENERGIA_SUBSISTEMA_2000.csv` | Header + first 25 rows. **Unpadded** codes, `0E-8` zeros, empty wind/solar on the `SIN` rows. |
| `BALANCO_ENERGIA_SUBSISTEMA_2018.dst-gap.csv` | 2026-08-28 | `.../BALANCO_ENERGIA_SUBSISTEMA_2018.csv` lines 1, 36837–36850 | Spring forward, 2018-11-04: the local hour 00 never existed and ONS emits placeholder rows for it anyway. |
| `BALANCO_ENERGIA_SUBSISTEMA_2018.dst-overlap.csv` | 2026-08-28 | `.../BALANCO_ENERGIA_SUBSISTEMA_2018.csv` lines 1, 5757–5771 | Fall back, 2018-02-18: the duplicated local hour is silently dropped rather than disambiguated. |
| `BALANCO_ENERGIA_SUBSISTEMA_2026.parquet` | 2026-08-28 | `.../BALANCO_ENERGIA_SUBSISTEMA_2026.parquet` | Whole file, 1.4 MB, 28 560 rows. `din_instante` is INT96. |
| `head-BALANCO_ENERGIA_SUBSISTEMA_2026.parquet.json` | 2026-08-28 | S3 `HEAD` of the file above | The change-detection triple. Note the absence of `x-amz-version-id`: ONS exposes no object versioning. |

## Constrained-off, entity grain (ticket 02)

Captured **2026-08-28** from `dados.ons.org.br`, real bytes, unedited except for
selecting rows. Each pins a finding that is invisible in the code.

| File | Source | Pins |
| --- | --- | --- |
| `RESTRICAO_COFF_EOLICA_2024_12.head.csv` | `restricao_coff_eolica_tm`, first 5 data rows | The pre-drift header: **15 columns, no `dsc_restricao`** |
| `RESTRICAO_COFF_EOLICA_2025_01.head.csv` | same dataset, first 5 data rows | The post-drift header: **16 columns**. The dictionary only gained the column in 2025-09 — ONS backfilled it into this already-closed month |
| `RESTRICAO_COFF_EOLICA_2026_08.restricted.csv` | header + a wrapped row + two `ENE` rows | A `dsc_restricao` value containing a **newline**, so one logical row spans two physical lines; plus real `CNF`/`LOC` and `ENE`/`SIS` causes |
| `RESTRICAO_COFF_FOTOVOLTAICA_2026_08.head.csv` | `restricao_coff_fotovoltaica_tm` | That solar shares the wind schema exactly |

The wrapped row is the important one. In the full August 2026 wind file, 12
physical lines carry an unbalanced quote and 7 have a field count other than 16.
A newline-splitting CSV parser emits those as short, misaligned rows — plausible
data rather than an error.

## Carga API, half-hourly load (ticket 07)

Captured **2026-08-28** from `https://apicarga.ons.org.br/prd`. Whole responses,
byte-for-byte, unedited — including their irregular indentation and the missing
values in the 2018 one. The API is unauthenticated; no headers are required.

Recapture with, for example:

```
curl -s 'https://apicarga.ons.org.br/prd/cargaverificada?dat_inicio=2026-08-01&dat_fim=2026-08-01&cod_areacarga=SECO'
```

| File | Source | Pins |
| --- | --- | --- |
| `carga-verificada-SECO-2026-08-01.json` | `/cargaverificada`, `SECO`, 2026-08-01 | 48 rows — semi-horária. The UTC `din_referenciautc` running `03:30Z` → `2026-08-02T03:00Z`, i.e. **end**-labelled; the live `val_cargaglobalsmmgd` spelling; `din_atualizacao` on every row |
| `carga-verificada-SECO-2018-06-01.malformed.json` | same endpoint, 2018-06-01 | **Invalid JSON**: `"val_cargaglobalsmmgd": ,` and `"val_cargammgd": ,`. `JSON.parse` throws on it. Also a `din_atualizacao` of 2020-09 for a 2018 valid time — the two axes, years apart |
| `carga-verificada-SE-2026-08-01.empty.json` | same endpoint and date, `cod_areacarga=SE` | **The silent failure.** HTTP 200, body `[\n ]`. Not a 400 |
| `carga-verificada-RJ-2026-08-01.json` | same endpoint and date, `cod_areacarga=RJ` | The geoelectric grain — an area that is not a subsystem, and gets no subsystem assigned |
| `carga-programada-SECO-2026-08-01.json` | `/cargaprogramada`, `SECO`, 2026-08-01 | The forecast series: four fields, and **no `din_atualizacao`** |

### Three things measured while capturing these, beyond the research

1. **Exceeding the three-month limit truncates silently.**
   `dat_inicio=2026-01-01&dat_fim=2026-06-30&cod_areacarga=SECO` returns HTTP
   200 with **4944 rows ending at `2026-04-13`** — 103 days of the 181
   requested, no error, no marker. `2026-01-01 → 2026-04-01` (three months and
   a day) still returns the full range, so a three-month chunk is safely inside
   the cap. This is why chunking is a correctness requirement and not a
   politeness, and why the adapter also checks that the last `dat_referencia`
   reaches `dat_fim`.
2. **The malformed-JSON defect has no clean start date.** Probed one day per
   period: 2016-01-01, 2017-06-01, 2018-06-01, 2018-10-01, 2018-12-01,
   2019-01-01 and **2019-02-01** are all invalid; 2019-02-15, 2019-02-25,
   2019-02-28, 2019-03-05 and everything later parse cleanly. So it cannot be
   gated on a date, and the tolerant parser runs on every response.
   Only two fields were observed affected, both nullable in the schema.
3. **An unknown `cod_areacarga` is answered exactly like `SE`.** `ZZ` also
   returns HTTP 200 and `[\n ]`. An empty array therefore never distinguishes
   "no data" from "wrong code", which is why an empty response for a covered
   period is treated as a failure rather than as an empty result.

## Interchange and daily load (ticket 06)

Captured **2026-08-28** from `dados.ons.org.br`. Real bytes, unedited except for
selecting whole lines; the two `package-show-…json` files are whole responses.

Recapture with, for example:

```
curl -s 'https://dados.ons.org.br/api/3/action/package_show?id=intercambio-nacional'
curl -s 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/intercambio_nacional_ho/INTERCAMBIO_NACIONAL_2026.csv' | head -37
```

| File | Source | Pins |
| --- | --- | --- |
| `package-show-intercambio-nacional.json` | `package_show?id=intercambio-nacional` | Whole response. 27 CSV, **4 PARQUET** (2023→ only), 27 XLSX. **15 of the 27 CSVs carry `last_modified: null`** — every year before 2012 |
| `package-show-carga-energia.json` | `package_show?id=carga-energia` | Whole response. 27 of each format; the S3 segment is `carga_energia_di`, not the slug |
| `INTERCAMBIO_NACIONAL_2025.head.csv` | `intercambio_nacional_ho`, header + lines 2–21 | The pre-drift header: **6 columns, no `val_intercambioprogmwmed`**. Unpadded `nom_*`, four fixed pairs, values signed |
| `INTERCAMBIO_NACIONAL_2026.head.csv` | same dataset, header + lines 2–37 | The post-drift header: **7 columns**, `nom_*` with a **leading space**, and the direction flip — `SE; SUDESTE;NE; NORDESTE` at 04:00 against `NE; NORDESTE;SE; SUDESTE` at 00:00 |
| `INTERCAMBIO_NACIONAL_2000.head.csv` | same dataset, header + lines 2–13 | The oldest vintage — only **three** links at hour 0, and the year CKAN reports no `last_modified` for |
| `INTERCAMBIO_NACIONAL_2018.dst-overlap.csv` | same dataset, lines 1, 4602–4617 | Fall back, 2018-02-18: the duplicated local hour `2018-02-17 23:00` is published once and cannot be disambiguated |
| `INTERCAMBIO_NACIONAL_2018.dst-gap.csv` | same dataset, lines 1, 29470–29481 | Spring forward, 2018-11-04: the hour that never happened is **simply absent**, with no placeholder row — the opposite of `balanco-energia-subsistema` |
| `head-INTERCAMBIO_NACIONAL_2000.csv.json` | S3 `HEAD` of `INTERCAMBIO_NACIONAL_2000.csv` | Change detection where the catalogue has no stamp: CKAN says `last_modified: null`, S3 answers `Fri, 13 Oct 2023 13:45:52 GMT` with an ETag and a length |
| `CARGA_ENERGIA_2000.head.csv` | `carga_energia_di`, header + lines 2–9 | The daily grain, **no `SIN` row**, `nom_subsistema` title-case (`Sudeste/Centro-Oeste`) — a third dialect |
| `CARGA_ENERGIA_2021.regime.csv` | same dataset, header + lines 230–245 | The **2021-03-01** methodology break, four days either side |
| `CARGA_ENERGIA_2023.regime.csv` | same dataset, header + lines 466–481 | The **2023-04-29** methodology break. SE drops 41 438 → 38 139 MWmed across it, with no schema change to signal it |
| `CARGA_ENERGIA_2018.dst.csv` | same dataset, lines 1, 190–197, 1226–1237 | The two irregular local days, kept rather than rejected |

### Five things measured while capturing these, beyond the research

1. **The interchange direction convention changed with the new column, and the
   research does not record it.** Full scan of both years: `INTERCAMBIO_NACIONAL_2018.csv`
   publishes **four fixed pairs** (`N→NE`, `N→SE`, `NE→SE`, `SE→S`) and carries
   the direction in the **sign** — 11 719 of 35 036 rows are negative.
   `INTERCAMBIO_NACIONAL_2026.csv` publishes **eight** pairs, every
   `val_intercambiomwmed` is non-negative, and the *row itself* flips when the
   flow reverses. Same physical quantity, different basis. A store keyed on
   (origin, destination) taken verbatim would hold two disjoint series in one
   column, so the adapter normalises the orientation and keeps the sign.
2. **Neither file ever states a link in both orientations within one hour** —
   zero occurrences across all 57 980 rows of the two years, and exactly four
   links per hour in both. The adapter still rejects a mirrored pair rather than
   letting `onConflictDoNothing` swallow it.
3. **The leading space in `nom_subsistema_*` is 2026-only.** 2000, 2019, 2023 and
   2025 are all clean; only the 2026 file writes `" NORTE"`. The padding hazard
   is per-vintage in this dataset exactly as it is in the balanço, which is why
   trimming is unconditional and the display names are never a key.
4. **The interchange spring-forward hour is omitted, not placeholdered.** 2018
   has 8 759 distinct hours and no row at all for `2018-11-04 00:00`, where
   `balanco-energia-subsistema` emits a row with empty measures. Two datasets,
   two behaviours, same transition.
5. **The daily load value for a spring-forward day is a mean over 23 hours, not
   24.** All four `2018-11-04` values carry the repeating decimal of a
   forty-sixths denominator (`4838.64947826`, `9711.65039130`), where ordinary
   days carry forty-eighths (`5070.88229167`). So MWmed → MWh must use the
   length the local day actually had. The 25-hour day is less clear — the
   `2018-02-17` values do not show a fiftieths repetend — so those rows are
   converted the same honest way and flagged: `day_minutes` is stored on every
   row and the run reports how many days were irregular.
