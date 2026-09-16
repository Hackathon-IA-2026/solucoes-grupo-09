# apps/rag

Evidence retrieval over the ONS public record. It finds the document that states
a rule, quotes it, and cites where the quote came from. **It never classifies a
curtailment**: REL, CNF and ENE stay with the rule and with SHAP.

> For what this does and why, in plain language and with diagrams, read
> [docs/rag/o-que-e-o-rag.md](../../docs/rag/o-que-e-o-rag.md). This file is the
> operational half: how to install it, and how to find out why an answer is
> wrong.

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

### First, the one thing nobody can do for you: a key

Indexing and answering both call a model, so the service needs one API key. Free,
two minutes, no card:

| Provider | Where | Looks like |
| --- | --- | --- |
| NVIDIA | https://build.nvidia.com, "Get API Key" | `nvapi-...` |
| Groq | https://console.groq.com, "API Keys" | `gsk_...` |

Put at least one in `WattSteer/.env`, which git already ignores:

```
NVIDIA_API_KEYS=nvapi-...
GROQ_API_KEYS=gsk_...
```

One key is enough. Several keys, separated by commas, add their quotas up, which
is why the variables are plural.

### Then, one command

```bash
cd apps/rag && ./setup.sh          # install, database, schema, normative corpus
cd apps/rag && ./setup.sh --full   # the above plus daily bulletins, IPDO archive, a RAP
```

It installs the package, starts a Postgres that has pgvector, applies the
migrations and **builds the corpus where it is installed**: on a laptop it fills
that laptop's database, on a server it fills the server's. Nothing large travels
in the repository.

It is resumable. Interrupt it, run it again, and it continues: documents already
fetched are not fetched twice, pages already read are not read again, and only
chunks without a vector are embedded. Hitting the free tier's ceiling is normal
and not a failure: the run says `waiting_quota` with the instant it can resume.

Measured on 15/09/2026, a full build is 281 documents, 816 pages and 2786 chunks.
Only 28 of those pages needed the vision model, because everything else carries a
text layer; the rest of the time is embedding, around five minutes.

```bash
./.venv/bin/wattsteer-rag doctor          # is every link of every chain alive?
./.venv/bin/wattsteer-rag search "limitação do fluxo Senhor do Bonfim"
./.venv/bin/wattsteer-rag evidence NE 2026-09-14 --gate-at 2026-09-13T22:00:00Z \
  --reason CNF --description "Controle de inequação: LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO"
```

Moving a corpus that is already built to another machine, instead of building it
there again:

```bash
./.venv/bin/wattsteer-rag seed dump   # writes seed/corpus.jsonl.gz, git ignores it
./.venv/bin/wattsteer-rag seed load   # on the other machine
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
