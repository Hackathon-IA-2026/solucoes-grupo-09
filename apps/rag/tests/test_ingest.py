"""A long report read in more than one sitting."""

from __future__ import annotations

from pathlib import Path


class _NoQuota:
    async def run(self, task: str, **kwargs):
        from wattsteer_rag.gateway.router import QuotaExhausted

        raise QuotaExhausted(task, 0.0)


async def test_a_page_the_vision_quota_could_not_read_is_owed_not_dropped(monkeypatch):
    """Review of #20: without a page cap one run sends hundreds of pages to the
    vision model; a page with no text layer that ran out of quota was dropped
    and the document marked done, so no later run came back to it."""
    from wattsteer_rag import parse

    texts = {1: "Texto corrido de uma página de relatório. " * 20, 2: ""}
    monkeypatch.setattr(parse, "page_count", lambda pdf: 2)
    monkeypatch.setattr(parse, "pdf_text", lambda pdf, first, last: texts[first])
    monkeypatch.setattr(parse, "rasterize", lambda pdf, page: b"jpeg")

    unread: list[int] = []
    pages = await parse.parse_pdf(_NoQuota(), Path("report.pdf"), unread=unread)
    assert [page.page_no for page in pages] == [1]
    assert unread == [2]
