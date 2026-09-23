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


def test_a_new_edition_gets_a_public_copy_and_a_failed_copy_costs_nothing(tmp_path, caplog):
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
        assert request.headers["user-agent"].startswith("WattSteer-RAG")
        return httpx.Response(502)

    crawler._get = get  # type: ignore[method-assign]
    crawler.register = register  # type: ignore[method-assign]

    async def fetch() -> dict:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await crawler.fetch_ipdo(client, date(2026, 9, 21))

    assert asyncio.run(fetch())["ok"] is True
    assert saved and saved[0].startswith("https://web.archive.org/save/")
    # Review of #43: a 502 from the archive used to pass as a copy kept.
    assert "wayback save failed" in caplog.text
    new["value"] = False
    asyncio.run(fetch())
    assert len(saved) == 1


def test_the_refresh_fills_a_missing_bulletin_of_the_week():
    """The refresh fetched yesterday's BDO only, so a day it did not run was a
    hole for good, though the ONS keeps every bulletin. A corpus packed on one
    machine and restored on Railway leaves exactly such a gap."""
    crawler = Crawler(Database())
    asked: list[date] = []

    async def bdo_days():
        # 17/09 holds 20 of its 25 tables: review of #45 pointed out that a
        # partly fetched day must not count as held.
        return {"2026-09-20": 25, "2026-09-19": 25, "2026-09-17": 20, "2026-09-16": 25}

    async def bdo_tables(_client, _day):
        return [f"{n:02d}_T.html" for n in range(25)]

    async def fetch_bdo(_client, day, names=None):
        asked.append(day)
        return []

    crawler.bdo_days = bdo_days  # type: ignore[method-assign]
    crawler.bdo_tables = bdo_tables  # type: ignore[method-assign]
    crawler.fetch_bdo = fetch_bdo  # type: ignore[method-assign]
    asyncio.run(crawler.fetch_missing_bdo(None, date(2026, 9, 23), days=2))  # type: ignore[arg-type]
    assert asked == [date(2026, 9, 22), date(2026, 9, 21), date(2026, 9, 18), date(2026, 9, 17)]
    assert "fetch_missing_bdo" in inspect.getsource(app._refresh)


def test_the_schematic_diagram_is_not_a_bulletin_table(tmp_path):
    """Measured on 23/09/2026: every day from 15/09 held 25 of the index's 26
    entries. The 26th was the schematic diagram, identical every day, filed under
    14/09's copy by its hash, and indexed to zero chunks."""
    crawler = Crawler(Database())
    page = tmp_path / "index.htm"
    page.write_text('<a href="HTML/01_Balanco.html"></a><a href="HTML/22_DiagramaEsquematico_SVG.html"></a>')

    async def get(*_args, **_kwargs):
        return Fetched(path=page, sha256="h", url="u", bytes=10)

    crawler._get = get  # type: ignore[method-assign]
    assert asyncio.run(crawler.bdo_tables(None, date(2026, 9, 21))) == ["01_Balanco.html"]  # type: ignore[arg-type]
