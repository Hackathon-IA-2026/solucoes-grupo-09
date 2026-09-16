-- Evidence is a publication: the same question answered again after the corpus
-- or the model changed is a new row, not an edit of the old one. Replay depends
-- on being able to find what was actually served on a day.
ALTER TABLE rag.evidence DROP CONSTRAINT IF EXISTS evidence_subsystem_target_date_question_key_gate_at_key;
ALTER TABLE rag.evidence DROP CONSTRAINT IF EXISTS evidence_identity;
ALTER TABLE rag.evidence ADD CONSTRAINT evidence_identity
  UNIQUE (subsystem, target_date, question_key, gate_at, corpus_version, sha256);
CREATE INDEX IF NOT EXISTS evidence_latest_idx
  ON rag.evidence (subsystem, target_date, created_at DESC);
