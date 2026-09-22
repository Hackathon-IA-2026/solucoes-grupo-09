"""Turning a PDF into pages we can quote.

Two readers, and the rule that picks between them. Poppler reads the text layer
a file already carries, for free. The vision model reads the page as an image,
and costs quota. The documents that decide a curtailment are often published as
images with no text layer at all: the daily bulletin of 2026-09-14 has 58 pages
and a text layer that contains only the running header.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .bulletin import bulletin_lines
from .columns import label_columns
from .gateway.adapters import Block, ProviderError
from .gateway.router import Gateway, QuotaExhausted

RASTER_DPI = 110  # keeps a base64 page under the 180 kB the API accepts
TEXT_LAYER_MIN_CHARS = 350  # below this a page is a scan with a header on top
COLUMN_GAP = re.compile(r"\S {3,}\S")
# Two labelled fields on one line, "Prazo: 30/03/2024      Gestor: EGE", which is
# how a disturbance report closes each action. The gap between them is layout,
# not a column: see `looks_tabular`.
FIELD_PAIR = re.compile(r"^\s*[A-ZÀ-Ý]\w+:\s+\S.*\S\s{3,}[A-ZÀ-Ý]\w+:\s+\S")
TEXT_LAYER_PARSER = "local:pdftotext"


@dataclass
class ParsedPage:
    page_no: int
    markdown: str
    blocks: list[dict]
    has_tables: bool
    parser: str


# poppler ---------------------------------------------------------------


def page_count(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, check=False).stdout
    match = re.search(r"Pages:\s+(\d+)", out)
    return int(match.group(1)) if match else 0


def pdf_text(pdf: Path, first: int, last: int) -> str:
    """The text layer of a page range, with the layout poppler can recover."""
    return subprocess.run(
        ["pdftotext", "-layout", "-f", str(first), "-l", str(last), str(pdf), "-"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()


def rasterize(pdf: Path, page: int, dpi: int = RASTER_DPI) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        prefix = Path(tmp) / "page"
        subprocess.run(
            ["pdftoppm", "-jpeg", "-r", str(dpi), "-f", str(page), "-l", str(page), str(pdf), str(prefix)],
            capture_output=True,
            check=False,
        )
        images = sorted(Path(tmp).glob("page*.jpg"))
        if not images:
            raise ProviderError("pdftoppm produced no image")
        return images[0].read_bytes()


def looks_tabular(text: str) -> bool:
    """Is this page a table that the text layer has flattened into columns?

    An operating instruction carries a text layer, but its pages are six column
    tables, and `pdftotext` returns them as lines of words separated by runs of
    spaces: the rows and the cells are gone, and with them the ability to quote a
    limit next to the control it belongs to. Those pages are worth the vision
    model. Prose pages, which is most of a disturbance report, are not, and
    neither are its pages of actions: each ends in a line of two labelled
    fields, and read as columns they sent the page to a model that split the
    actions from their deadlines.
    """
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) < 6:
        return False
    columnar = sum(1 for line in lines if COLUMN_GAP.search(line) and not FIELD_PAIR.match(line))
    return columnar / len(lines) > 0.35


# tables ----------------------------------------------------------------


def rows_to_markdown(rows: list[list[str]]) -> str:
    """A pipe table, the one shape every table in the corpus is stored as."""
    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(row) + " |" for row in padded]
    rule = "| " + " | ".join("---" for _ in range(width)) + " |"
    return "\n".join([lines[0], rule, *lines[1:]])


def latex_table_to_markdown(latex: str) -> str:
    """Nemotron Parse returns tables as LaTeX tabular. Keep the data, drop the TeX.

    A table that survives as a pipe table is a table a person can read in the
    citation, and a table whose numbers still match the page.
    """
    body = re.sub(r"\\begin\{tabular\}\{[^}]*\}|\\end\{tabular\}", "", latex)
    rows = [cells for cells in (_latex_row(raw) for raw in body.split(r"\\")) if cells]
    return rows_to_markdown(rows) if rows else latex.strip()


def _latex_row(raw: str) -> list[str]:
    # `\multirow{6}{*}{COSR-NE}` and `\multicolumn{4}{c}{SIN}` carry the cell
    # value the operator needs; the wrapper is layout the model would either
    # copy verbatim or trip over when asked to quote the row.
    line = re.sub(r"\\multicolumn\{\d+\}\{[^}]*\}\{(.*?)\}", r"\1", raw.strip())
    line = re.sub(r"\\multirow\{\d+\}\{[^}]*\}\{(.*?)\}", r"\1", line)
    line = re.sub(r"\\[a-zA-Z]+\*?(?:\{[^}]*\})*", " ", line)
    line = line.replace("**", "").replace("{", "").replace("}", "").strip()
    cells = [cell.strip() for cell in line.split("&")] if line else []
    return cells if any(cells) else []


def parse_html_tables(path: Path, heading: str = "") -> list[ParsedPage]:
    """The daily bulletin, which publishes the same numbers as plain HTML.

    No model is involved and none is needed: the tables are already structured,
    and reading them costs nothing. Decoding is explicit: the files are UTF-8
    with a byte-order mark and say so in their `charset`. They were read as
    latin-1, which stored every accented word garbled ("ProduÃ§Ã£o") and kept
    the table headings from matching a Portuguese question. latin-1 stays as
    the fallback for a file that is not valid UTF-8. `bulletin.py` says why each
    row is its own line.
    """
    data = path.read_bytes()
    try:
        raw = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raw = data.decode("latin-1")
    markdown = "\n\n".join(bulletin_lines(raw, heading)).strip()
    if not markdown:
        return []
    return [ParsedPage(page_no=1, markdown=markdown, blocks=[], has_tables=True, parser="local:html")]


# pages -----------------------------------------------------------------


def blocks_to_markdown(blocks: list[Block]) -> tuple[str, bool]:
    parts: list[str] = []
    has_tables = False
    for block in blocks:
        text = block.text.strip()
        kind = block.type.lower()
        if not text or kind == "page-footer":
            continue  # the running footer is noise in every chunk it lands in
        if "tabular" in text or kind == "table":
            has_tables = True
            parts.append(latex_table_to_markdown(text))
        elif kind in {"page-header", "title", "section-header"}:
            parts.append(f"## {text}")
        else:
            parts.append(text)
    return "\n\n".join(parts).strip(), has_tables


def _text_layer_page(page_no: int, text: str) -> ParsedPage:
    return ParsedPage(
        page_no=page_no, markdown=label_columns(text), blocks=[], has_tables=False, parser=TEXT_LAYER_PARSER
    )


async def _vision_page(gateway: Gateway, pdf: Path, page_no: int) -> ParsedPage | None:
    """The page as the vision model read it, or None when no link could.

    Out of quota is raised, not swallowed: it is the one failure that means
    "read this page later", and the caller has to know the page is owed."""
    try:
        result = await gateway.run("parse", tokens=1, image=rasterize(pdf, page_no))
    except ProviderError:
        return None
    blocks: list[Block] = result.value
    markdown, has_tables = blocks_to_markdown(blocks)
    if not markdown:
        return None
    return ParsedPage(
        page_no=page_no,
        markdown=markdown,
        blocks=[{"type": b.type, "text": b.text, "bbox": b.bbox} for b in blocks],
        has_tables=has_tables,
        parser=f"{result.provider}:{result.model}",
    )


async def parse_pdf(
    gateway: Gateway,
    pdf: Path,
    *,
    max_pages: int | None = None,
    force_vision: bool = False,
    unread: list[int] | None = None,
) -> list[ParsedPage]:
    """Parse every page, and spend the vision model only where it is needed.

    A disturbance report carries a text layer that reads like prose, and reading
    it costs nothing. An operating instruction also carries one, but its pages
    are tables, and the text layer returns them as columns of words with the rows
    dissolved. Those pages go to the vision model, which returns the table as a
    table. So the rule is not "text layer first": it is "text layer when the text
    layer is good enough". When the vision model cannot read a page, the text
    layer is taken anyway, and the page says so, rather than being dropped.
    A page with no text layer that ran out of vision quota goes in `unread`:
    the document is not done, and ingestion must come back to it.
    """
    total = min(page_count(pdf), max_pages) if max_pages else page_count(pdf)
    pages: list[ParsedPage] = []
    for page_no in range(1, total + 1):
        page = await _read_page(gateway, pdf, page_no, force_vision, unread)
        if page is not None:
            pages.append(page)
    return pages


async def _read_page(
    gateway: Gateway, pdf: Path, page_no: int, force_vision: bool, unread: list[int] | None
) -> ParsedPage | None:
    text = "" if force_vision else pdf_text(pdf, page_no, page_no)
    if len(text) >= TEXT_LAYER_MIN_CHARS and not looks_tabular(text):
        return _text_layer_page(page_no, text)
    try:
        page = await _vision_page(gateway, pdf, page_no)
    except QuotaExhausted:
        page = None
        if not text and unread is not None:
            unread.append(page_no)
    if page is None:
        text = text or pdf_text(pdf, page_no, page_no)
        page = _text_layer_page(page_no, text) if text else None
    return page
