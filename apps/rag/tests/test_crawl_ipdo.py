"""The portal keeps one IPDO, so the refresh has to find it before it is gone."""

from __future__ import annotations

import asyncio
import inspect
from datetime import date

import httpx

from wattsteer_rag import app
from wattsteer_rag.crawl import Crawler, Fetched
from wattsteer_rag.db import Database


def test_the_refresh_asks_for_the_edition_that_is_up():
    """Measured at 02:29 of 23/09/2026: the only edition served was
    IPDO-21-09-2026.pdf. The refresh asked for today and yesterday, found
    nothing, and the event's Railway held one IPDO in a week."""
    crawler = Crawler(Database())
    asked: list[date] = []

    async def fetch_ipdo(_client, day):
        asked.append(day)
        return {"ok": False}

    crawler.fetch_ipdo = fetch_ipdo  # type: ignore[method-assign]
    asyncio.run(crawler.fetch_live_ipdo(None, date(2026, 9, 23)))  # type: ignore[arg-type]
    assert date(2026, 9, 21) in asked
    assert "fetch_live_ipdo" in inspect.getsource(app._refresh)


def test_a_new_edition_gets_a_public_copy_and_a_failed_copy_costs_nothing(tmp_path):
    """The archive held no 2026 edition on 23/09/2026. A new IPDO is sent to
    it once; an edition already held is not, and an archive that fails does not
    lose the edition we fetched."""
    crawler = Crawler(Database())
    pdf = tmp_path / "ipdo.pdf"
    pdf.write_bytes(b"%PDF-1.4 " + b"x" * 60_000)
    saved: list[str] = []
    new = {"value": True}

    async def get(*_args, **_kwargs):
        return Fetched(path=pdf, sha256="h", url="u", bytes=pdf.stat().st_size)

    async def register(_fetched, **_kwargs):
        return "doc-1", new["value"]

    def handler(request: httpx.Request) -> httpx.Response:
        saved.append(str(request.url))
        return httpx.Response(502)

    crawler._get = get  # type: ignore[method-assign]
    crawler.register = register  # type: ignore[method-assign]

    async def fetch() -> dict:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await crawler.fetch_ipdo(client, date(2026, 9, 21))

    assert asyncio.run(fetch())["ok"] is True
    assert saved and saved[0].startswith("https://web.archive.org/save/")
    new["value"] = False
    asyncio.run(fetch())
    assert len(saved) == 1
