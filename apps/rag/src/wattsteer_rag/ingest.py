"""From a fetched document to searchable chunks: pages, then chunks, then vectors.

One door for the two ways a document enters the index. `ingest_document` reads
the fetched file and stores its pages; `rechunk_document` rebuilds the pages from
the blocks already stored, which costs no parsing quota and is how a chunking
rule gets tested. Both end in `_index`, so a change in how tables are rendered
cannot make the two paths disagree.
"""

from __future__ import annotations

from dataclasses import dataclass

from .chunk import chunk_pages
from .config import settings
from .db import Database
from .gateway.adapters import Block
from .gateway.router import Gateway
from .index import index_document
from .parse import ParsedPage, blocks_to_markdown, parse_html_tables, parse_pdf


@dataclass
class IngestReport:
    document: str
    pages: int = 0
    parsers: tuple[str, ...] = ()
    chunks: int = 0
    embedded: int = 0
    waiting_quota_until: float | None = None
    skipped: str | None = None

    def line(self) -> str:
        if self.skipped:
            return f"{self.document}: {self.skipped}"
        line = f"{self.document}: {self.pages} pages via {list(self.parsers)}, {self.chunks} chunks, "
        line += f"{self.embedded} embedded"
        if self.waiting_quota_until:
            line += f", waiting quota until {self.waiting_quota_until}"
        return line


async def pending_documents(db: Database, limit: int) -> list:
    """Fetched or parsed, oldest first: what `ingest` still has to do."""
    pool = await db.connect()
    async with pool.acquire() as conn:
        return await conn.fetch(
            "SELECT id, sha256, title, external_id, mime FROM rag.document"
            " WHERE status IN ('fetched','parsed') ORDER BY fetched_at LIMIT $1",
            limit,
        )


async def ingest_document(
    db: Database, gateway: Gateway, row, *, max_pages: int | None = None
) -> IngestReport:
    """Parse the stored file, keep its pages, chunk and embed them."""
    label = row["external_id"] or row["title"][:28]
    is_html = (row["mime"] or "").startswith("text/html")
    path = settings().store_dir / f"{row['sha256']}{'.html' if is_html else '.pdf'}"
    if not path.exists():
        return IngestReport(label, skipped="file missing, skipping")
    pages = parse_html_tables(path) if is_html else await parse_pdf(gateway, path, max_pages=max_pages)
    await _store_pages(db, row["id"], pages)
    report = await _index(db, gateway, str(row["id"]), [_as_dict(page) for page in pages])
    report.document = label
    report.parsers = tuple(sorted({page.parser for page in pages}))
    return report


async def rechunk_document(db: Database, gateway: Gateway, document) -> IngestReport:
    """Rebuild the chunks of a document from the pages already stored."""
    pool = await db.connect()
    async with pool.acquire() as conn:
        pages = await conn.fetch(
            "SELECT page_no, markdown, blocks, parser FROM rag.page WHERE document_id = $1 ORDER BY page_no",
            document["id"],
        )
        await conn.execute("DELETE FROM rag.chunk WHERE document_id = $1", document["id"])
        rebuilt = []
        for page in pages:
            # Rebuilt from the blocks the parser returned, so a change in how
            # tables are rendered does not require paying for the pages again.
            blocks = [
                Block(b.get("type", "Text"), b.get("text", ""), b.get("bbox")) for b in page["blocks"] or []
            ]
            markdown = page["markdown"]
            if blocks:
                markdown, has_tables = blocks_to_markdown(blocks)
                await conn.execute(
                    "UPDATE rag.page SET markdown = $3, has_tables = $4"
                    " WHERE document_id = $1 AND page_no = $2",
                    document["id"],
                    page["page_no"],
                    markdown,
                    has_tables,
                )
            rebuilt.append({"page_no": page["page_no"], "markdown": markdown, "blocks": page["blocks"]})
    report = await _index(db, gateway, str(document["id"]), rebuilt)
    report.document = document["external_id"] or document["title"][:28]
    report.parsers = tuple(sorted({page["parser"] for page in pages}))
    return report


async def _store_pages(db: Database, document_id, pages: list[ParsedPage]) -> None:
    pool = await db.connect()
    async with pool.acquire() as conn:
        await conn.executemany(
            "INSERT INTO rag.page (document_id, page_no, markdown, blocks, has_tables, parser)"
            " VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (document_id, page_no) DO UPDATE"
            " SET markdown = excluded.markdown, blocks = excluded.blocks, parser = excluded.parser",
            [(document_id, p.page_no, p.markdown, p.blocks, p.has_tables, p.parser) for p in pages],
        )
        await conn.execute(
            "UPDATE rag.document SET status = 'parsed', pages = $2 WHERE id = $1", document_id, len(pages)
        )


async def _index(db: Database, gateway: Gateway, document_id: str, pages: list[dict]) -> IngestReport:
    chunks = chunk_pages(pages)
    result = await index_document(db, gateway, document_id, chunks)
    return IngestReport(
        document=document_id,
        pages=len(pages),
        chunks=len(chunks),
        embedded=result["embedded"],
        waiting_quota_until=result["waiting_quota_until"],
    )


def _as_dict(page: ParsedPage) -> dict:
    return {"page_no": page.page_no, "markdown": page.markdown, "blocks": page.blocks}
