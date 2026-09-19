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
from .columns import label_columns
from .config import settings
from .db import Database
from .gateway.adapters import Block
from .gateway.router import Gateway
from .index import index_document
from .parse import TEXT_LAYER_PARSER, ParsedPage, blocks_to_markdown, parse_html_tables, parse_pdf


@dataclass
class IngestReport:
    document: str
    pages: int = 0
    parsers: tuple[str, ...] = ()
    chunks: int = 0
    embedded: int = 0
    waiting_quota_until: float | None = None
    skipped: str | None = None
    unread: int = 0

    def line(self) -> str:
        if self.skipped:
            return f"{self.document}: {self.skipped}"
        line = f"{self.document}: {self.pages} pages via {list(self.parsers)}, {self.chunks} chunks, "
        line += f"{self.embedded} embedded"
        if self.waiting_quota_until:
            line += f", waiting quota until {self.waiting_quota_until}"
        if self.unread:
            line += f", {self.unread} pages owed to the vision quota (left pending)"
        return line


async def pending_documents(db: Database, limit: int, again: str | None = None) -> list:
    """Fetched or parsed, oldest first: what `ingest` still has to do.

    `again` names a source (BDO) or a document (RAP 2023-08-15) to read again
    whatever its status: a reader that changed, or a document that an earlier
    run cut at --max-pages, is otherwise never revisited, because it is already
    marked indexed.
    """
    pool = await db.connect()
    async with pool.acquire() as conn:
        if again:
            return await conn.fetch(
                "SELECT id, sha256, title, external_id, mime FROM rag.document"
                " WHERE (source = $2 OR external_id = $2) AND status <> 'superseded'"
                " ORDER BY fetched_at LIMIT $1",
                limit,
                again,
            )
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
    unread: list[int] = []
    pages = (
        parse_html_tables(path, row["title"])
        if is_html
        else await parse_pdf(gateway, path, max_pages=max_pages, unread=unread)
    )
    await _store_pages(db, row["id"], pages, keep=unread)
    report = await _index(db, gateway, str(row["id"]), [_as_dict(page) for page in pages])
    report.document = label
    report.parsers = tuple(sorted({page.parser for page in pages}))
    if unread:
        # Pages owed to the vision quota: back in the queue, so the next
        # `ingest` reads the document again instead of calling it done.
        await _mark_pending(db, row["id"])
        report.unread = len(unread)
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
            markdown, has_tables = _rebuilt_markdown(page)
            if markdown != page["markdown"]:
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


def _rebuilt_markdown(page) -> tuple[str, bool]:
    """A stored page as the current readers would render it, at no parsing cost.

    Vision pages are rebuilt from the blocks the parser returned, so a change in
    how tables are rendered does not require paying for the pages again.
    Text-layer pages keep no blocks; their stored text is the text layer
    itself, so the text-layer rules (column names, columns.py) are applied to
    it again. Without this a stored IPDO kept its unlabelled storage table
    until the whole PDF was read again."""
    blocks = [Block(b.get("type", "Text"), b.get("text", ""), b.get("bbox")) for b in page["blocks"] or []]
    if blocks:
        return blocks_to_markdown(blocks)
    if page["parser"] == TEXT_LAYER_PARSER:
        return label_columns(page["markdown"]), False
    return page["markdown"], False


async def _store_pages(db: Database, document_id, pages: list[ParsedPage], keep: list[int] = ()) -> None:
    """The pages of this read replace the stored ones: a page the new read did
    not return is deleted (unless it is owed to the quota), so a reader fix
    leaves no stale page for a later rechunk to pick up."""
    pool = await db.connect()
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM rag.page WHERE document_id = $1 AND NOT (page_no = ANY($2::int[]))",
            document_id,
            [p.page_no for p in pages] + list(keep),
        )
        await conn.executemany(
            "INSERT INTO rag.page (document_id, page_no, markdown, blocks, has_tables, parser)"
            " VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (document_id, page_no) DO UPDATE"
            " SET markdown = excluded.markdown, blocks = excluded.blocks, parser = excluded.parser",
            [(document_id, p.page_no, p.markdown, p.blocks, p.has_tables, p.parser) for p in pages],
        )
        await conn.execute(
            "UPDATE rag.document SET status = 'parsed', pages = $2 WHERE id = $1", document_id, len(pages)
        )


async def _mark_pending(db: Database, document_id) -> None:
    pool = await db.connect()
    async with pool.acquire() as conn:
        await conn.execute("UPDATE rag.document SET status = 'fetched' WHERE id = $1", document_id)


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
