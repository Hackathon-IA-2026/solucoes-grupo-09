# Evidence layer: the decisions that shaped `apps/rag`

The plan this service was built from (15/09/2026) and its execution brief are
kept in git history. This page records only the decisions that survived into
the code, so that nobody reverses one without knowing why it was taken.

## Where it lives

- **One monorepo.** `apps/rag` is a service of `vtorres/WattSteer`, next to
  `apps/api`, `apps/ml` and `apps/web`. A separate repository would duplicate
  compose, contracts and CI, and break the rule that `apps/api` is the only
  public door.
- **Its own Postgres, schema `rag`.** The gateway's Postgres image has no
  pgvector and `apps/api` owns every table in `public`. Locally it is the
  `rag-postgres` service behind the `rag` compose profile; `setup.sh` starts the
  same image on port 5439.
- **Evidence is materialised, never served live.** A job writes `rag.evidence`;
  the product reads the table. `apps/api/test/ml-boundary.test.ts` allows one
  door to a modelling service, and this service is not it.

## Models

- **Open models only, on free tiers: NVIDIA NIM, then Google AI Studio and
  Groq.** No closed provider runs in the cloud. Google (Gemma 4 26B, Apache 2.0)
  and Groq are the fallback for generation when NVIDIA is spent or answering
  503; Google is optional and is skipped without `GEMINI_API_KEYS`, and its key
  lives in a project with no billing account, which cannot be charged. One key
  is enough; several keys in the same variable are independent quotas, the
  router uses the one with the most room, and a key whose account answers 402
  is left out while the others go on.
- **One model per task, declared in `docs/rag/gateway.yaml`:**
  `nvidia/nemotron-parse` reads a page as an image, `nvidia/nemotron-3-embed-1b`
  embeds (2048 dimensions sliced to 1024 and re-normalised), Nemotron 3 Super
  drafts the claims, with Gemma 4 26B, then Groq's gpt-oss-120b, then Kimi K3
  behind it. Gemma was measured alone on the 95 evaluation questions on
  22/09/2026 (76 correct, 0 wrong, against Nemotron's 78 correct); Kimi is last
  because it takes about 100 s a call.
- **The embedding model never changes at runtime.** Two models in one index
  make every distance meaningless, so the chain is asserted at load and the data
  is asserted before the first search. Changing model is a re-index, a declared
  procedure, because the text of every chunk is kept.
- **A spent quota is a delay, not an error.** The router exhausts every key of
  a link, then moves to the next link with the same payload, and when the whole
  chain is out it reports `waiting_quota` with the instant to retry.

## The corpus

- **Chosen by the data.** Ten days of curtailment records across the four
  subsystems gave 857 records and 17 distinct descriptions, and the
  descriptions name the operating instruction that applies. The corpus is those
  instructions, the grid procedures they rest on, the daily bulletin as HTML
  tables, the preliminary daily report and one disturbance report.
- **Documents are addressed by hash.** The ONS revises files in place, so two
  revisions are two rows. A re-run never downloads twice.
- **The text layer when it is good, the vision model when it is not.** Pages
  whose text layer reads like prose cost nothing. Pages the text layer flattens
  into columns (the instructions are six column tables) go to `nemotron-parse`.
- **The IPDO has no official history.** Only the current edition is served;
  older ones come from the Internet Archive, filtered to real PDFs.

## Retrieval and gates

- **Hybrid search fused by RRF.** pgvector for meaning, Portuguese full text
  for the exact words a record uses (`IO-ON.NE.2SO`, `LT 500 kV`). The full text
  query is an OR of terms, because the conjunction matches nothing.
- **Temporal cut.** Only documents with `published_at <= gate_at` are eligible,
  the same discipline the forecasting model applies to its inputs.
- **A table of contents is excluded** from retrieval: it repeats every title and
  wins a keyword search against the section that states the rule. So is the
  running header: it repeats on every page and carries the document's own code,
  so a search for `IO-ON.NE.5NE` ranked it above the section that states the
  limit. A passage that repeats on three or more pages of the same document is
  marked `furniture` and never retrieved.
- **Retrieval is restricted to the instruction the record names.** `IO-ON.NE.2LE`
  and `IO-ON.NE.5NE` describe neighbouring areas in nearly the same sentences,
  and without this the search ranked the wrong area above the right one.
- **Six gates, all mechanical:** the quote exists in the chunk, the cited
  document is the one the record names (and a disturbance report only counts for
  the day it analyses), every number in the claim is in a quote or in the record
  itself, no causal vocabulary (same lemma list as
  `packages/core/src/causality.ts`), a heading alone is not evidence — nor are
  two headings stacked — and a citation has a locator. In a table the quote may skip cells in order and is
  marked `assembled`; prose requires a contiguous span.
- **The service never classifies.** `supports` and `evidence_weight` are
  information for the rule, not a decision. REL is never `high`: the
  intervention schedule is not public.

## `/internal/rag/search` is not the pipeline, and reads like it is

Measured on 21/09/2026 while verifying a deploy. The debug endpoint calls
`search()` with `published_before` and a limit, and **not** with `target_date`
— so the filter that keeps a bulletin of another day out of the candidates
never runs. Asked "quanta carga foi interrompida no SIN na perturbação de
15/08/2023", the deployed service put a *Boletim Diário de 12/09/2026* second,
which the real path would have excluded outright
(`gate.DAILY_REPORTS`, and the matching clause in `retrieve.search`).

Nothing is wrong with the service; the endpoint is answering the question it
was given. But it is the tool anybody reaches for to ask "why did retrieval do
that", and the answer it gives is from a different retrieval than the one the
drafter saw. **Fixed the same day**: it takes `target_date` and passes it through, and it
answers `day_window_applied` either way, so an axis that did not run cannot be
mistaken for one that did. It stays optional, because a question about the
general rules is not about a day.

## What was planned and deliberately not built

- Redis counters, an `arq` worker and durable jobs in `rag.job`: the commands
  are resumable and idempotent, which covered the hackathon's needs without a
  queue. The table and `rag-job-status.schema.json` remain as the contract for
  when a job surface is added.
- ~~A reranker~~ — **built on 21/09/2026, measured, and still off by default.**
  NIM retired its rerankers (410), so this is the local one the extra installs
  (`pip install -e ".[rerank]"`). It was deferred until it measured better than
  the RRF order, and it does: over the 67 goldset questions that name the
  numbers their document states, a passage stating one of them is among the
  eight the drafter receives in **52** cases under RRF and **59** under
  reranking — seven rescued, none lost. Scored on retrieval rather than
  end-to-end so the two arms see identical candidates and no generation quota
  is spent (`eval/measure_rerank.py`).

  What it fixed, end to end on the three wrong answers of the 19/09 run: A01
  went from a true-but-unasked percentage to the sentence that answers it
  ("aproximadamente 23.368 MW de cargas do SIN", page 15 of a 572-page report,
  which the fused order never surfaced). A02 did not move — its answering
  chunk sits at fused rank 11 and the cross-encoder still ranks eight others
  above it.

  Off by default (`WATTSTEER_RAG_RERANK_MODEL` empty) because the extra is a
  few hundred megabytes and a deployment without it must run the retrieval that
  was measured rather than a quietly different one. `rerank.py` falls back to
  the RRF order whenever the model is absent or fails, and the trace's
  `rerank_provider` is `null` exactly then.
- Docling, Playwright and the CKAN client: poppler and plain HTTP were enough
  for every source that ended up in the corpus.
- OpenRouter, SambaNova and Bedrock as extra links: two free providers cover
  the load and each extra provider was one more key to ask a new member for.
