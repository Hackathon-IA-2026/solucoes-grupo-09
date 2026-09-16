-- The corpus, the chunks, the evidence and the audit trail.
--
-- Everything lives in the `rag` schema of a database this service owns, because
-- apps/api owns every table in `public` and the gateway's Postgres image has no
-- pgvector. Nothing here is written by any other service.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS rag;

-- A document as it was published, addressed by the hash of its bytes. The ONS
-- revises documents in place, so `sha256` plus `fetched_at` is the only honest
-- identity: two revisions of IO-ON.NE.2SO are two rows, not one.
CREATE TABLE IF NOT EXISTS rag.document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text        NOT NULL,          -- BDO | IPDO | RAP | PROCEDIMENTOS_REDE | INSTRUCAO_OPERACAO | NORMA
  external_id   text,                          -- IO-ON.NE.2SO, SGI 46.066-26, dataset name
  revision      text,                          -- Rev.146
  title         text        NOT NULL,
  url           text        NOT NULL,
  published_at  timestamptz,                   -- the date the document itself states
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  sha256        text        NOT NULL,
  bytes         bigint      NOT NULL DEFAULT 0,
  mime          text        NOT NULL DEFAULT 'application/pdf',
  pages         int,
  status        text        NOT NULL DEFAULT 'fetched',  -- fetched | parsed | chunked | indexed | failed
  needs_review  boolean     NOT NULL DEFAULT false,
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, sha256)
);
CREATE INDEX IF NOT EXISTS document_external_idx ON rag.document (external_id);
CREATE INDEX IF NOT EXISTS document_published_idx ON rag.document (published_at DESC);

-- A page as some parser saw it. `parser` records which link of the chain wrote
-- this, so a page extracted by the local fallback is never mistaken for one the
-- vision model read.
CREATE TABLE IF NOT EXISTS rag.page (
  document_id uuid NOT NULL REFERENCES rag.document(id) ON DELETE CASCADE,
  page_no     int  NOT NULL,
  markdown    text NOT NULL,
  blocks      jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_tables  boolean NOT NULL DEFAULT false,
  parser      text NOT NULL,
  PRIMARY KEY (document_id, page_no)
);

-- The unit of retrieval and of citation. `text` is kept verbatim because the
-- evidence gate checks that every quoted span exists here, character for
-- character, and because it is what makes a re-index possible.
CREATE TABLE IF NOT EXISTS rag.chunk (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES rag.document(id) ON DELETE CASCADE,
  ordinal         int  NOT NULL,
  page_start      int,
  page_end        int,
  section_path    text,
  locator         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {page, section, table, bbox}
  text            text NOT NULL,
  tokens          int  NOT NULL DEFAULT 0,
  embedding       vector(1024),
  embedding_model text,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', text)) STORED,
  UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON rag.chunk USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunk_embedding_idx ON rag.chunk
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS chunk_pending_idx ON rag.chunk (id) WHERE embedding IS NULL;

-- Published evidence. One row per (subsystem, date, question key): immutable,
-- hashed, and reproducible. This is the table the product reads; nothing that
-- serves a page ever calls the model.
CREATE TABLE IF NOT EXISTS rag.evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subsystem     text NOT NULL,
  target_date   date NOT NULL,
  question_key  text NOT NULL,
  gate_at       timestamptz NOT NULL,
  verdict       text NOT NULL,                  -- found | insufficient | not_found
  reason        text,
  payload       jsonb NOT NULL,                 -- the RagEvidence document
  corpus_version text NOT NULL,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subsystem, target_date, question_key, gate_at)
);

-- Every retrieval, so a replay can prove what the search returned on the day.
CREATE TABLE IF NOT EXISTS rag.retrieval_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  question    text NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  chunk_ids   uuid[] NOT NULL DEFAULT '{}',
  scores      double precision[] NOT NULL DEFAULT '{}',
  trace_id    text
);

-- Every model call, for cost and for the post-mortem of a bad answer.
CREATE TABLE IF NOT EXISTS rag.llm_call (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  task       text NOT NULL,
  provider   text NOT NULL,
  key_id     text NOT NULL,          -- never the key
  model      text NOT NULL,
  attempt    int  NOT NULL DEFAULT 1,
  latency_ms int,
  tokens_in  int  NOT NULL DEFAULT 0,
  tokens_out int  NOT NULL DEFAULT 0,
  error      text,
  trace_id   text
);

-- Background work, durable because an ingestion that forgets where it stopped
-- is an ingestion that starts over.
CREATE TABLE IF NOT EXISTS rag.job (
  id         text PRIMARY KEY,        -- sha256(kind + normalised params)
  kind       text NOT NULL,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status     text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retry_at   timestamptz,
  progress   jsonb NOT NULL DEFAULT '{"done":0,"total":null,"failed":0}'::jsonb,
  feedback   jsonb NOT NULL DEFAULT '{"message":"","errors":[]}'::jsonb,
  result     jsonb
);
