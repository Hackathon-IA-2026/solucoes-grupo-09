# Figures for the on-site deck

**Measured on 21/09/2026** against `main`, with the evidence corpus restored
from release `state-2026-09-20`. Every number here says where it comes from and
how to reproduce it, because `docs/todo.md` item 6 asks for exactly that: no
number in the deck that is not verifiable.

Three categories, and the third is the one that matters most:

- **Measured** — a command in this repository produced it today.
- **Published contract** — it comes from a fixture or a spec example. It is
  real in the sense that it is the shape both sides agree on, and it is **not**
  a measurement of the system running. Do not present it as one.
- **Not available** — say so, or leave the slide out.

---

## Measured

### The suites

| Suite | Command | Passing |
|---|---|---|
| Core (wire contract) | `bun run test:core` | 530 |
| Gateway | `bun run test:api` | 1,460 (604 skipped, need Postgres) |
| Web | `bun run test:web` | 971 |
| Repository hygiene | `bun run test:hygiene` | 262 |
| Evidence service | `uv run pytest` in `apps/rag` | 74 |
| Modelling | `uv run pytest` in `apps/ml` | 1,862 (94 skipped) |
| **Total** | | **5,159 passing** |

`bun run check` — typecheck, `biome check` and the four TypeScript suites —
exits 0. There is no tolerated-failure baseline.

### The evidence corpus

| | |
|---|---|
| Chunks | 18,063 |
| Documents | 293 |
| Pages | 1,580 |

By source: BDO 251, IPDO 26, Procedimentos de Rede 8, Instruções de Operação 7,
RAP 1.

> Railway currently holds **1,508** chunks over 240 documents, with no RAP and
> one IPDO. That is the corpus the deployed service is answering from, and it
> cannot answer the questions below. Shipping the release corpus is item 1 of
> `docs/todo.md`.

### Retrieval: reranking against the RRF order

`uv run python eval/measure_rerank.py` in `apps/rag`. Over the 67 goldset
questions that name the numbers their document states, how often a passage
stating one of them is among the eight the drafter receives:

| Ordering | Answering passage reaches the drafter |
|---|---|
| RRF (today's default) | 52 / 67 — **77.6 %** |
| Reranked (`mmarco-mMiniLMv2-L12-H384-v1`) | 59 / 67 — **88.1 %** |

Seven rescued, **none lost**. Scored on retrieval rather than end to end, so
both arms see identical candidates and no generation quota is spent.

### The three answers that were wrong on 19/09

`I06`, `A01`, `A02`. Start of 21/09: **0 correct, 2 wrong, 1 refused.** After
the two fixes below: **2 correct, 1 wrong, 0 refused.**

- **I06** was answered with an instantaneous MW peak from the SIN table on page
  13 instead of the Northeast's daily 12.197 MWmed on page 1. Fixed by
  reordering the `verify` chain: it led with Groq, `GROQ_API_KEYS` is empty, and
  the fallback was 503-ing, so the claim reader had no working link at all.
- **A01** answered "34,5 % da carga" — true, cited, and not what was asked. The
  sentence that answers it is on page 15 of a 572-page report and was in none of
  the 80 retrieved candidates. Fixed by reranking.
- **A02** is still wrong. The report holds several restoration timestamps and it
  answers 09h44 (LIGHT's ERAC) where 14h49 (the ONS authorising total
  restoration) is asked. Its chunk is at fused rank 11 and the cross-encoder
  still ranks eight above it.

### End-to-end RAG accuracy

See `## Not available` below until the full run finishes; the last **complete**
measurement is 19/09, before any of today's fixes: **67/80 correct (83.75 %),
10 refused, 3 wrong**, on `apps/rag/eval/questions.jsonl`.

A number from this set is not a claim about accuracy on unseen questions. The
set was used while tuning, and `docs/todo.md` item 3 asks for ~30 fresh
questions before the figure is presented as accuracy. **Present it as "on the
development set" or not at all.**

---

## Published contract — not a measurement

The Time Machine's headline (`packages/core/fixtures/spec-examples/12-replay.json`):

| | |
|---|---|
| Curtailed, settled | 612 MWh |
| Recovered | 281 MWh |
| Left after the fleet | 331 MWh |
| Avoidability | 45.9 % |
| P10 floor | 84.1 MWh, met |

This is the **published example of the contract**, which is what the screens are
built against and what the spec's own prose quotes. It is not a replay of a real
day measured today. If the deck shows 612 / 281 / 45.9 %, the slide has to say
it is the worked example — presenting it as a result is the exact failure item 6
exists to prevent.

---

## Not available

- **Any forecast figure.** No lane is promoted: `gate_late` fails on the
  publication lag and `gate_early` on the P10 calibration guardrail
  (`docs/todo.md` item 2). Every forecast screen correctly states an absence, so
  there is no measured band, no risk class and no skill number to show.
- **The baseline ladder's "AI added value" delta.** It is defined per
  `(run, fold_id, vintage_fidelity)` and needs a completed retrain, which is
  weekly (Fridays 03:10 UTC).
- **Accuracy on questions the system was not tuned on.** Item 3's ~30 fresh
  questions do not exist yet.

---

## Reproducing all of it

```sh
docker compose --profile rag up -d rag-postgres
gh release download state-2026-09-20 --repo vtorres/WattSteer --pattern rag.sql.gz
gunzip -c rag.sql.gz | docker exec -i <rag-postgres> psql -U wattsteer -d wattsteer_rag

bun run check                       # 0 failures, exits 0
cd apps/rag && uv run pytest        # 74
uv run python eval/measure_rerank.py         # 52 -> 59
uv run python eval/run_eval.py --goldset eval/questions.jsonl
```
