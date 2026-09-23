-- The reader changed for two kinds of document, and a corpus that is already
-- indexed would never see it: ingestion only takes documents that are fetched or
-- parsed, and a deploy ships the persisted chunks as they were.
--
-- IPDO: the starred highlights are now topics, so a restriction's chunk is filed
-- under "RESTRIÇÃO DE GERAÇÃO RENOVÁVEL > Submercado Sul" and not "Submercado
-- Sul". The section gate reads that path, and against the old one it would
-- refuse a correct citation.
--
-- RAP: an action page ("Prazo: ...   Gestor: ...") is read from the text layer
-- instead of the vision model, which had split every action from its deadline.
--
-- Marking them fetched puts them back in the queue of the daily refresh, which
-- reads each file again with the current reader, replaces its chunks and embeds
-- what changed. Until then the old chunks keep answering; the gate can only turn
-- one of their answers into a refusal, never into a wrong one.
UPDATE rag.document
   SET status = 'fetched'
 WHERE source IN ('IPDO', 'RAP')
   AND status NOT IN ('superseded', 'fetched');
