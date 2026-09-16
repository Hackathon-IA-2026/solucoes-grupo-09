# apps/rag

Evidence retrieval over the ONS public record. It finds the document that states
a rule, quotes it, and cites where the quote came from. **It never classifies a
curtailment**: REL, CNF and ENE stay with the rule and with SHAP.

## Why it exists

The ONS already declares the reason for a curtailment and names the control it
applied. Ten days sampled across the four subsystems gave 857 records and only
17 distinct descriptions, all of this shape:

```
CNF  Controle de inequação: LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO
REL  Desligamento das LT 525 kV Povo Novo / Marmeleiro C2. SGI N° 46.066-26
ENE  Controle de frequência do SIN.
```

The codes are documents. `IO-ON.NE.2SO` is a public operating instruction whose
section 5.1 is exactly "LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II". So the work is
not to guess the reason, it is to put the paragraph that defines the control in
front of the operator, with its date and its page.

## The guarantees

| Guarantee | How it is enforced |
| --- | --- |
| A claim without a verifiable quote does not exist | The quoted span must occur in the indexed chunk, compared after table syntax is flattened (`flatten_for_match`) |
| No number is invented | Every number in a claim must appear in one of that claim's quotes |
| The service does not explain, it reports | Causal vocabulary is refused, using the same lemma list as `packages/core/src/causality.ts` |
| A heading is not evidence | A quote with no statement and no number is refused |
| Nothing is explained with a document nobody could have read | Retrieval filters `published_at <= gate_at` |
| A free tier running out is a delay, not a failure | The gateway pools every key, then declares `waiting_quota` with a retry instant |
| The index never mixes vector spaces | One embedding model per chain, asserted at load and in the data |

When nothing survives, the verdict is `insufficient` or `not_found` with a
reason. Silence is the intended failure mode.

## Running it

```bash
cd apps/rag
python3 -m venv .venv && ./.venv/bin/pip install -e ".[dev]"

# Postgres with pgvector. The gateway's own image does not carry the extension,
# so the RAG owns its database until that changes.
docker run -d --name wattsteer-rag-pg -p 5439:5432 \
  -e POSTGRES_USER=wattsteer -e POSTGRES_PASSWORD=wattsteer -e POSTGRES_DB=wattsteer_rag \
  pgvector/pgvector:pg17

export WATTSTEER_RAG_DATABASE_URL=postgres://wattsteer:wattsteer@localhost:5439/wattsteer_rag
export NVIDIA_API_KEYS=nvapi-...          # one key is enough; more are more quota

./.venv/bin/wattsteer-rag migrate
./.venv/bin/wattsteer-rag doctor          # is every link of every chain alive?
./.venv/bin/wattsteer-rag crawl instructions --codes IO-ON.NE.2SO
./.venv/bin/wattsteer-rag ingest --max-pages 10
./.venv/bin/wattsteer-rag evidence NE 2026-09-14 --gate-at 2026-09-13T22:00:00Z \
  --reason CNF --description "Controle de inequação: LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO"
```

## Debugging it

A retrieval failure is invisible unless the service is built to show its work.

| Question | Where to look |
| --- | --- |
| Is every provider reachable, and with how many keys? | `wattsteer-rag doctor`, or `GET /internal/llm/quota` |
| What did the search return, and in which rank? | `wattsteer-rag search "..."`, or `GET /internal/rag/search?q=` (both ranks and the fused score) |
| What did the model try to say, and which gate refused it? | the `recusadas` block of `wattsteer-rag evidence`, or `trace.generation.rejected` in the JSON |
| What question did a record turn into? | `wattsteer-rag question NE 2026-09-14 --description "..."` |
| Why is a document missing from an answer? | `GET /internal/rag/status`, then check `published_at` against the gate |
| Did the chunking change the answer? | `wattsteer-rag rechunk`, which re-chunks from stored pages and costs no parsing quota |

Every evidence document carries its own trace: the candidates with both ranks,
the provider and model that answered, the attempts, and the gate failures.

## Layout

```
gateway/   provider adapters, key pools, quota accounting, the fallback router
crawl.py   the documents the records cite: operating instructions, procedures
parse.py   page to blocks, via nvidia/nemotron-parse, falling back to poppler
chunk.py   sections and tables, never split; tables of contents marked and excluded
index.py   embeddings and the single vector space rule
retrieve.py hybrid search: pgvector plus Portuguese full text, fused with RRF
evidence.py the builder and the gates
app.py     the internal HTTP surface
```

## Integration

`apps/api` must not call this service to serve a read: `apps/api/test/ml-boundary.test.ts`
allows exactly one door to a modelling service, and for good reason. Evidence is
**materialised**: a job writes `rag.evidence`, the product reads the table. The
same discipline as the forecast attribution.
