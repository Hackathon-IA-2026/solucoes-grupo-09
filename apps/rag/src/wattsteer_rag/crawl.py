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
import re
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.parse import quote

import httpx

from .config import settings
from .db import Database

MPO_BASE = "https://www.ons.org.br/MPO/Documento Normativo"
IO_DIR = f"{MPO_BASE}/3. Instruções de Operação - SM 5.12/3.1. Controle da Transmissão/3.1.1. Operação Normal"
PROC_PROXY = (
    "https://proxyportais.ons.org.br/ons.portalempregado.proxy/garapi/api/processo/retornarpdf"
    "?url=/sites/soumaisons/portalgar/ecmpdf/"
)
ACERVO = "https://www.ons.org.br/AcervoDigitalDocumentosEPublicacoes"
BDO_BASE = "https://sdro.ons.org.br/SDRO/DIARIO"
WAYBACK_CDX = (
    "https://web.archive.org/cdx/search/cdx?url=ons.org.br%2FAcervoDigitalDocumentosEPublicacoes%2F*"
    "&output=json&fl=timestamp,original&filter=original:.*IPDO.*&collapse=original&limit=3000"
)
RAP_2023_08_15 = (
    f"{ACERVO}/RAP%202023.08.15%2008h030min%20vers%C3%A3o%20final.pdf"
)

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

# Network procedures, for the rules a claim has to be able to cite.
PROCEDURES = [
    ("Submódulo 4.2", "Submódulo 4.2-RS_2024.07.pdf", "Programação de intervenções"),
    ("Submódulo 6.7", "Submódulo 6.7-RS_2026.04.pdf", "Apuração de indisponibilidade"),
    ("Submódulo 6.9", "Submódulo 6.9-RS_2025.02.pdf", "Acompanhamento de manutenção"),
    ("Submódulo 4.5", "Submódulo 4.5-PR_2025.02.pdf", "Programação diária da operação"),
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

    async def _get(self, client: httpx.AsyncClient, url: str, suffix: str = ".pdf") -> Fetched | None:
        wait = self.conf.fetch_interval_s - (time.monotonic() - self._last_fetch)
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_fetch = time.monotonic()
        try:
            response = await client.get(
                url,
                headers={"user-agent": self.conf.user_agent},
                timeout=90.0,
                follow_redirects=True,
            )
        except httpx.RequestError:
            return None
        if response.status_code != 200 or not response.content:
            return None
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
            fetched = await self._get(client, quote(url, safe=":/?=&"))
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
            fetched = await self._get(client, PROC_PROXY + quote(filename))
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
            out.append(
                {"external_id": external_id, "ok": True, "document_id": document_id, "new": is_new}
            )
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
        names = sorted(set(re.findall(r'href="HTML/([0-9]{2}_[A-Za-z_]+\.html)"', index.path.read_text("latin-1"))))
        out = []
        published = datetime(day.year, day.month, day.day, tzinfo=UTC)
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
        fetched = await self._get(client, url)
        if fetched is None:
            return {"source": "IPDO", "day": day.isoformat(), "ok": False, "error": "not published (or already replaced)"}
        document_id, is_new = await self.register(
            fetched,
            source="IPDO",
            external_id=f"IPDO {day.isoformat()}",
            title=f"IPDO - Informativo Preliminar Diário da Operação {day.strftime('%d/%m/%Y')}",
            revision=None,
            published_at=datetime(day.year, day.month, day.day, tzinfo=UTC),
            meta={"day": day.isoformat()},
        )
        return {"source": "IPDO", "day": day.isoformat(), "ok": True, "document_id": document_id, "new": is_new}

    async def fetch_ipdo_archive(self, client: httpx.AsyncClient, limit: int = 40) -> list[dict]:
        """Backfill old editions from the Internet Archive.

        The ONS overwrites the IPDO every day, so the only history that exists is
        the one somebody else kept: 218 editions between 2017 and 2025 at the time
        of writing. Sparse, but real, and it costs nobody anything.
        """
        index = await self._get(client, WAYBACK_CDX, suffix=".json")
        if index is None:
            return [{"source": "IPDO", "ok": False, "error": "archive index unavailable"}]
        try:
            rows = json.loads(index.path.read_text())[1:]
        except json.JSONDecodeError:
            return [{"source": "IPDO", "ok": False, "error": "archive returned no index"}]
        seen: dict[str, str] = {}
        for stamp, original in rows:
            match = re.search(r"IPDO-(\d{2})-(\d{2})-(\d{4})", original, re.I)
            if match:
                day = f"{match.group(3)}-{match.group(2)}-{match.group(1)}"
                seen.setdefault(day, f"https://web.archive.org/web/{stamp}id_/{original}")
        out = []
        for day, url in sorted(seen.items(), reverse=True)[:limit]:
            # The archive throttles, and a throttled reply is a small HTML page.
            # One patient retry turns most of those into the document.
            fetched = await self._get(client, url)
            if fetched is None or fetched.bytes < 50_000:
                await asyncio.sleep(6)
                fetched = await self._get(client, url)
            if fetched is None or fetched.bytes < 50_000:
                out.append({"day": day, "ok": False, "error": "archive did not serve the file"})
                continue
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
            out.append({"day": day, "ok": True, "document_id": document_id, "new": is_new})
        return out

    async def fetch_rap(self, client: httpx.AsyncClient, urls: list[str]) -> list[dict]:
        """Disturbance reports. Public, but with no listing worth crawling.

        The acervo category returns nothing, so the reports are found by their
        published URL. They carry a text layer, so parsing one costs no quota:
        the report of 15/08/2023 is 572 pages and poppler reads all of them.
        """
        out = []
        for url in urls or [RAP_2023_08_15]:
            fetched = await self._get(client, url)
            if fetched is None:
                out.append({"url": url[:80], "ok": False})
                continue
            match = re.search(r"RAP[ _](\d{4})\.(\d{2})\.(\d{2})", url)
            published = (
                datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=UTC)
                if match
                else None
            )
            label = f"RAP {published.date().isoformat()}" if published else f"RAP {fetched.sha256[:8]}"
            document_id, is_new = await self.register(
                fetched,
                source="RAP",
                external_id=label,
                title=f"Relatório de Análise de Perturbação - {published.strftime('%d/%m/%Y') if published else 'sem data'}",
                revision=None,
                published_at=published,
                meta={"source_url": url},
            )
            out.append({"external_id": label, "ok": True, "document_id": document_id, "new": is_new})
        return out


def _bdo_title(name: str) -> str:
    stem = re.sub(r"^\d+_", "", name).replace(".html", "")
    return re.sub(r"(?<!^)(?=[A-Z])", " ", stem).strip()


DATE_IN_PDF = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})\b")


def _published_date(pdf: Path) -> datetime | None:
    """Operating instructions carry their validity date in the header of page 1."""
    import subprocess

    text = subprocess.run(
        ["pdftotext", "-layout", "-f", "1", "-l", "2", str(pdf), "-"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    dates = [
        datetime(int(year), int(month), int(day), tzinfo=UTC)
        for day, month, year in DATE_IN_PDF.findall(text or "")
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
