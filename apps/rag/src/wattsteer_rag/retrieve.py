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
from datetime import date, datetime

from .config import settings
from .db import Database
from .gateway.router import Gateway, QuotaExhausted
from .index import embed_texts, to_pgvector
from .rerank import rerank

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
    named_documents: list[str] | None = None,
    target_date: str | None = None,
    limit: int | None = None,
    report: dict | None = None,
) -> list[Hit]:
    """The fused candidates, reranked if a reranker is configured, cut to `limit`.

    `report`, when given, is where this writes what it did — today only
    `rerank_provider`, which the evidence trace publishes and which is `None`
    whenever the RRF order was kept. It is an argument rather than a second
    return value because both callers already hold the dict it belongs in, and
    a tuple would have been unpacked and discarded at one of them.
    """
    pool = await db.connect()
    conf = settings()
    limit = limit or conf.top_hits
    await db.assert_single_vector_space()

    # The index of a document is not evidence, and it beats the body on keywords.
    # A withdrawn revision is not evidence either, and reads exactly like the one
    # that replaced it.
    filters = [
        "coalesce(c.locator->>'kind', 'body') NOT IN ('toc', 'furniture')",
        "d.status <> 'superseded'",
    ]
    params: list = []
    if published_before is not None:
        params.append(published_before)
        filters.append(f"(d.published_at IS NULL OR d.published_at <= ${len(params)})")
    if sources:
        params.append(sources)
        filters.append(f"d.source = ANY(${len(params)})")
    if named_documents:
        # The record says which operating instruction it is about, so no other
        # one is a candidate. IO-ON.NE.2LE and IO-ON.NE.5NE cover neighbouring
        # areas of the Northeast in the same sentences, and without this the
        # search ranks the wrong area's text above the right one and the answer
        # cites a real document about somewhere else. Other sources stay open:
        # the general rules are never named by a record and are still evidence.
        params.append(named_documents)
        filters.append(f"(d.source <> 'INSTRUCAO_OPERACAO' OR d.external_id = ANY(${len(params)}))")
    if target_date:
        # A daily bulletin of another day is refused by the relevance gate
        # (evidence.DAILY_REPORTS), so it must not take a slot here either.
        # Measured on 18/09/2026: once the BDO was indexed row by row, a
        # question about the IPDO of 01/09/2025 retrieved four BDO rows dated
        # "01/09/2026" and the right IPDO was not among the eight passages.
        params.append(date.fromisoformat(target_date))
        # The disturbance report follows the same rule as the gate: it counts
        # for the day it analyses. With all 572 pages of the 2023 report
        # indexed, its pages took slots from questions about other years.
        filters.append(
            "(d.source NOT IN ('BDO','IPDO','RAP') OR d.published_at IS NULL"
            f" OR (d.published_at AT TIME ZONE 'UTC')::date - ${len(params)}::date"
            " BETWEEN 0 AND CASE d.source WHEN 'IPDO' THEN 1 ELSE 0 END)"
        )
    where = " AND ".join(filters)

    text_query = to_or_tsquery(question)

    vector_rows: list = []
    try:
        vectors, _ = await embed_texts(gateway, [question], input_type="query")
        params_vec = [*params, to_pgvector(vectors[0]), conf.hybrid_vector_k]
        async with pool.acquire() as conn, conn.transaction():
            # The HNSW index returns its nearest neighbours and the filters run
            # after it. Measured on 22/09/2026: once the IPDOs and the RAP were
            # re-chunked, the 40 nearest chunks to a question about 21/09 were
            # all bulletins of other days, the date filter removed every one,
            # and the vector arm returned nothing, silently. Iterative scan
            # keeps reading the index, in exact distance order, until the
            # filtered rows fill the limit (pgvector 0.8).
            #
            # And the graph is approximate: with the default ef_search of 40, the
            # chunk nearest to "quais motivos ... no submercado Nordeste" (cosine
            # 0.586) was not reached at all, and two of its neighbours at 0.44
            # were. At 200 the order equals the exact scan's, measured at 13 ms
            # against 15 over 18,364 chunks.
            await conn.execute("SET LOCAL hnsw.iterative_scan = strict_order")
            await conn.execute("SET LOCAL hnsw.ef_search = 200")
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
    # Reranked **before** the cut, which is the only order in which it can help:
    # the measured miss is a passage the fusion ranked 11th with the cut at 8,
    # and reordering what already survived the cut could never reach it. The
    # filters above are correctness rules and have already run, so this reorders
    # strictly inside what they allowed.
    reranking = rerank(question, ranked, limit, model=settings().rerank_model)
    if report is not None:
        report["rerank_provider"] = reranking.provider
    return reranking.hits


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
