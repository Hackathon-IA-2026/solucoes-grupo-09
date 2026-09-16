"""Hybrid retrieval over the corpus.

Vector search finds the paragraph that means the same thing; Portuguese full
text search finds the one that says the same words, which is what happens when a
curtailment record names "LT 500 kV ACU III / QUIXADA" or the code IO-ON.NE.2SO.
Neither alone is enough, so both run and Reciprocal Rank Fusion merges them.

The temporal filter is not optional. A document published after the decision
cannot be evidence for that decision, and the whole product rests on never
explaining a day with something nobody could have read that day.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from .config import settings
from .db import Database
from .gateway.router import Gateway, QuotaExhausted
from .index import embed_texts, to_pgvector

RRF_K = 60


@dataclass
class Hit:
    chunk_id: str
    document_id: str
    text: str
    locator: dict
    section_path: str | None
    source: str
    title: str
    url: str
    external_id: str | None
    revision: str | None
    published_at: datetime | None
    sha256: str
    score: float
    vector_rank: int | None = None
    text_rank: int | None = None


# `SGI N° 46.066-26` is written with a degree sign as often as with an ordinal
# indicator, and the difference is invisible to a reader and fatal to a regex.
CODE = re.compile(
    r"\b(?:IO|IT|RT|NT)-[A-Z0-9.]{2,}|\bSGI\s*(?:N[º°º°]?\.?)?\s*[\d.]+-\d+|\bLT\s+\d{2,3}\s*kV\b",
    re.I,
)


def codes_in(text: str) -> list[str]:
    """Identifiers worth searching literally: they are how the ONS cites itself."""
    return sorted({match.group(0).strip() for match in CODE.finditer(text or "")})


STOPWORDS = {
    "que",
    "dos",
    "das",
    "com",
    "para",
    "por",
    "uma",
    "uns",
    "pelo",
    "pela",
    "nos",
    "nas",
    "sao",
    "esse",
    "essa",
    "onde",
    "esta",
    "este",
    "dia",
    "sobre",
    "qual",
    "quais",
    "diz",
    "documento",
}


def to_or_tsquery(question: str) -> str:
    """Build an OR query the Portuguese dictionary accepts.

    `websearch_to_tsquery` reads a phrase as a conjunction, and a record like
    "LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO" then matches nothing
    because no single chunk carries every word. What we want is the opposite: any
    of these terms, ranked. Codes are kept whole, since `IO-ON.NE.2SO` is one
    lexeme to the dictionary and the most discriminating term in the sentence.
    """
    terms: list[str] = []
    for code in codes_in(question):
        terms.append(code.replace(" ", ""))
    for word in re.findall(r"[\wÀ-ÿ]{3,}", question.lower()):
        if word in STOPWORDS or word.isdigit():
            continue
        terms.append(word)
    unique = list(dict.fromkeys(terms))[:28]
    escaped = [re.sub(r"[^\wÀ-ÿ.\-]", "", term) for term in unique]
    return " | ".join(term for term in escaped if term) or "restricao"


async def search(
    db: Database,
    gateway: Gateway,
    question: str,
    *,
    published_before: datetime | None = None,
    sources: list[str] | None = None,
    limit: int | None = None,
) -> list[Hit]:
    pool = await db.connect()
    conf = settings()
    limit = limit or conf.rerank_top_n

    # The index of a document is not evidence, and it beats the body on keywords.
    filters = ["coalesce(c.locator->>'kind', 'body') <> 'toc'"]
    params: list = []
    if published_before is not None:
        params.append(published_before)
        filters.append(f"(d.published_at IS NULL OR d.published_at <= ${len(params)})")
    if sources:
        params.append(sources)
        filters.append(f"d.source = ANY(${len(params)})")
    where = " AND ".join(filters)

    text_query = to_or_tsquery(question)

    vector_rows: list = []
    try:
        vectors, _ = await embed_texts(gateway, [question], input_type="query")
        params_vec = [*params, to_pgvector(vectors[0]), conf.hybrid_vector_k]
        async with pool.acquire() as conn:
            vector_rows = await conn.fetch(
                f"""
                SELECT c.id, c.document_id, c.text, c.locator, c.section_path,
                       d.source, d.title, d.url, d.external_id, d.revision, d.published_at, d.sha256,
                       1 - (c.embedding <=> ${len(params) + 1}::vector) AS similarity
                  FROM rag.chunk c JOIN rag.document d ON d.id = c.document_id
                 WHERE {where} AND c.embedding IS NOT NULL
                 ORDER BY c.embedding <=> ${len(params) + 1}::vector
                 LIMIT ${len(params) + 2}
                """,
                *params_vec,
            )
    except QuotaExhausted:
        vector_rows = []  # text search alone still answers; the trace says so

    params_txt = [*params, text_query, conf.hybrid_text_k]
    async with pool.acquire() as conn:
        text_rows = await conn.fetch(
            f"""
            SELECT c.id, c.document_id, c.text, c.locator, c.section_path,
                   d.source, d.title, d.url, d.external_id, d.revision, d.published_at, d.sha256,
                   ts_rank_cd(c.tsv, q) AS similarity
              FROM rag.chunk c JOIN rag.document d ON d.id = c.document_id,
                   to_tsquery('portuguese', ${len(params) + 1}) AS q
             WHERE {where} AND c.tsv @@ q
             ORDER BY similarity DESC
             LIMIT ${len(params) + 2}
            """,
            *params_txt,
        )

    fused: dict[str, Hit] = {}
    for rank, row in enumerate(vector_rows, start=1):
        hit = _to_hit(row, RRF_K, rank)
        hit.vector_rank = rank
        fused[str(row["id"])] = hit
    for rank, row in enumerate(text_rows, start=1):
        key = str(row["id"])
        if key in fused:
            fused[key].score += 1.0 / (RRF_K + rank)
            fused[key].text_rank = rank
        else:
            hit = _to_hit(row, RRF_K, rank)
            hit.text_rank = rank
            fused[key] = hit

    ranked = sorted(fused.values(), key=lambda hit: hit.score, reverse=True)
    return ranked[:limit]


def _to_hit(row, k: int, rank: int) -> Hit:
    return Hit(
        chunk_id=str(row["id"]),
        document_id=str(row["document_id"]),
        text=row["text"],
        locator=row["locator"] if isinstance(row["locator"], dict) else {},
        section_path=row["section_path"],
        source=row["source"],
        title=row["title"],
        url=row["url"],
        external_id=row["external_id"],
        revision=row["revision"],
        published_at=row["published_at"],
        sha256=row["sha256"],
        score=1.0 / (k + rank),
    )
