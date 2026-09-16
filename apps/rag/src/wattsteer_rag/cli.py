"""Command line: ingest, search, explain, and check that the parts are alive.

`doctor` and `explain` exist for the same reason as the debug routes: when the
answer is wrong, the question is always "which step went wrong", and guessing is
expensive.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, date, datetime, timedelta

import httpx

from .chunk import chunk_pages
from .config import settings
from .crawl import Crawler
from .db import Database
from .evidence import build_evidence, question_for
from .gateway.adapters import Block
from .gateway.router import Gateway, QuotaExhausted
from .index import embed_pending, index_document
from .parse import blocks_to_markdown, parse_html_tables, parse_pdf
from .retrieve import search
from .seed import dump as seed_dump
from .seed import load as seed_load


def gateway() -> Gateway:
    conf = settings()
    return Gateway(conf.gateway_config, user_agent=conf.user_agent)


async def cmd_migrate(_args) -> int:
    db = Database()
    applied = await db.migrate()
    print(f"migrations applied: {applied or 'none pending'}")
    print(json.dumps(await db.ready(), indent=2, default=str))
    await db.close()
    return 0


async def cmd_doctor(_args) -> int:
    """Is every part of the chain actually reachable, right now?"""
    db, gw = Database(), gateway()
    checks = await db.ready()
    print("database:", json.dumps(checks, default=str))
    for name, provider in gw.providers.items():
        print(
            f"provider {name:<14} kind={provider.kind:<18} keys={len(provider.keys)} enabled={provider.enabled}"
        )
    for task in ("parse", "embed", "generate_small", "generate_strong"):
        links = gw.usable_links(task)
        labels = [f"{provider.name}:{link.model}" for link, provider in links]
        print(f"task {task:<15} links={labels or 'NONE'}")
    try:
        result = await gw.run("embed", tokens=8, texts=["teste de conectividade"], input_type="query")
        print(
            f"embed live: {result.model} dims={len(result.value[0])} via key {result.key_id} "
            f"in {result.latency_ms}ms"
        )
    except QuotaExhausted as exc:
        print(f"embed live: no quota, retry at {exc.retry_at}")
    except Exception as exc:  # noqa: BLE001 - the whole point is to report it
        print(f"embed live: FAILED {type(exc).__name__}: {exc}")
    await gw.aclose()
    await db.close()
    return 0


async def cmd_crawl(args) -> int:
    db, crawler = Database(), None
    await db.migrate()
    crawler = Crawler(db)
    async with httpx.AsyncClient() as client:
        report = []
        if args.what in {"instructions", "all"}:
            report += await crawler.fetch_instructions(client, args.codes)
        if args.what in {"procedures", "all"}:
            report += await crawler.fetch_procedures(client)
        if args.what in {"bdo", "all"}:
            for back in range(args.days):
                report += await crawler.fetch_bdo(client, date.today() - timedelta(days=back + 1))
        if args.what in {"ipdo", "all"}:
            for back in range(args.days):
                report.append(await crawler.fetch_ipdo(client, date.today() - timedelta(days=back)))
        if args.what == "ipdo-archive":
            report += await crawler.fetch_ipdo_archive(client, limit=args.limit, attempts=args.attempts)
        if args.what in {"rap", "all"}:
            report += await crawler.fetch_rap(client, args.urls or [])
    print(json.dumps(report, indent=2, ensure_ascii=False))
    await db.close()
    return 0


async def cmd_ingest(args) -> int:
    """Parse, chunk and embed everything that is fetched but not yet indexed."""
    db, gw = Database(), gateway()
    await db.migrate()
    pool = await db.connect()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, sha256, title, external_id, mime FROM rag.document"
            " WHERE status IN ('fetched','parsed') ORDER BY fetched_at LIMIT $1",
            args.limit,
        )
    if not rows:
        print("nothing pending")
    for row in rows:
        store = settings().store_dir
        suffix = ".html" if (row["mime"] or "").startswith("text/html") else ".pdf"
        path = store / f"{row['sha256']}{suffix}"
        if not path.exists():
            print(f"{row['external_id']}: file missing, skipping")
            continue
        if suffix == ".html":
            pages = parse_html_tables(path)
        else:
            pages = await parse_pdf(gw, path, max_pages=args.max_pages)
        async with pool.acquire() as conn:
            await conn.executemany(
                "INSERT INTO rag.page (document_id, page_no, markdown, blocks, has_tables, parser)"
                " VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (document_id, page_no) DO UPDATE"
                " SET markdown = excluded.markdown, blocks = excluded.blocks, parser = excluded.parser",
                [
                    (
                        row["id"],
                        page.page_no,
                        page.markdown,
                        page.blocks,
                        page.has_tables,
                        page.parser,
                    )
                    for page in pages
                ],
            )
            await conn.execute(
                "UPDATE rag.document SET status = 'parsed', pages = $2 WHERE id = $1",
                row["id"],
                len(pages),
            )
        chunks = chunk_pages(
            [{"page_no": p.page_no, "markdown": p.markdown, "blocks": p.blocks} for p in pages]
        )
        result = await index_document(db, gw, str(row["id"]), chunks)
        parsers = sorted({page.parser for page in pages})
        print(
            f"{row['external_id'] or row['title'][:28]}: {len(pages)} pages via {parsers}, "
            f"{len(chunks)} chunks, {result['embedded']} embedded"
            + (
                f", waiting quota until {result['waiting_quota_until']}"
                if result["waiting_quota_until"]
                else ""
            )
        )
    await gw.aclose()
    await db.close()
    return 0


async def cmd_rechunk(args) -> int:
    """Re-chunk from the pages already parsed. Costs no parsing quota.

    The chunking strategy changes far more often than the documents do, and
    re-reading 20 pages through a vision model to test a boundary rule would be
    both slow and wasteful.
    """
    db, gw = Database(), gateway()
    pool = await db.connect()
    async with pool.acquire() as conn:
        documents = await conn.fetch(
            "SELECT id, external_id, title FROM rag.document WHERE pages > 0"
            + (" AND external_id = $1" if args.document else "")
            + " ORDER BY fetched_at",
            *([args.document] if args.document else []),
        )
    for document in documents:
        async with pool.acquire() as conn:
            pages = await conn.fetch(
                "SELECT page_no, markdown, blocks FROM rag.page WHERE document_id = $1 ORDER BY page_no",
                document["id"],
            )
            await conn.execute("DELETE FROM rag.chunk WHERE document_id = $1", document["id"])
        # Rebuild the page text from the blocks the parser returned, so a change
        # in how tables are rendered does not require paying for the pages again.
        rebuilt = []
        for page in pages:
            blocks = [
                Block(type=b.get("type", "Text"), text=b.get("text", ""), bbox=b.get("bbox"))
                for b in (page["blocks"] or [])
            ]
            markdown, has_tables = blocks_to_markdown(blocks) if blocks else (page["markdown"], False)
            rebuilt.append({"page_no": page["page_no"], "markdown": markdown, "blocks": page["blocks"]})
            if blocks:
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE rag.page SET markdown = $3, has_tables = $4"
                        " WHERE document_id = $1 AND page_no = $2",
                        document["id"],
                        page["page_no"],
                        markdown,
                        has_tables,
                    )
        chunks = chunk_pages(rebuilt)
        result = await index_document(db, gw, str(document["id"]), chunks)
        print(
            f"{document['external_id']}: {len(pages)} pages, {len(chunks)} chunks, "
            f"{result['embedded']} embedded"
        )
    await gw.aclose()
    await db.close()
    return 0


async def cmd_embed(args) -> int:
    db, gw = Database(), gateway()
    print(json.dumps(await embed_pending(db, gw, limit=args.limit), indent=2, default=str))
    await gw.aclose()
    await db.close()
    return 0


async def cmd_seed(args) -> int:
    """Load the packed corpus, or pack the current one."""
    db = Database()
    if args.action == "dump":
        print(json.dumps(await seed_dump(db), indent=2, default=str))
    else:
        before = await db.counts() if args.action == "load" else {}
        result = await seed_load(db, replace=args.replace)
        print(json.dumps(result, indent=2, default=str))
        if result.get("loaded"):
            print(json.dumps({"before": before, "after": await db.counts()}, indent=2, default=str))
    await db.close()
    return 0


async def cmd_search(args) -> int:
    db, gw = Database(), gateway()
    before = datetime.fromisoformat(args.before) if args.before else datetime.now(UTC)
    if before.tzinfo is None:
        before = before.replace(tzinfo=UTC)
    hits = await search(db, gw, args.question, published_before=before, limit=args.limit)
    for position, hit in enumerate(hits, start=1):
        marks = f"v{hit.vector_rank or '-'} t{hit.text_rank or '-'}"
        where = hit.locator.get("section") or hit.section_path or f"p.{hit.locator.get('page')}"
        print(
            f"\n{position}. [{marks} rrf={hit.score:.4f}] {hit.external_id or hit.source} {hit.revision or ''}"
            f" | {where}"
        )
        print("   " + hit.text[:280].replace("\n", " "))
    if not hits:
        print("no hits")
    await gw.aclose()
    await db.close()
    return 0


async def cmd_evidence(args) -> int:
    db, gw = Database(), gateway()
    gate_at = datetime.fromisoformat(args.gate_at) if args.gate_at else datetime.now(UTC)
    if gate_at.tzinfo is None:
        gate_at = gate_at.replace(tzinfo=UTC)
    document = await build_evidence(
        db,
        gw,
        subsystem=args.subsystem,
        target_date=args.date,
        gate_at=gate_at,
        reason=args.reason,
        description=args.description,
        question=args.question,
    )
    if args.json:
        print(json.dumps(document, indent=2, ensure_ascii=False))
    else:
        _print_evidence(document)
    await gw.aclose()
    await db.close()
    return 0


def _print_evidence(document: dict) -> None:
    generation = document["trace"]["generation"]
    print(f"\nPergunta: {document['question']}")
    print(f"Veredito: {document['verdict']}" + (f" ({document['reason']})" if document["reason"] else ""))
    print(f"Modelo: {generation['provider']}:{generation['model']} tentativas={generation['attempts']}")
    for item in document["items"]:
        print(f"\n  [{item['supports']} {item['confidence']} peso={item['evidence_weight']}] {item['claim']}")
        for citation in item["citations"]:
            locator = citation["locator"]
            where = locator.get("section") or (f"página {locator['page']}" if locator.get("page") else "")
            print(
                f"    fonte: {citation['title']} {citation.get('revision') or ''} | {where}"
                f" | publicado {citation['published_at'] or 'sem data'}"
            )
            print(f'    trecho: "{citation["quote"][:200]}"')
    rejected = generation.get("rejected") or []
    if rejected:
        print(f"\n  recusadas ({len(rejected)}):")
        for item in rejected:
            codes = ", ".join(failure["code"] for failure in item["failures"])
            print(f"    - {item['claim'][:110]}  [{codes}]")
    candidates = document["trace"]["retrieval"].get("candidates") or []
    if candidates:
        print(f"\n  candidatos ({len(candidates)}):")
        for candidate in candidates[:8]:
            print(
                f"    {candidate['rrf']:.4f} v{candidate['vector_rank'] or '-'} t{candidate['text_rank'] or '-'}"
                f" {candidate['document']} {candidate['locator'].get('section') or ''}"
            )


async def cmd_question(args) -> int:
    print(question_for(args.subsystem, args.date, args.reason, args.description))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="wattsteer-rag")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("migrate").set_defaults(run=cmd_migrate)
    sub.add_parser("doctor").set_defaults(run=cmd_doctor)

    crawl = sub.add_parser("crawl", help="fetch the documents the records cite")
    crawl.add_argument(
        "what",
        choices=["instructions", "procedures", "bdo", "ipdo", "ipdo-archive", "rap", "all"],
        default="all",
        nargs="?",
    )
    crawl.add_argument("--codes", nargs="*")
    crawl.add_argument("--days", type=int, default=1, help="bdo and ipdo: how many days back")
    crawl.add_argument("--limit", type=int, default=20, help="ipdo-archive: how many editions")
    crawl.add_argument("--urls", nargs="*", help="rap: published URLs")
    crawl.add_argument(
        "--attempts", type=int, default=4, help="how many times to retry a document that fails"
    )
    crawl.set_defaults(run=cmd_crawl)

    ingest = sub.add_parser("ingest", help="parse, chunk and embed pending documents")
    ingest.add_argument("--limit", type=int, default=5)
    ingest.add_argument("--max-pages", type=int, default=None)
    ingest.set_defaults(run=cmd_ingest)

    seed = sub.add_parser("seed", help="load the packed corpus, or pack the current one")
    seed.add_argument("action", choices=["load", "dump"], nargs="?", default="load")
    seed.add_argument("--replace", action="store_true", help="wipe the corpus before loading")
    seed.set_defaults(run=cmd_seed)

    rechunk = sub.add_parser("rechunk", help="re-chunk stored pages without re-parsing")
    rechunk.add_argument("--document", default=None, help="external id, for example IO-ON.NE.2SO")
    rechunk.set_defaults(run=cmd_rechunk)

    embed = sub.add_parser("embed", help="embed chunks left without a vector")
    embed.add_argument("--limit", type=int, default=None)
    embed.set_defaults(run=cmd_embed)

    query = sub.add_parser("search", help="hybrid search, with both ranks")
    query.add_argument("question")
    query.add_argument("--before", default=None)
    query.add_argument("--limit", type=int, default=8)
    query.set_defaults(run=cmd_search)

    evidence = sub.add_parser("evidence", help="build the evidence document for a record")
    evidence.add_argument("subsystem")
    evidence.add_argument("date")
    evidence.add_argument("--gate-at", default=None)
    evidence.add_argument("--reason", default=None)
    evidence.add_argument("--description", default=None)
    evidence.add_argument("--question", default=None)
    evidence.add_argument("--json", action="store_true")
    evidence.set_defaults(run=cmd_evidence)

    question = sub.add_parser("question", help="show the question a record turns into")
    question.add_argument("subsystem")
    question.add_argument("date")
    question.add_argument("--reason", default=None)
    question.add_argument("--description", default=None)
    question.set_defaults(run=cmd_question)

    args = parser.parse_args()
    return asyncio.run(args.run(args))


if __name__ == "__main__":
    sys.exit(main())
