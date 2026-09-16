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
        await conn.execute("UPDATE rag.document SET status = 'chunked' WHERE id = $1", document_id)
    return await embed_pending(db, gateway, document_id=document_id, limit=batch_limit)


async def embed_pending(
    db: Database, gateway: Gateway, *, document_id: str | None = None, limit: int | None = None
) -> dict:
    pool = await db.connect()
    task = gateway.tasks["embed"]
    done = 0
    waiting: float | None = None
    while True:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, text FROM rag.chunk WHERE embedding IS NULL"
                + (" AND document_id = $2" if document_id else "")
                + " ORDER BY document_id, ordinal LIMIT $1",
                task.batch_size,
                *([document_id] if document_id else []),
            )
        if not rows:
            break
        try:
            vectors, model = await embed_texts(gateway, [row["text"] for row in rows])
        except QuotaExhausted as exc:
            waiting = exc.retry_at
            break
        async with pool.acquire() as conn:
            await conn.executemany(
                "UPDATE rag.chunk SET embedding = $2::vector, embedding_model = $3 WHERE id = $1",
                [(row["id"], to_pgvector(vector), model) for row, vector in zip(rows, vectors, strict=True)],
            )
        done += len(rows)
        if limit and done >= limit:
            break
    if document_id and waiting is None:
        async with pool.acquire() as conn:
            await conn.execute("UPDATE rag.document SET status = 'indexed' WHERE id = $1", document_id)
    return {"embedded": done, "waiting_quota_until": waiting}
