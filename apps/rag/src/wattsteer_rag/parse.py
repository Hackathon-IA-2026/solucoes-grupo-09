"""Turning a PDF into pages we can quote.

Two links, in order: the vision model reads the page as an image, and poppler
reads whatever text layer the file already has. The order matters because the
documents that decide a curtailment, the operating instructions and the
disturbance reports, are often published as images with no text layer at all:
the Boletim Diario da Operacao of 2026-09-14 has 58 pages and a text layer that
contains only the running header.
"""

from __future__ import annotations

import html
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .gateway.adapters import Block, ProviderError
from .gateway.router import Gateway, QuotaExhausted

RASTER_DPI = 110  # keeps a base64 page under the 180 kB the API accepts


@dataclass
class ParsedPage:
    page_no: int
    markdown: str
    blocks: list[dict]
    has_tables: bool
    parser: str


def page_count(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, check=False).stdout
    match = re.search(r"Pages:\s+(\d+)", out)
    return int(match.group(1)) if match else 0


def rasterize(pdf: Path, page: int, dpi: int = RASTER_DPI) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        prefix = Path(tmp) / "page"
        subprocess.run(
            [
                "pdftoppm",
                "-jpeg",
                "-r",
                str(dpi),
                "-f",
                str(page),
                "-l",
                str(page),
                str(pdf),
                str(prefix),
            ],
            capture_output=True,
            check=False,
        )
        images = sorted(Path(tmp).glob("page*.jpg"))
        if not images:
            raise ProviderError("pdftoppm produced no image")
        return images[0].read_bytes()


def latex_table_to_markdown(latex: str) -> str:
    """Nemotron Parse returns tables as LaTeX tabular. Keep the data, drop the TeX.

    A table that survives as a pipe table is a table a person can read in the
    citation, and a table whose numbers still match the page.
    """
    body = re.sub(r"\\begin\{tabular\}\{[^}]*\}|\\end\{tabular\}", "", latex)
    rows: list[list[str]] = []
    for raw in body.split(r"\\"):
        line = raw.strip()
        if not line:
            continue
        # `\multirow{6}{*}{COSR-NE}` and `\multicolumn{4}{c}{SIN}` carry the cell
        # value the operator needs; the wrapper is layout the model would either
        # copy verbatim or trip over when asked to quote the row.
        line = re.sub(r"\\multicolumn\{\d+\}\{[^}]*\}\{(.*?)\}", r"\1", line)
        line = re.sub(r"\\multirow\{\d+\}\{[^}]*\}\{(.*?)\}", r"\1", line)
        line = re.sub(r"\\[a-zA-Z]+\*?(?:\{[^}]*\})*", " ", line)
        line = line.replace("**", "").replace("{", "").replace("}", "").strip()
        if not line:
            continue
        cells = [cell.strip() for cell in line.split("&")]
        if any(cells):
            rows.append(cells)
    if not rows:
        return latex.strip()
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    head = "| " + " | ".join(rows[0]) + " |"
    rule = "| " + " | ".join("---" for _ in range(width)) + " |"
    body_rows = ["| " + " | ".join(row) + " |" for row in rows[1:]]
    return "\n".join([head, rule, *body_rows])


def blocks_to_markdown(blocks: list[Block]) -> tuple[str, bool]:
    parts: list[str] = []
    has_tables = False
    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        if "tabular" in text or block.type.lower() == "table":
            has_tables = True
            parts.append(latex_table_to_markdown(text))
        elif block.type.lower() in {"page-header", "title", "section-header"}:
            parts.append(f"## {text}")
        elif block.type.lower() == "page-footer":
            continue  # the running footer is noise in every chunk it lands in
        else:
            parts.append(text)
    return "\n\n".join(parts).strip(), has_tables


TEXT_LAYER_MIN_CHARS = 350  # below this a page is a scan with a header on top
COLUMN_GAP = re.compile(r"\S {3,}\S")


