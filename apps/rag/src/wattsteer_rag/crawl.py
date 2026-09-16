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

import hashlib
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
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

    async def _get(self, client: httpx.AsyncClient, url: str) -> Fetched | None:
        wait = self.conf.fetch_interval_s - (time.monotonic() - self._last_fetch)
        if wait > 0:
            import asyncio

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
        path = self.store / f"{digest}.pdf"
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
                " sha256, bytes, mime, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf',$9::jsonb)"
                " RETURNING id",
                source,
                external_id,
                revision,
                title,
                fetched.url,
                published_at,
                fetched.sha256,
                fetched.bytes,
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
