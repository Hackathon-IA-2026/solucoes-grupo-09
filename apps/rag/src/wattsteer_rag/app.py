"""The HTTP surface.

Everything here is internal. The public product never calls this service to
answer a request: a job writes evidence into Postgres and the product reads the
table, which is the same boundary apps/ml lives behind.

The debug routes exist because a retrieval failure is otherwise invisible. They
answer three questions: what came back from the search and in which order, what
the model tried to say, and which gate refused it.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse

import httpx

from .config import settings
from .console import page
from .crawl import Crawler
from .db import Database
from .evidence import build_evidence, question_for
from .gateway.router import Gateway, QuotaExhausted
from .index import embed_pending
from .ingest import ingest_document, pending_documents
from .retrieve import search
from .runtime import open_runtime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("wattsteer_rag")

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with open_runtime() as runtime:
        state["db"] = runtime.db
        state["gateway"] = runtime.gateway
        yield


app = FastAPI(title="WattSteer RAG", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def require_token(request, call_next):
    """A shared secret, for when the service is not on the loopback address.

    These routes run models and read the corpus, and none of them asks who is
    calling. On 127.0.0.1 that is fine. Reachable from a network it is not, so
    binding wider means setting WATTSTEER_RAG_ACCESS_TOKEN, and then nothing but
    the health check answers without it.
    """
    token = settings().access_token
    if token and request.url.path != "/health":
        given = request.query_params.get("k") or request.headers.get("x-access-token") or ""
        if not secrets.compare_digest(given, token):
            return error("unauthorised", "This service needs an access token.", 401)
    return await call_next(request)


def error(code: str, message: str, status: int, **details) -> JSONResponse:
    """The gateway's envelope, so a client never has to learn a second shape."""
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "details": details or None}},
    )


@app.get("/", response_class=HTMLResponse)
async def console() -> str:
    """The same debug routes, arranged so a person can use them."""
    return page()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "wattsteer-rag"}


@app.get("/ready")
async def ready() -> Any:
    db: Database = state["db"]
    gateway: Gateway = state["gateway"]
    checks = await db.ready()
    providers = {
        name: {"enabled": provider.enabled, "keys": len(provider.keys)}
        for name, provider in gateway.providers.items()
    }
    usable_tasks = {task: len(gateway.usable_links(task)) for task in gateway.tasks}
    ok = checks.get("database") and checks.get("pgvector") and checks.get("schema")
    body = {"ready": bool(ok), "database": checks, "providers": providers, "tasks": usable_tasks}
    return body if ok else JSONResponse(status_code=503, content=body)


@app.get("/internal/llm/quota")
async def quota() -> dict:
    return state["gateway"].quota()


@app.get("/internal/rag/status")
async def status() -> dict:
    db: Database = state["db"]
    pool = await db.connect()
    async with pool.acquire() as conn:
        by_source = await conn.fetch(
            "SELECT source, count(*) AS documents, sum(pages) AS pages, max(fetched_at) AS last_fetch"
            " FROM rag.document GROUP BY source ORDER BY source"
        )
        chunks = await conn.fetchrow(
            "SELECT count(*) AS total, count(embedding) AS embedded,"
            " count(DISTINCT embedding_model) AS models FROM rag.chunk"
        )
        evidence = await conn.fetchrow(
            "SELECT count(*) AS total, count(*) FILTER (WHERE verdict = 'found') AS found FROM rag.evidence"
        )
    return {
        "corpus_version": await db.corpus_version(),
        "sources": [dict(row) for row in by_source],
        "chunks": dict(chunks) if chunks else {},
        "evidence": dict(evidence) if evidence else {},
    }


@app.post("/internal/rag/refresh", status_code=202)
async def refresh(days: int = Query(1, ge=1, le=7)) -> dict:
    """Fetch yesterday's daily record, index it, and say so.

    **Why this exists at all.** The normative corpus — the operating
    instructions and the network procedures — changes a few times a year, and a
    one-off ingest is the right answer for it. The daily record is not like
    that: BDO and IPDO are published every day, and without something fetching
    them "the date the corpus covers" stops moving while every other signal
    keeps saying the service is healthy. A query about last Tuesday would answer
    `corpus_no_coverage_for_date` and nothing anywhere would explain why.

    **Why an endpoint and not a cron service.** A Railway volume attaches to
    exactly one service, and the store lives on this one's. A separate scheduler
    could not write `/data/rag-store`. And `data-platform.md` asks for one
    scheduler rather than two, which the API's worker already is — so the shape
    that fits is: the worker owns *when*, this service owns *how*.

    **202, not 200.** A day of BDO is a couple of dozen documents and the
    embedding step is rate-limited by the provider, so this can outlive any
    sensible request timeout. The work is started and the caller is told where
    to look: `corpus_version` in `/internal/rag/status` carries the newest
    `fetched_at`, so a refresh that did something changes it.
    """
    if state.get("refreshing"):
        return {"started": False, "reason": "a refresh is already running"}
    state["refreshing"] = True
    asyncio.create_task(_refresh(days))
    return {"started": True, "days": days}


