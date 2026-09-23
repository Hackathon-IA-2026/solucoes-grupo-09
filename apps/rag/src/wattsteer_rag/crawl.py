"""Fetching the documents that decide a curtailment.

The corpus is chosen by the data, not by taste. A curtailment record from the
ONS names the control it applied, and often the operating instruction that
defines it:

    CNF  Controle de inequação: LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO
    REL  Desligamento das LT 525 kV Povo Novo / Marmeleiro C2. SGI N° 46.066-26

So the first documents to hold are the operating instructions (IO), which are
public PDFs under the ONS normative manual, and the network procedures. Ten days
sampled across four subsystems produced 857 records and only 17 distinct
descriptions, which is why a small, exact corpus beats a large, vague one.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote, unquote

import httpx

from .config import settings
from .db import Database
from .parse import pdf_text

log = logging.getLogger("wattsteer_rag.crawl")

MPO_BASE = "https://www.ons.org.br/MPO/Documento Normativo"
IO_DIR = f"{MPO_BASE}/3. Instruções de Operação - SM 5.12/3.1. Controle da Transmissão/3.1.1. Operação Normal"
PROC_PROXY = (
    "https://proxyportais.ons.org.br/ons.portalempregado.proxy/garapi/api/processo/retornarpdf"
    "?url=/sites/soumaisons/portalgar/ecmpdf/"
)
ACERVO = "https://www.ons.org.br/AcervoDigitalDocumentosEPublicacoes"
BDO_BASE = "https://sdro.ons.org.br/SDRO/DIARIO"
# The archive also keeps what it found when the file was already gone: a 404 page
# of nine hundred bytes, recorded under the same URL. Filtering on the captured
# status and type is the difference between 218 entries, 45 of which can never be
# fetched, and 173 that are actually the document.
WAYBACK_CDX = (
    "https://web.archive.org/cdx/search/cdx?url=ons.org.br%2FAcervoDigitalDocumentosEPublicacoes%2F*"
    "&output=json&fl=timestamp,original&filter=original:.*IPDO.*"
    "&filter=statuscode:200&filter=mimetype:application/pdf"
    "&collapse=original&limit=3000"
)
WAYBACK_SAVE = "https://web.archive.org/save"
IPDO_LOOKBACK_DAYS = 4
BDO_CATCH_UP_DAYS = 7
RAP_2023_08_15 = f"{ACERVO}/RAP%202023.08.15%2008h030min%20vers%C3%A3o%20final.pdf"

# The instructions the curtailment records actually cite, with the revision that
# was current when this list was written. `revision=None` asks the crawler to
# discover the current one.
INSTRUCTIONS = [
    (
        "IO-ON.NE.5NE",
        "3.1.1.3. Nordeste",
        "Rev.61",
        "Operação Normal da Área 500 kV da Região Nordeste",
    ),
    (
        "IO-ON.NE.2SO",
        "3.1.1.3. Nordeste",
        "Rev.146",
        "Operação Normal da Área 230 kV Sudoeste da Região Nordeste",
    ),
    (
        "IO-ON.NE.2NO",
        "3.1.1.3. Nordeste",
        "Rev.169",
        "Operação Normal da Área 230 kV Norte da Região Nordeste",
    ),
    (
        "IO-ON.NE.2SL",
        "3.1.1.3. Nordeste",
        "Rev.49",
        "Operação Normal da Área 230 kV Sul da Região Nordeste",
    ),
    (
        "IO-ON.NE.2OE",
        "3.1.1.3. Nordeste",
        "Rev.117",
        "Operação Normal da Área 230 kV Oeste da Região Nordeste",
    ),
    (
        "IO-ON.NE.2LE",
        "3.1.1.3. Nordeste",
        "Rev.42",
        "Operação Normal da Área 230 kV Leste da Região Nordeste",
    ),
]

# Network procedures, for the rules a claim has to be able to cite. The filenames
# are the ones the ONS listing of documents in force serves today; the listing is
# rendered by JavaScript, so it cannot be crawled from here, and a revision that
# moves has to move here too.
#
# `Controle da geração` is in this list because of the numbers, not the topic:
# "Controle de frequência do SIN" is the single most frequent description in the
# constrained-off record — 71,534 of the 227,664 rows of August 2026 — and it
# names no document. Section 1.1 of Submódulo 5.3 is where keeping the frequency
# is assigned to the operation centres, which is the rule behind those records.
PROCEDURES = [
    ("Submódulo 4.2", "Submódulo 4.2-RS_2024.07.pdf", "Programação de intervenções"),
    ("Submódulo 6.7", "Submódulo 6.7-RS_2026.04_Retificado.pdf", "Apuração de indisponibilidade"),
    ("Submódulo 6.9", "Submódulo 6.9-RS_2025.02.pdf", "Acompanhamento de manutenção"),
    ("Submódulo 4.5", "Submódulo 4.5-PR_2025.02.pdf", "Programação diária da operação"),
    ("Submódulo 5.3", "Submódulo 5.3-OP_2020.12.pdf", "Controle da geração"),
    ("Submódulo 5.2", "Submódulo 5.2-OP_2020.12.pdf", "Execução de intervenções"),
    ("Submódulo 6.3", "Submódulo 6.3-RS_2021.06.pdf", "Elaboração do Relatório de Análise de Perturbação"),
]


@dataclass
class Fetched:
    path: Path
    sha256: str
    url: str
    bytes: int


class Crawler:
    def __init__(self, db: Database):
        self.db = db
        self.conf = settings()
        self.store = self.conf.store_dir
        self.store.mkdir(parents=True, exist_ok=True)
        self._last_fetch = 0.0

    async def _get(
        self,
        client: httpx.AsyncClient,
        url: str,
        suffix: str = ".pdf",
        *,
        attempts: int = 1,
        minimum_bytes: int = 0,
    ) -> Fetched | None:
        """Fetch a document, with as much patience as the caller asks for.

        The Internet Archive throttles and goes down for maintenance, and the ONS
        portal times out under load. Both recover, so a transient failure should
        cost a wait, not a missing document. A 404 is not transient and is not
        retried: the file is simply not there.
        """
        last = max(1, attempts)
        for attempt in range(1, last + 1):
            response = await self._request(client, url)
            if _is_document(response, minimum_bytes):
                return self._keep(response, url, suffix)
            if _is_gone(response) or attempt == last:
                return None
            # 1s, 4s, 9s, 16s: long enough for a throttle to clear, short enough
            # that a full backfill still finishes in one sitting.
            await asyncio.sleep(max(_retry_after(response), attempt * attempt))
        return None

    async def _request(self, client: httpx.AsyncClient, url: str) -> httpx.Response | None:
        """One polite request: never faster than the configured interval."""
        wait = self.conf.fetch_interval_s - (time.monotonic() - self._last_fetch)
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_fetch = time.monotonic()
        try:
            return await client.get(
                url, headers={"user-agent": self.conf.user_agent}, timeout=90.0, follow_redirects=True
            )
        except httpx.RequestError:
            return None

    def _keep(self, response: httpx.Response, url: str, suffix: str) -> Fetched:
        digest = hashlib.sha256(response.content).hexdigest()
        path = self.store / f"{digest}{suffix}"
        if not path.exists():
            path.write_bytes(response.content)
        return Fetched(path=path, sha256=digest, url=url, bytes=len(response.content))

    async def register(
        self,
        fetched: Fetched,
        *,
        source: str,
        external_id: str,
        title: str,
        revision: str | None,
        published_at: datetime | None,
        meta: dict | None = None,
        mime: str = "application/pdf",
    ) -> tuple[str, bool]:
        """Insert the document if this exact revision is new. Returns (id, is_new)."""
        pool = await self.db.connect()
        async with pool.acquire() as conn:
            existing = await conn.fetchval(
                "SELECT id FROM rag.document WHERE source = $1 AND sha256 = $2",
                source,
                fetched.sha256,
            )
            if existing:
                return str(existing), False
            row = await conn.fetchrow(
                "INSERT INTO rag.document (source, external_id, revision, title, url, published_at,"
                " sha256, bytes, mime, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)"
                " RETURNING id",
                source,
                external_id,
                revision,
                title,
                fetched.url,
                published_at,
                fetched.sha256,
                fetched.bytes,
                mime,
                meta or {},
            )
            # A document that gets a corrected text keeps its identity: the ONS
            # published `Submódulo 6.7-RS_2026.04_Retificado.pdf` next to the
            # file it corrects, and both are listed as in force. Leaving the
            # older copy searchable means an answer can quote the text that was
            # withdrawn, so the earlier copy stops being retrievable here and
            # stays in the table, because evidence already published points at
            # it.
            await conn.execute(
                "UPDATE rag.document SET status = 'superseded'"
                " WHERE source = $1 AND external_id = $2 AND id <> $3 AND status <> 'superseded'",
                source,
                external_id,
                row["id"],
            )
        return str(row["id"]), True

    async def fetch_instructions(
        self, client: httpx.AsyncClient, codes: list[str] | None = None
    ) -> list[dict]:
        """Operating instructions: the documents the curtailment records cite by code."""
        out = []
        for code, area, revision, title in INSTRUCTIONS:
            if codes and code not in codes:
                continue
            url = f"{IO_DIR}/{area}/{code}_{revision}.pdf"
            fetched = await self._get(client, quote(url, safe=":/?=&"), attempts=3)
            if fetched is None:
                out.append({"external_id": code, "ok": False, "error": "fetch failed"})
                continue
            published = _published_date(fetched.path) or None
            document_id, is_new = await self.register(
                fetched,
                source="INSTRUCAO_OPERACAO",
                external_id=code,
                title=f"{code} - {title}",
                revision=revision,
                published_at=published,
                meta={"area": area},
            )
            out.append(
                {
                    "external_id": code,
                    "ok": True,
                    "document_id": document_id,
                    "new": is_new,
                    "sha256": fetched.sha256[:12],
                    "published_at": published.date().isoformat() if published else None,
                }
            )
        return out

    async def fetch_procedures(self, client: httpx.AsyncClient) -> list[dict]:
        out = []
        for external_id, filename, title in PROCEDURES:
            fetched = await self._get(client, PROC_PROXY + quote(filename), attempts=3)
            if fetched is None:
                out.append({"external_id": external_id, "ok": False, "error": "fetch failed"})
                continue
            document_id, is_new = await self.register(
                fetched,
                source="PROCEDIMENTOS_REDE",
                external_id=external_id,
                title=f"{external_id} - {title}",
                revision=_revision_from(filename),
                published_at=_published_from_filename(filename),
            )
            out.append({"external_id": external_id, "ok": True, "document_id": document_id, "new": is_new})
        return out

    # The daily record --------------------------------------------------

    async def fetch_bdo(self, client: httpx.AsyncClient, day: date) -> list[dict]:
        """The Boletim Diario da Operacao, as HTML tables.

        The PDF of a single day is 18 MB of images with no text layer, and the
        same numbers are published as seventeen plain HTML tables in the same
        folder. Taking the HTML costs nothing, needs no vision model, and keeps
        the numbers exact.
        """
        stamp = day.strftime("%Y_%m_%d")
        base = f"{BDO_BASE}/{stamp}"
        index = await self._get(client, f"{base}/index.htm", suffix=".html")
        if index is None:
            return [{"source": "BDO", "day": day.isoformat(), "ok": False, "error": "no folder for that day"}]
        names = sorted(
            set(re.findall(r'href="HTML/([0-9]{2}_[A-Za-z_]+\.html)"', index.path.read_text("latin-1")))
        )
        out = []
        # The folder is published from about 15:00 in Brasilia. Recording midnight
        # would let a same-day gate admit a document that did not exist yet.
        published = datetime(day.year, day.month, day.day, 18, 0, tzinfo=UTC)
        for name in names:
            fetched = await self._get(client, f"{base}/HTML/{name}", suffix=".html")
            if fetched is None:
                out.append({"external_id": name, "ok": False})
                continue
            document_id, is_new = await self.register(
                fetched,
                source="BDO",
                external_id=f"BDO {day.isoformat()} {name[:2]}",
                title=f"Boletim Diário da Operação {day.strftime('%d/%m/%Y')} - {_bdo_title(name)}",
                revision=None,
                published_at=published,
                mime="text/html",
                meta={"table": name, "day": day.isoformat()},
            )
            out.append({"external_id": name, "ok": True, "document_id": document_id, "new": is_new})
        return out

    async def fetch_ipdo(self, client: httpx.AsyncClient, day: date) -> dict:
        """The preliminary daily report, which the ONS does not keep.

        Only the current edition is served. Anything older has to come from the
        archive, which is why this runs every day.
        """
        url = f"{ACERVO}/IPDO-{day.strftime('%d-%m-%Y')}.pdf"
        fetched = await self._get(client, url, attempts=2, minimum_bytes=50_000)
        if fetched is None:
            return {
                "source": "IPDO",
                "day": day.isoformat(),
                "ok": False,
                "error": "not published (or already replaced)",
            }
        document_id, is_new = await self.register(
            fetched,
            source="IPDO",
            external_id=f"IPDO {day.isoformat()}",
            title=f"IPDO - Informativo Preliminar Diário da Operação {day.strftime('%d/%m/%Y')}",
            revision=None,
            published_at=datetime(day.year, day.month, day.day, tzinfo=UTC),
            meta={"day": day.isoformat()},
        )
        if is_new:
            await self._keep_a_public_copy(client, url)
        return {
            "source": "IPDO",
            "day": day.isoformat(),
            "ok": True,
            "document_id": document_id,
            "new": is_new,
        }

    async def fetch_missing_bdo(self, client: httpx.AsyncClient, today: date, days: int = 1) -> list[dict]:
        """The last `days` bulletins, and any of the week before that is missing.

        The refresh fetched yesterday's bulletin and nothing else, so a day it
        did not run (a deploy, a restore of a corpus packed on another machine,
        a Railway restart) was a hole nobody came back for. The ONS keeps every
        BDO, so a missing day can always be fetched: it only has to be noticed.
        """
        held = await self.bdo_days()
        out: list[dict] = []
        for back in range(1, max(days, BDO_CATCH_UP_DAYS) + 1):
            day = today - timedelta(days=back)
            if back > days and day.isoformat() in held:
                continue
            out += await self.fetch_bdo(client, day)
        return out

    async def bdo_days(self) -> set[str]:
        pool = await self.db.connect()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT split_part(external_id, ' ', 2) AS day"
                " FROM rag.document WHERE source = 'BDO'"
            )
        return {row["day"] for row in rows}

    async def fetch_live_ipdo(self, client: httpx.AsyncClient, today: date, days: int = 1) -> list[dict]:
        """Whichever editions are on the portal now, looking back far enough.

        The file is named for the day it covers, not the day it went up, and the
        portal keeps one: at 02:29 of 23/09/2026 the only edition served was
        IPDO-21-09-2026.pdf, and 22 and 23 answered 404. The daily refresh asked
        for today and yesterday only, at 05:10 in Brasilia, so it never found the
        edition that was up, and the event's Railway held one IPDO in a week.
        Asking for the last few days costs a 404 each; the one that is up is kept,
        and one fetched before is recognised by its hash.
        """
        lookback = max(days, IPDO_LOOKBACK_DAYS)
        return [await self.fetch_ipdo(client, today - timedelta(days=back)) for back in range(lookback)]

    async def _keep_a_public_copy(self, client: httpx.AsyncClient, url: str) -> None:
        """Ask the Internet Archive to keep the edition too.

        An IPDO the portal has replaced exists nowhere else: on 23/09/2026 the
        archive held no 2026 edition at all, so three days of them were lost.
        This is a second copy outside our own volume, and it is best effort: the
        archive throttles, and a failure here must not cost the edition we have.
        """
        if not self.conf.archive_ipdo:
            return
        try:
            response = await client.get(
                f"{WAYBACK_SAVE}/{url}",
                headers={"user-agent": self.conf.user_agent},
                timeout=60,
                follow_redirects=True,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("wayback save failed for %s (%s); the local copy stands", url, exc)

    async def known_days(self, source: str) -> set[str]:
        """Which editions are already here, so a rerun only fetches what is missing."""
        pool = await self.db.connect()
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT external_id FROM rag.document WHERE source = $1", source)
        return {row["external_id"].split()[-1] for row in rows if row["external_id"]}

    async def fetch_ipdo_archive(
        self, client: httpx.AsyncClient, limit: int = 40, *, attempts: int = 4, sample: bool = False
    ) -> list[dict]:
        """Backfill old editions from the Internet Archive.

        The ONS overwrites the IPDO every day, so the only history that exists is
        the one somebody else kept: 218 editions between 2017 and 2025 at the time
        of writing. Sparse, but real, and it costs nobody anything.
        """
        # The index itself is the flakiest request of the lot, so it gets the
        # most patience: without it there is nothing to backfill.
        index = await self._get(client, WAYBACK_CDX, suffix=".json", attempts=max(attempts, 5))
        if index is None:
            return [{"source": "IPDO", "ok": False, "error": "archive index unavailable, try again later"}]
        try:
            editions = _archived_editions(json.loads(index.path.read_text())[1:])
        except json.JSONDecodeError:
            return [{"source": "IPDO", "ok": False, "error": "archive returned no index"}]
        already = await self.known_days("IPDO")
        pending = [(day, url) for day, url in sorted(editions.items(), reverse=True) if day not in already]
        total_pending = len(pending)
        if sample and len(pending) >= 3:
            # Backfilling 218 editions takes a long time and the archive throttles.
            # The oldest, the newest and one in the middle answer the only question
            # that matters before committing to the whole run: does this path work
            # across the range, or only for what was archived recently?
            pending = [pending[0], pending[len(pending) // 2], pending[-1]]
        out: list[dict] = [
            {
                "source": "IPDO",
                "archive_index": len(editions),
                "mode": "sample" if sample else "sequential",
                "fetching_now": min(limit, len(pending)),
                "already_here": len(already),
                "pending": total_pending,
            }
        ]
        for day, url in pending[:limit]:
            out.append(await self._fetch_archived_ipdo(client, day, url, attempts))
        remaining = total_pending - min(limit, len(pending))
        if remaining > 0:
            out.append({"note": f"{remaining} editions still missing; run again to continue"})
        return out

    async def _fetch_archived_ipdo(
        self, client: httpx.AsyncClient, day: str, url: str, attempts: int
    ) -> dict:
        # A throttled reply from the archive is a small HTML page, not a PDF,
        # so size is part of what counts as success.
        fetched = await self._get(client, url, attempts=attempts, minimum_bytes=50_000)
        if fetched is None:
            return {"day": day, "ok": False, "error": "archive did not serve the file"}
        parsed = date.fromisoformat(day)
        document_id, is_new = await self.register(
            fetched,
            source="IPDO",
            external_id=f"IPDO {day}",
            title=f"IPDO - Informativo Preliminar Diário da Operação {parsed.strftime('%d/%m/%Y')}",
            revision=None,
            published_at=datetime(parsed.year, parsed.month, parsed.day, tzinfo=UTC),
            meta={"day": day, "via": "web.archive.org"},
        )
        return {"day": day, "ok": True, "document_id": document_id, "new": is_new}

    async def fetch_rap(self, client: httpx.AsyncClient, urls: list[str]) -> list[dict]:
        """Disturbance reports. Public, but with no listing worth crawling.

        The acervo category returns nothing, so the reports are found by their
        published URL. They carry a text layer, so parsing one costs no quota:
        the report of 15/08/2023 is 572 pages and poppler reads all of them.
        """
        out = []
        for url in urls or [RAP_2023_08_15]:
            fetched = await self._get(client, url, attempts=3)
            if fetched is None:
                out.append({"url": url[:80], "ok": False})
                continue
            match = re.search(r"RAP[ _](\d{4})\.(\d{2})\.(\d{2})", unquote(url))
            published = (
                datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=UTC)
                if match
                else None
            )
            label = f"RAP {published.date().isoformat()}" if published else f"RAP {fetched.sha256[:8]}"
            when = published.strftime("%d/%m/%Y") if published else "?"
            document_id, is_new = await self.register(
                fetched,
                source="RAP",
                external_id=label,
                title=f"Relatório de Análise de Perturbação - {when}",
                revision=None,
                published_at=published,
                meta={"source_url": url},
            )
            out.append({"external_id": label, "ok": True, "document_id": document_id, "new": is_new})
        return out


GONE = {400, 401, 403, 404, 410}  # the server does not have it, and never will


def _is_document(response: httpx.Response | None, minimum_bytes: int) -> bool:
    return (
        response is not None
        and response.status_code == 200
        and len(response.content) >= max(1, minimum_bytes)
    )


def _is_gone(response: httpx.Response | None) -> bool:
    return response is not None and response.status_code in GONE


def _retry_after(response: httpx.Response | None) -> float:
    header = response.headers.get("retry-after", "") if response is not None else ""
    return float(header) if header.isdigit() else 0.0


def _archived_editions(rows: list) -> dict[str, str]:
    """One archive URL per edition day, the earliest capture of each."""
    editions: dict[str, str] = {}
    for stamp, original in rows:
        match = re.search(r"IPDO-(\d{2})-(\d{2})-(\d{4})", original, re.I)
        if match:
            day = f"{match.group(3)}-{match.group(2)}-{match.group(1)}"
            editions.setdefault(day, f"https://web.archive.org/web/{stamp}id_/{original}")
    return editions


def _bdo_title(name: str) -> str:
    stem = re.sub(r"^\d+_", "", name).replace(".html", "")
    return re.sub(r"(?<!^)(?=[A-Z])", " ", stem).strip()


DATE_IN_PDF = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})\b")


def _published_date(pdf: Path) -> datetime | None:
    """Operating instructions carry their validity date in the header of page 1."""
    text = pdf_text(pdf, 1, 2)
    dates = [
        datetime(int(year), int(month), int(day), tzinfo=UTC)
        for day, month, year in DATE_IN_PDF.findall(text)
        if 2000 < int(year) < 2100 and 1 <= int(month) <= 12 and 1 <= int(day) <= 31
    ]
    return max(dates) if dates else None


def _revision_from(filename: str) -> str | None:
    match = re.search(r"_(\d{4})\.(\d{2})", filename)
    return f"{match.group(1)}.{match.group(2)}" if match else None


def _published_from_filename(filename: str) -> datetime | None:
    match = re.search(r"_(\d{4})\.(\d{2})", filename)
    if not match:
        return None
    return datetime(int(match.group(1)), int(match.group(2)), 1, tzinfo=UTC)
