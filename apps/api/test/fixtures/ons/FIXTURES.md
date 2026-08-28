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