async def _refresh(days: int) -> None:
    """Crawl, ingest, embed — and give up on quota rather than waiting for it.

    `embed_pending` stops on `QuotaExhausted` by design: the free tier's ceiling
    is per minute, and a task that slept through it would hold the runtime open
    for an hour to save a caller one retry. What is left stays `chunked` and the
    next run finishes it, which is why this is safe to schedule daily and safe
    to run twice.
    """
    db: Database = state["db"]
    gateway: Gateway = state["gateway"]
    try:
        crawler = Crawler(db)
        async with httpx.AsyncClient() as client:
            for back in range(days):
                await crawler.fetch_bdo(client, date.today() - timedelta(days=back + 1))
                await crawler.fetch_ipdo(client, date.today() - timedelta(days=back))
        for row in await pending_documents(db, limit=60):
            await ingest_document(db, gateway, row)
        await embed_pending(db, gateway)
    except QuotaExhausted:
        log.info("refresh: stopped on provider quota; the next run finishes it")
    except Exception:
        log.exception("refresh failed")
    finally:
        state["refreshing"] = False


@app.get("/internal/rag/search")
async def debug_search(
    q: str = Query(..., min_length=3),
    published_before: str | None = None,
    limit: int = 8,
) -> Any:
    """What the retrieval saw, with both ranks and the fused score."""
    before = _parse_instant(published_before) or datetime.now(UTC)
    try:
        hits = await search(state["db"], state["gateway"], q, published_before=before, limit=limit)
    except QuotaExhausted as exc:
        return error(
            "RAG_QUOTA_EXHAUSTED",
            "no provider has quota for the query embedding",
            503,
            retry_at=exc.retry_at,
        )
    return {
        "question": q,
        "published_before": before.isoformat(),
        "hits": [
            {
                "chunk_id": hit.chunk_id,
                "document": f"{hit.external_id or hit.source} {hit.revision or ''}".strip(),
                "title": hit.title,
                "published_at": hit.published_at.isoformat() if hit.published_at else None,
                "locator": hit.locator,
                "vector_rank": hit.vector_rank,
                "text_rank": hit.text_rank,
                "rrf": round(hit.score, 5),
                "text": hit.text[:600],
                "url": hit.url,
            }
            for hit in hits
        ],
    }


@app.post("/internal/rag/evidence")
async def evidence(
    subsystem: str,
    target_date: str,
    gate_at: str | None = None,
    reason: str | None = None,
    description: str | None = None,
    question: str | None = None,
) -> Any:
    if subsystem not in {"N", "NE", "SE", "S"}:
        raise HTTPException(status_code=422, detail="subsystem must be one of N, NE, SE, S")
    instant = _parse_instant(gate_at) or datetime.now(UTC)
    document = await build_evidence(
        state["db"],
        state["gateway"],
        subsystem=subsystem,
        target_date=target_date,
        gate_at=instant,
        reason=reason,
        description=description,
        question=question,
    )
    return document


@app.get("/internal/rag/evidence")
async def read_evidence(subsystem: str, target_date: str, limit: int = 10) -> dict:
    """Published evidence, read from the table. No model runs here.

    This is the route that matters for the product: `apps/api` reads what a job
    wrote, and never calls a model to serve a page. It is also the only way to
    look at an answer when the free tier has nothing left this minute.
    """
    try:
        day = date.fromisoformat(target_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="target_date must be YYYY-MM-DD") from None
    pool = await state["db"].connect()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT verdict, reason, payload, corpus_version, sha256, created_at FROM rag.evidence"
            " WHERE subsystem = $1 AND target_date = $2 ORDER BY created_at DESC LIMIT $3",
            subsystem,
            day,
            limit,
        )
    return {"subsystem": subsystem, "target_date": target_date, "rows": [dict(row) for row in rows]}


@app.get("/internal/rag/question")
async def preview_question(
    subsystem: str, target_date: str, reason: str | None = None, description: str | None = None
) -> dict:
    """The question the record turns into, before anything is retrieved."""
    return {"question": question_for(subsystem, target_date, reason, description)}


def _parse_instant(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def main() -> None:
    import uvicorn

    conf = settings()
    uvicorn.run(app, host=conf.host, port=conf.port)


if __name__ == "__main__":  # `python -m wattsteer_rag.app`
    main()
