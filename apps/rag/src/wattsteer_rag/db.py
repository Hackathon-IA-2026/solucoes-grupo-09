"""Postgres access. Thin on purpose: the SQL is the interesting part."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import asyncpg

from .config import settings

MIGRATIONS = Path(__file__).parent / "migrations"


class Database:
    def __init__(self, dsn: str | None = None):
        self.dsn = dsn or settings().dsn
        self.pool: asyncpg.Pool | None = None

    async def connect(self) -> asyncpg.Pool:
        if self.pool is None:

            async def init(conn: asyncpg.Connection) -> None:
                # Without this, jsonb arrives as a string and every caller has to
                # remember to parse it. One of them will forget.
                await conn.set_type_codec(
                    "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
                )

            self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=8, init=init)
        return self.pool

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def migrate(self) -> list[str]:
        pool = await self.connect()
        applied = []
        async with pool.acquire() as conn:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS rag_migration (name text PRIMARY KEY, at timestamptz DEFAULT now())"
            )
            for path in sorted(MIGRATIONS.glob("*.sql")):
                done = await conn.fetchval("SELECT 1 FROM rag_migration WHERE name = $1", path.name)
                if done:
                    continue
                await conn.execute(path.read_text())
                await conn.execute("INSERT INTO rag_migration (name) VALUES ($1)", path.name)
                applied.append(path.name)
        return applied

    async def ready(self) -> dict[str, Any]:
        """What /ready reports: the things whose absence would make work impossible."""
        out: dict[str, Any] = {"database": False, "pgvector": False, "schema": False}
        try:
            pool = await self.connect()
            async with pool.acquire() as conn:
                out["database"] = await conn.fetchval("SELECT 1") == 1
                out["pgvector"] = bool(
                    await conn.fetchval("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
                )
                out["schema"] = bool(
                    await conn.fetchval(
                        "SELECT 1 FROM information_schema.tables "
                        "WHERE table_schema='rag' AND table_name='chunk'"
                    )
                )
                if out["schema"]:
                    out["documents"] = await conn.fetchval("SELECT count(*) FROM rag.document")
                    out["chunks"] = await conn.fetchval("SELECT count(*) FROM rag.chunk")
                    out["embedded"] = await conn.fetchval(
                        "SELECT count(*) FROM rag.chunk WHERE embedding IS NOT NULL"
                    )
        except Exception as exc:  # a dead database is a state, not a crash
            out["error"] = f"{type(exc).__name__}: {exc}"
        return out

    async def corpus_version(self) -> str:
        """Identifies the corpus a piece of evidence was built from."""
        pool = await self.connect()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT count(*) AS n, coalesce(max(fetched_at)::text, '') AS last, "
                "coalesce(string_agg(sha256, ',' ORDER BY sha256), '') AS hashes FROM rag.document"
            )
        digest = hashlib.sha256((row["hashes"] or "").encode()).hexdigest()[:12]
        return f"{row['n']}docs+{(row['last'] or '')[:10]}+{digest}"

    async def log_calls(self, calls: list[dict], trace_id: str | None = None) -> None:
        if not calls:
            return
        pool = await self.connect()
        async with pool.acquire() as conn:
            await conn.executemany(
                "INSERT INTO rag.llm_call (task, provider, key_id, model, attempt, tokens_in, tokens_out,"
                " error, trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [
                    (
                        c["task"],
                        c["provider"],
                        c["key_id"],
                        c["model"],
                        c["attempt"],
                        c["tokens_in"],
                        c["tokens_out"],
                        c["error"],
                        trace_id,
                    )
                    for c in calls
                ],
            )


def jsonb(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