def looks_tabular(text: str) -> bool:
    """Is this page a table that the text layer has flattened into columns?

    An operating instruction carries a text layer, but its pages are six column
    tables, and `pdftotext` returns them as lines of words separated by runs of
    spaces: the rows and the cells are gone, and with them the ability to quote a
    limit next to the control it belongs to. Those pages are worth the vision
    model. Prose pages, which is most of a disturbance report, are not.
    """
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) < 6:
        return False
    columnar = sum(1 for line in lines if COLUMN_GAP.search(line))
    return columnar / len(lines) > 0.35


def text_layer(pdf: Path, page: int) -> str:
    return subprocess.run(
        ["pdftotext", "-layout", "-f", str(page), "-l", str(page), str(pdf), "-"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()


def parse_html_tables(path: Path) -> list[ParsedPage]:
    """The Boletim Diario, which publishes the same numbers as plain HTML.

    No model is involved and none is needed: the tables are already structured,
    and reading them costs nothing. The files are latin-1, which is why decoding
    is explicit.
    """
    raw = path.read_text("latin-1", errors="ignore")
    parts: list[str] = []
    for table in re.findall(r"<table[^>]*>(.*?)</table>", raw, re.S | re.I):
        rows: list[list[str]] = []
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S | re.I):
            cells = [
                html.unescape(re.sub(r"<[^>]+>", " ", cell)).strip()
                for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)
            ]
            cells = [re.sub(r"\s+", " ", cell) for cell in cells]
            if any(cells):
                rows.append(cells)
        if not rows:
            continue
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        head = "| " + " | ".join(rows[0]) + " |"
        rule = "| " + " | ".join("---" for _ in range(width)) + " |"
        parts.append("\n".join([head, rule, *["| " + " | ".join(row) + " |" for row in rows[1:]]]))
    markdown = "\n\n".join(parts).strip()
    if not markdown:
        return []
    return [ParsedPage(page_no=1, markdown=markdown, blocks=[], has_tables=True, parser="local:html")]


async def parse_pdf(
    gateway: Gateway, pdf: Path, *, max_pages: int | None = None, force_vision: bool = False
) -> list[ParsedPage]:
    """Parse every page, and spend the vision model only where it is needed.

    A disturbance report carries a text layer that reads like prose, and reading
    it costs nothing. An operating instruction also carries one, but its pages
    are tables, and the text layer returns them as columns of words with the rows
    dissolved. Those pages go to the vision model, which returns the table as a
    table. So the rule is not "text layer first": it is "text layer when the text
    layer is good enough".
    """
    total = page_count(pdf)
    if max_pages:
        total = min(total, max_pages)
    pages: list[ParsedPage] = []
    for page_no in range(1, total + 1):
        if not force_vision:
            existing = text_layer(pdf, page_no)
            if len(existing) >= TEXT_LAYER_MIN_CHARS and not looks_tabular(existing):
                pages.append(
                    ParsedPage(
                        page_no=page_no,
                        markdown=existing,
                        blocks=[],
                        has_tables=False,
                        parser="local:pdftotext",
                    )
                )
                continue
        try:
            image = rasterize(pdf, page_no)
            result = await gateway.run("parse", tokens=1, image=image, pdf_path=pdf, page=page_no)
            blocks: list[Block] = result.value
            parser = f"{result.provider}:{result.model}"
        except (QuotaExhausted, ProviderError):
            # The chain is exhausted or the page defeated it. Take the text layer
            # if there is one, and say so, rather than dropping the page.
            try:
                from .gateway.adapters import PopplerAdapter

                blocks = PopplerAdapter().parse_pdf_page(pdf, page_no)
                parser = "local:pdftotext"
            except ProviderError:
                continue
        markdown, has_tables = blocks_to_markdown(blocks)
        if not markdown:
            continue
        pages.append(
            ParsedPage(
                page_no=page_no,
                markdown=markdown,
                blocks=[{"type": b.type, "text": b.text, "bbox": b.bbox} for b in blocks],
                has_tables=has_tables,
                parser=parser,
            )
        )
    return pages
