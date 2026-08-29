# ANEEL fixtures

Real captured payloads, not hand-written approximations — the same rule as
`../ons/FIXTURES.md`. Fetched from the live source on **2026-08-28** (the CSV as
a selection of whole lines of the real file, byte-for-byte otherwise).

ANEEL is a second CKAN, on a different host from ONS:

```
curl -s "https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=siga-sistema-de-informacoes-de-geracao-da-aneel"
curl -s "https://dadosabertos.aneel.gov.br/dataset/6d90b77c-c5f5-4d81-bdec-7bc619494bb9/resource/2f65a1b0-19b8-4360-8238-b34ab4693d55/download/siga-empreendimentos-geracao-diario.csv"
```

| File | Source | Pins |
| --- | --- | --- |
| `package-show-siga.json` | `package_show?id=siga-…` | Whole response, unedited. **Five resources, two of them CSV** — the monthly cut (`last_modified` 2026-08-25) and the daily one (2026-08-28), with an identical header. `license_id: odc-odbl`. |
| `head-siga-empreendimentos-geracao-diario.csv.json` | `HEAD` of the daily CSV | The change-detection triple. Unlike ONS's S3 the `ETag` is not multipart-suffixed, so `(last-modified, content-length, etag)` is a clean change key. Note `cache-control: no-cache` and `vary: Cookie`. |
| `siga-empreendimentos-geracao-diario.registry.csv` | 22 whole lines of the daily CSV, plus its header | See below — nine findings in 22 data rows. |

## What the SIGA slice pins

The 23-column header, ANEEL's own typos included (`DscMuninicpios`,
`DscPropriRegimePariticipacao`), and a column order that is **not** the data
dictionary's — `DscTipoOutorga` sits before `NomFonteCombustivel` in the live
file. Every field is double-quoted and every number uses a **decimal comma**.

- **`EOL.CV.RN.028443-2` Alegria II, `EOL.CV.CE.028699-0` Icaraizinho,
  `EOL.CV.MA.033682-3`/`033683-1` Delta 3 I–II, `EOL.CV.CE.033756-0` Cataventos
  Acaraú I, `EOL.CV.BA.034778-7`/`034779-5` Serra das Almas I–II,
  `EOL.CV.RN.030339-9` Miassaba 3, `UFV.RS.PE.040725-9` Belmonte 1-1** — the
  eight wind plants and one solar plant that `../ons/CAPACIDADE_GERACAO.registry.csv`
  also carries. This is what makes the join testable across the two fixtures,
  and the ANEEL rendering of every one of these CEGs ends `.1` against ONS's
  `.01`: **the verbatim key matches none of them.**
- **`EOL.CV.CE.028770-9` Enacel** — 31.5 MW, `Operação`, coordinates
  `",00000000"` / `",00000000"`. **Null Island**, and written in a form that a
  naive `Number()` reads as `NaN` rather than as zero. `Aracati - CE`.
- **`UFV.RS.CE.034037-5` Pitombeira** — also `Aracati - CE`, properly sited. It
  is what the municipality-centroid fallback averages for Enacel.
- **`UFV.RS.MG.049441-0` Draco Solar 6** — the second null-island plant, with
  **`049440-2` Draco Solar 5 and `049442-9` Draco Solar 7** beside it in
  `Arinos - MG` to fall back onto. Arinos is inside the S6 Paracatu/Arinos
  cluster, so this fallback moves a real weather sample.
- **`UTE.PE.PE.002887-8` Tubarão, Fernando de Noronha** — a real, correctly
  sited plant at longitude −32.417, which is **outside** the Brazil bounding box
  `docs/domain-model.md` §3 specifies. The box excludes the Atlantic islands.
  Out of WattSteer's scope (thermal), but it is why the bounding-box rejection
  count is reported rather than assumed to be zero.
- **`PCH.PH.SC.028744-0` Rio Timbó, twice** — one of the three duplicate
  `CodCEG` values in the live file. The two rows are **not** byte-identical:
  they differ in `DscTipoOutorga` (`Autorização` vs `Concessão`). They agree on
  everything this adapter stores, which is why the duplicate is folded rather
  than rejected.
- **`UFV.RS.SP.030442-5` PV Beta Test Site** — `Operação`, `UFV`, **1 kW**. One
  of 15,691 rows like it. The reason every aggregation applies a size filter.
- **`UFV.RS.CE.033232-1` Fótons de São Patrício 1** — `Construção não iniciada`,
  `MdaPotenciaFiscalizadaKw = 0`, `DatEntradaOperacao = 1900-01-03`. The
  sentinel date, and the registration lag that makes SIGA the wrong source for
  capacity.
- **`UHE.PH.SE.027053-9` Xingó, `UTN.UR.RJ.000100-7`/`000101-5` Angra 1–2** —
  hydro and nuclear, kept because they are in the ONS fixture too. Xingó also
  carries a **two-municipality** `DscMuninicpios` (`Piranhas - AL, Canindé de
  São Francisco - SE`).

**One plant is deliberately absent.** `UTE.PE.AL.028623-0`, which
`../ons/CAPACIDADE_GERACAO.registry.csv` lists, has no row in SIGA at all — a
live instance of the 68% thermal coverage the research measured, and the case
the match-rate assertion exists to notice.
