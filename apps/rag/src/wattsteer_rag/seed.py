"""The corpus, packed so that nobody has to build it twice.

Reading the documents costs quota and time: the operating instructions are
published as images, so every page goes through a vision model. Doing that once
and shipping the result means a new machine is useful in a minute, with no key
and no network, and the keys are only needed for asking questions.

The seed carries documents, pages and chunks **with their embeddings**. It does
not carry the original PDFs: they are reachable from `document.url` and are only
needed to parse again.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .db import Database

SEED_PATH = Path(__file__).resolve().parents[2] / "seed" / "corpus.jsonl.gz"
SEED_VERSION = 1


def _encode(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


async def dump(db: Database, path: Path = SEED_PATH) -> dict:
    """Write the corpus as one gzipped JSON line per row.

    JSON rather than a database dump, because the seed has to survive a Postgres
    upgrade and be readable by a person who wants to know what is in it.
    """
    pool = await db.connect()
    path.parent.mkdir(parents=True, exist_ok=True)
    counts = {"document": 0, "page": 0, "chunk": 0}
    out = gzip.open(path, "wt", encoding="utf-8")
    async with pool.acquire() as conn:
        out.write(json.dumps({"seed_version": SEED_VERSION, "written_at": datetime.now().isoformat()}) + "\n")
        for table, query in (
            ("document", "SELECT * FROM rag.document ORDER BY fetched_at"),
            ("page", "SELECT * FROM rag.page ORDER BY document_id, page_no"),
            (
                "chunk",
                # Five decimals is far more precision than a cosine ranking can
                # use, and it is what keeps the packed corpus small enough to
                # live in the repository instead of in a bucket nobody can reach.
                "SELECT id, document_id, ordinal, page_start, page_end, section_path, locator, text,"
                " tokens, (SELECT '[' || string_agg(round(value::numeric, 5)::text, ',') || ']'"
                "   FROM unnest(embedding::real[]) AS value) AS embedding,"
                " embedding_model FROM rag.chunk ORDER BY document_id, ordinal",
            ),
        ):
            async for row in _cursor(conn, query):
                record = {key: _encode(value) for key, value in dict(row).items()}
                record["_table"] = table
                out.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
                counts[table] += 1
    out.close()
    return {"path": str(path), "rows": counts, "bytes": path.stat().st_size}


async def _cursor(conn, query: str):
    async with conn.transaction():
        async for row in conn.cursor(query):
            yield row


async def load(db: Database, path: Path = SEED_PATH, *, replace: bool = False) -> dict:
    """Load the packed corpus. Idempotent: a row that is already there is skipped."""
    if not path.exists():
        return {"loaded": False, "reason": f"no seed at {path}"}
    await db.migrate()
    pool = await db.connect()
    counts = {"document": 0, "page": 0, "chunk": 0, "skipped": 0}

    async with pool.acquire() as conn:
        if replace:
            await conn.execute("TRUNCATE rag.chunk, rag.page, rag.document CASCADE")
        async with conn.transaction(), gzip.open(path, "rt", encoding="utf-8") as handle:
            header = json.loads(handle.readline())
            if header.get("seed_version") != SEED_VERSION:
                return {"loaded": False, "reason": f"seed version {header.get('seed_version')} not supported"}
            for line in handle:
                record = json.loads(line)
                table = record.pop("_table")
                if table == "document":
                    inserted = await conn.fetchval(
                        "INSERT INTO rag.document (id, source, external_id, revision, title, url,"
                        " published_at, fetched_at, sha256, bytes, mime, pages, status, needs_review, meta)"
                        " VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,"
                        "$9,$10,$11,$12,$13,$14,$15::jsonb)"
                        " ON CONFLICT (source, sha256) DO NOTHING RETURNING 1",
                        record["id"],
                        record["source"],
                        record["external_id"],
                        record["revision"],
                        record["title"],
                        record["url"],
                        record["published_at"],
                        record["fetched_at"],
                        record["sha256"],
                        record["bytes"],
                        record["mime"],
                        record["pages"],
                        record["status"],
                        record["needs_review"],
                        record["meta"],
                    )
                elif table == "page":
                    inserted = await conn.fetchval(
                        "INSERT INTO rag.page (document_id, page_no, markdown, blocks, has_tables, parser)"
                        " VALUES ($1::uuid,$2,$3,$4::jsonb,$5,$6)"
                        " ON CONFLICT (document_id, page_no) DO NOTHING RETURNING 1",
                        record["document_id"],
                        record["page_no"],
                        record["markdown"],
                        record["blocks"],
                        record["has_tables"],
                        record["parser"],
                    )
                else:
                    inserted = await conn.fetchval(
                        "INSERT INTO rag.chunk (id, document_id, ordinal, page_start, page_end,"
                        " section_path, locator, text, tokens, embedding, embedding_model)"
                        " VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::vector,$11)"
                        " ON CONFLICT (document_id, ordinal) DO NOTHING RETURNING 1",
                        record["id"],
                        record["document_id"],
                        record["ordinal"],
                        record["page_start"],
                        record["page_end"],
                        record["section_path"],
                        record["locator"],
                        record["text"],
                        record["tokens"],
                        record["embedding"],
                        record["embedding_model"],
                    )
                if inserted:
                    counts[table] += 1
                else:
                    counts["skipped"] += 1
    counts["loaded"] = True
    return counts
