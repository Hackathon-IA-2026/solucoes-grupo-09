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
