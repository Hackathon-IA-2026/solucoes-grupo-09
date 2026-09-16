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

- **Open models only, on free tiers: NVIDIA NIM and Groq.** No closed provider
  runs in the cloud. Groq is the fallback for generation when every NVIDIA key
  is spent. One key is enough; several keys in the same variable are independent
  quotas, the router uses the one with the most room.
- **One model per task, declared in `docs/rag/gateway.yaml`:**
  `nvidia/nemotron-parse` reads a page as an image, `nvidia/nemotron-3-embed-1b`
  embeds (2048 dimensions sliced to 1024 and re-normalised), Nemotron 3 Super
  drafts the claims, with Kimi K3 and then Groq's gpt-oss-120b behind it.
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
  wins a keyword search against the section that states the rule.
- **Five gates, all mechanical:** the quote exists in the chunk, every number in
  the claim is in a quote, no causal vocabulary (same lemma list as
  `packages/core/src/causality.ts`), a heading alone is not evidence, and a
  citation has a locator. In a table the quote may skip cells in order and is
  marked `assembled`; prose requires a contiguous span.
- **The service never classifies.** `supports` and `evidence_weight` are
  information for the rule, not a decision. REL is never `high`: the
  intervention schedule is not public.

## What was planned and deliberately not built

- Redis counters, an `arq` worker and durable jobs in `rag.job`: the commands
  are resumable and idempotent, which covered the hackathon's needs without a
  queue. The table and `rag-job-status.schema.json` remain as the contract for
  when a job surface is added.
- A reranker: NIM retired its rerankers (410) and a local one is optional
  (`pip install -e ".[rerank]"`); the RRF order is used and the trace says so.
- Docling, Playwright and the CKAN client: poppler and plain HTTP were enough
  for every source that ended up in the corpus.
- OpenRouter, SambaNova and Bedrock as extra links: two free providers cover
  the load and each extra provider was one more key to ask a new member for.
