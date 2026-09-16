"""Command line: crawl, ingest, search, build evidence, and check that the parts are alive.

`doctor` and `question` exist for the same reason as the debug routes: when the
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

from .crawl import Crawler
from .db import Database
from .evidence import build_evidence, question_for
from .gateway.router import QuotaExhausted
from .index import embed_pending
from .ingest import ingest_document, pending_documents, rechunk_document
from .retrieve import search
from .runtime import open_runtime
from .seed import dump as seed_dump
from .seed import load as seed_load


def _instant(value: str | None) -> datetime:
    """An ISO instant from the command line, UTC when it says nothing else."""
    parsed = datetime.fromisoformat(value) if value else datetime.now(UTC)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _dump(value) -> None:
    print(json.dumps(value, indent=2, default=str, ensure_ascii=False))


async def cmd_migrate(_args) -> int:
    db = Database()
    applied = await db.migrate()
    print(f"migrations applied: {applied or 'none pending'}")
    _dump(await db.ready())
    await db.close()
    return 0


async def cmd_doctor(_args) -> int:
    """Is every part of the chain actually reachable, right now?"""
    async with open_runtime() as rt:
        print("database:", json.dumps(await rt.db.ready(), default=str))
        for name, provider in rt.gateway.providers.items():
            print(f"provider {name:<14} keys={len(provider.keys)} enabled={provider.enabled}")
        for task in ("parse", "embed", "generate_strong"):
            labels = [f"{provider.name}:{link.model}" for link, provider in rt.gateway.usable_links(task)]
            print(f"task {task:<15} links={labels or 'NONE'}")
        try:
            result = await rt.gateway.run("embed", tokens=8, texts=["connectivity check"], input_type="query")
            dims = len(result.value[0])
            print(f"embed live: {result.model} dims={dims} via key {result.key_id} in {result.latency_ms}ms")
        except QuotaExhausted as exc:
            print(f"embed live: no quota, retry at {exc.retry_at}")
        except Exception as exc:  # noqa: BLE001 - the whole point is to report it
            print(f"embed live: FAILED {type(exc).__name__}: {exc}")
    return 0


async def cmd_crawl(args) -> int:
    db = Database()
    await db.migrate()
    crawler = Crawler(db)
    report: list = []
    async with httpx.AsyncClient() as client:
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
            report += await crawler.fetch_ipdo_archive(
                client, limit=args.limit, attempts=args.attempts, sample=args.sample
            )
        if args.what in {"rap", "all"}:
            report += await crawler.fetch_rap(client, args.urls or [])
    _dump(report)
    await db.close()
    return 0


async def cmd_ingest(args) -> int:
    """Parse, chunk and embed everything that is fetched but not yet indexed."""
    async with open_runtime(migrate=True) as rt:
        rows = await pending_documents(rt.db, args.limit)
        if not rows:
            print("nothing pending")
        for row in rows:
            report = await ingest_document(rt.db, rt.gateway, row, max_pages=args.max_pages)
            print(report.line())
    return 0


async def cmd_rechunk(args) -> int:
    """Re-chunk from the pages already parsed. Costs no parsing quota."""
    async with open_runtime() as rt:
        pool = await rt.db.connect()
        async with pool.acquire() as conn:
            documents = await conn.fetch(
                "SELECT id, external_id, title FROM rag.document WHERE pages > 0"
                + (" AND external_id = $1" if args.document else "")
                + " ORDER BY fetched_at",
                *([args.document] if args.document else []),
            )
        for document in documents:
            report = await rechunk_document(rt.db, rt.gateway, document)
            print(report.line())
    return 0


async def cmd_embed(args) -> int:
    async with open_runtime() as rt:
        _dump(await embed_pending(rt.db, rt.gateway, limit=args.limit))
    return 0


async def cmd_seed(args) -> int:
    """Load the packed corpus, or pack the current one."""
    db = Database()
    if args.action == "dump":
        _dump(await seed_dump(db))
    else:
        before = await db.counts()
        result = await seed_load(db, replace=args.replace)
        _dump(result)
        if result.get("loaded"):
            _dump({"before": before, "after": await db.counts()})
    await db.close()
    return 0


async def cmd_search(args) -> int:
    async with open_runtime() as rt:
        hits = await search(
            rt.db, rt.gateway, args.question, published_before=_instant(args.before), limit=args.limit
        )
        for position, hit in enumerate(hits, start=1):
            marks = f"v{hit.vector_rank or '-'} t{hit.text_rank or '-'}"
            where = hit.locator.get("section") or hit.section_path or f"p.{hit.locator.get('page')}"
            document = f"{hit.external_id or hit.source} {hit.revision or ''}".strip()
            print(f"\n{position}. [{marks} rrf={hit.score:.4f}] {document} | {where}")
            print("   " + hit.text[:280].replace("\n", " "))
        if not hits:
            print("no hits")
    return 0


async def cmd_evidence(args) -> int:
    async with open_runtime() as rt:
        document = await build_evidence(
            rt.db,
            rt.gateway,
            subsystem=args.subsystem,
            target_date=args.date,
            gate_at=_instant(args.gate_at),
            reason=args.reason,
            description=args.description,
            question=args.question,
        )
    if args.json:
        _dump(document)
    else:
        _print_evidence(document)
    return 0


def _print_evidence(document: dict) -> None:
    generation = document["trace"]["generation"]
    reason = f" ({document['reason']})" if document["reason"] else ""
    print(f"\nQuestion: {document['question']}")
    print(f"Verdict: {document['verdict']}{reason}")
    print(f"Model: {generation['provider']}:{generation['model']} attempts={generation['attempts']}")
    for item in document["items"]:
        print(
            f"\n  [{item['supports']} {item['confidence']} weight={item['evidence_weight']}] {item['claim']}"
        )
        for citation in item["citations"]:
            _print_citation(citation)
    _print_rejected(generation.get("rejected") or [])
    _print_candidates(document["trace"]["retrieval"].get("candidates") or [])


def _print_citation(citation: dict) -> None:
    locator = citation["locator"]
    where = locator.get("section") or (f"page {locator['page']}" if locator.get("page") else "")
    published = citation["published_at"] or "undated"
    print(
        f"    source: {citation['title']} {citation.get('revision') or ''} | {where} | published {published}"
    )
    print(f'    quote: "{citation["quote"][:200]}"')


def _print_rejected(rejected: list[dict]) -> None:
    if not rejected:
        return
    print(f"\n  rejected ({len(rejected)}):")
    for item in rejected:
        codes = ", ".join(failure["code"] for failure in item["failures"])
        print(f"    - {item['claim'][:110]}  [{codes}]")


def _print_candidates(candidates: list[dict]) -> None:
    if not candidates:
        return
    print(f"\n  candidates ({len(candidates)}):")
    for candidate in candidates[:8]:
        ranks = f"v{candidate['vector_rank'] or '-'} t{candidate['text_rank'] or '-'}"
        section = candidate["locator"].get("section") or ""
        print(f"    {candidate['rrf']:.4f} {ranks} {candidate['document']} {section}")


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
    crawl.add_argument(
        "--sample",
        action="store_true",
        help="ipdo-archive: fetch only the oldest, the newest and one in the middle",
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
