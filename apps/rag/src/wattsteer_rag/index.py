"""Embedding and storing chunks.

The embedding model is a property of the index, not of a call. Slicing the 2048
dimensional vector down to 1024 halves the index and costs almost nothing in
recall, but only if the slice is re-normalised, which is what the model card
requires and what `_slice_unit` does.
"""

from __future__ import annotations

import math

from .config import settings
from .db import Database
from .gateway.router import Gateway, QuotaExhausted


def _slice_unit(vector: list[float], dimensions: int) -> list[float]:
    sliced = vector[:dimensions]
    norm = math.sqrt(sum(value * value for value in sliced)) or 1.0
    return [value / norm for value in sliced]


def to_pgvector(vector: list[float]) -> str:
    return "[" + ",".join(f"{value:.7f}" for value in vector) + "]"


async def embed_texts(
    gateway: Gateway, texts: list[str], *, input_type: str = "passage"
) -> tuple[list[list[float]], str]:
    """Returns unit vectors and the model that produced them."""
    task = gateway.tasks["embed"]
    dimensions = task.dimensions or settings().embedding_dimensions
    vectors: list[list[float]] = []
    model = ""
    for start in range(0, len(texts), task.batch_size):
        batch = texts[start : start + task.batch_size]
        tokens = sum(max(1, len(text) // 4) for text in batch)
        result = await gateway.run("embed", tokens=tokens, texts=batch, input_type=input_type)
        model = f"{result.model}@{dimensions}"
        vectors.extend(_slice_unit(vector, dimensions) for vector in result.value)
    return vectors, model


async def index_document(
    db: Database,
    gateway: Gateway,
    document_id: str,
    chunks: list,
    *,
    batch_limit: int | None = None,
) -> dict:
    """Store chunks, then embed whatever is still missing a vector.

    Split in two so that an exhausted quota leaves a document that is chunked and
    searchable by text, and an `embed` job can finish it later.
    """
    pool = await db.connect()
    async with pool.acquire() as conn:
        await conn.executemany(
            "INSERT INTO rag.chunk (document_id, ordinal, page_start, page_end, section_path, locator,"
            " text, tokens) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)"
            " ON CONFLICT (document_id, ordinal) DO UPDATE SET text = excluded.text,"
            " locator = excluded.locator, section_path = excluded.section_path,"
            " page_start = excluded.page_start, page_end = excluded.page_end, tokens = excluded.tokens,"
            # A vector describes the text it was made from. When the text changes
            # the old vector is not stale, it is wrong, so it goes back in the queue.
            " embedding = CASE WHEN rag.chunk.text IS DISTINCT FROM excluded.text"
            "   THEN NULL ELSE rag.chunk.embedding END,"
            " embedding_model = CASE WHEN rag.chunk.text IS DISTINCT FROM excluded.text"
            "   THEN NULL ELSE rag.chunk.embedding_model END",
            [
                (
                    document_id,
                    chunk.ordinal,
                    chunk.page_start,
                    chunk.page_end,
                    chunk.section_path,
                    chunk.locator,
                    chunk.text,
                    chunk.tokens,
                )
                for chunk in chunks
            ],
        )
        # A re-parse that yields fewer chunks than before would otherwise leave
        # the old tail in the index, quoting text the document no longer has.
        await conn.execute(
            "DELETE FROM rag.chunk WHERE document_id = $1 AND ordinal > $2", document_id, len(chunks)
        )
        await conn.execute("UPDATE rag.document SET status = 'chunked' WHERE id = $1", document_id)
    return await embed_pending(db, gateway, document_id=document_id, limit=batch_limit)


async def embed_pending(
    db: Database, gateway: Gateway, *, document_id: str | None = None, limit: int | None = None
) -> dict:
    """Embed chunks that have no vector yet, batch by batch, until none is left,
    the limit is reached, or the quota is spent."""
    pool = await db.connect()
    batch_size = gateway.tasks["embed"].batch_size
    done = 0
    waiting: float | None = None
    while limit is None or done < limit:
        rows = await _chunks_without_vector(pool, document_id, batch_size)
        if not rows:
            break
        try:
            vectors, model = await embed_texts(gateway, [row["text"] for row in rows])
        except QuotaExhausted as exc:
            waiting = exc.retry_at
            break
        await _store_vectors(pool, rows, vectors, model)
        done += len(rows)
    if document_id and waiting is None:
        async with pool.acquire() as conn:
            await conn.execute("UPDATE rag.document SET status = 'indexed' WHERE id = $1", document_id)
    return {"embedded": done, "waiting_quota_until": waiting}


async def _chunks_without_vector(pool, document_id: str | None, batch_size: int) -> list:
    async with pool.acquire() as conn:
        return await conn.fetch(
            "SELECT id, text FROM rag.chunk WHERE embedding IS NULL"
            + (" AND document_id = $2" if document_id else "")
            + " ORDER BY document_id, ordinal LIMIT $1",
            batch_size,
            *([document_id] if document_id else []),
        )


async def _store_vectors(pool, rows: list, vectors: list[list[float]], model: str) -> None:
    async with pool.acquire() as conn:
        await conn.executemany(
            "UPDATE rag.chunk SET embedding = $2::vector, embedding_model = $3 WHERE id = $1",
            [(row["id"], to_pgvector(vector), model) for row, vector in zip(rows, vectors, strict=True)],
        )
