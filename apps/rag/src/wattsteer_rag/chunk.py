"""Splitting a document into things worth citing.

Two rules decide the shape. A chunk never crosses a numbered section, because
the operating instructions are cited by section ("item 5.1") and a citation that
spans two sections cannot be checked. A table is never split, because half a
table is a number without its heading.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_CHARS = 2600  # around 700 tokens of Portuguese
MIN_CHARS = 280
OVERLAP_CHARS = 260

SECTION = re.compile(r"^\s*(?:##\s*)?(\d+(?:\.\d+)*)\.?\s+([^\n]{3,120})$", re.M)


@dataclass
class Chunk:
    ordinal: int
    text: str
    page_start: int
    page_end: int
    section_path: str | None = None
    locator: dict = field(default_factory=dict)

    @property
    def tokens(self) -> int:
        return max(1, len(self.text) // 4)


def _is_table(block: str) -> bool:
    return block.lstrip().startswith("|")


def _is_heading(block: str) -> bool:
    """A section title and nothing else: one line, and that line is the title."""
    stripped = block.strip()
    if "\n" in stripped:
        return False
    return bool(SECTION.match(stripped.replace("## ", "", 1)))


def _has_table(block: str) -> bool:
    """A table is in here somewhere, even if the chunk opens with its heading."""
    return any(line.lstrip().startswith("|") for line in block.split("\n"))


LEADER = re.compile(r"\.{4,}")


def is_table_of_contents(text: str) -> bool:
    """A page of dotted leaders cites nothing.

    The index of an operating instruction repeats every section title, so it wins
    a keyword search against the section that actually states the rule. Keeping
    it in the corpus is how a retrieval ends up quoting "5.1. Limitação do Fluxo
    Senhor do Bonfim II" instead of the limit itself.
    """
    if len(LEADER.findall(text)) >= 3:
        return True
    lowered = text.lower()
    return "índice" in lowered[:120] and len(LEADER.findall(text)) >= 1


def split_page(markdown: str) -> list[tuple[str | None, str]]:
    """Break a page into (section, text) pairs, keeping tables whole."""
    out: list[tuple[str | None, str]] = []
    current_section: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        text = "\n\n".join(buffer).strip()
        if text:
            out.append((current_section, text))
        buffer.clear()

    for block in re.split(r"\n{2,}", markdown):
        block = block.strip()
        if not block:
            continue
        heading = SECTION.match(block.replace("## ", "", 1))
        if heading:
            flush()
            current_section = f"{heading.group(1)} {heading.group(2).strip()}"
            buffer.append(block.replace("## ", "", 1))
            continue
        if _is_table(block):
            # A table that follows its own heading keeps it. Flushing here left
            # "## 5.4. LIMITAÇÃO DA TRANSMISSÃO NA LT 500 KV AÇU III /
            # JAGUARUANA II - C1(V7)" alone, too short to be a chunk, so it was
            # glued to the end of section 5.3 and the limits of 5.4 became a
            # table nobody could name. The only quotable thing left was the
            # heading, which is not evidence.
            pending = "\n\n".join(buffer).strip()
            if pending and _is_heading(pending):
                buffer.clear()
                out.append((current_section, f"{pending}\n\n{block}"))
                continue
            flush()
            out.append((current_section, block))
            continue
        buffer.append(block)
    flush()
    return out


def chunk_pages(pages: list[dict]) -> list[Chunk]:
    """`pages` are dicts with page_no, markdown and the parser's blocks."""
    chunks: list[Chunk] = []
    for page in pages:
        for section, text in split_page(page["markdown"]):
            for piece in _slice(text):
                if _absorbed(chunks, piece, page["page_no"]):
                    continue
                chunks.append(_chunk(len(chunks) + 1, page, section, piece))
    _mark_page_furniture(chunks)
    return chunks


FURNITURE_PAGES = 3
FURNITURE_MAX_CHARS = 700


def _mark_page_furniture(chunks: list[Chunk]) -> None:
    """The header that is on every page is not a passage.

    Every page of an operating instruction repeats the same band: "Alterado
    pela(s) MOP(s): ... Manual de Procedimentos da Operação - Módulo 5 -
    Submódulo 5.12", and it carries the document's own code. A search for
    IO-ON.NE.5NE therefore ranks the running header above the section that
    states the limit, and once retrieval is restricted to the named document the
    header fills every slot. Repetition across pages is what identifies it, so
    it can only be seen here, with the whole document in hand.
    """
    pages_by_text: dict[str, set[int]] = {}
    for chunk in chunks:
        # Tables are included: the band that identifies the document is laid
        # out as one, and a table of real content does not repeat unchanged
        # on three pages.
        if len(chunk.text) > FURNITURE_MAX_CHARS:
            continue
        pages_by_text.setdefault(_furniture_key(chunk.text), set()).add(chunk.page_start)
    for chunk in chunks:
        if chunk.locator.get("kind") != "body":
            continue
        pages = pages_by_text.get(_furniture_key(chunk.text))
        if pages and len(pages) >= FURNITURE_PAGES:
            chunk.locator["kind"] = "furniture"


def _furniture_key(text: str) -> str:
    return re.sub(r"[\s|-]+", " ", text).strip().lower()[:160]


def _absorbed(chunks: list[Chunk], piece: str, page_no: int) -> bool:
    """Too small to stand alone: attach to the previous chunk of the same page
    rather than emit a citation nobody can use."""
    # A heading opens a section, so it never joins the one before it, and a short
    # table is still a table: absorbing it buries the rows inside the previous
    # section and loses the locator that says they are rows.
    if len(piece) >= MIN_CHARS or not chunks or _has_table(piece) or _is_heading(piece):
        return False
    previous = chunks[-1]
    if previous.page_end != page_no or len(previous.text) + len(piece) >= MAX_CHARS:
        return False
    previous.text = f"{previous.text}\n\n{piece}"
    # An index page arrives one entry at a time, and a single entry carries one
    # dotted leader, which is not enough to look like an index. The page only
    # becomes recognisable once the entries are back together, so the kind is
    # decided again on the text as it now stands. Without this the index of
    # IO-ON.NE.5NE is stored as body, outranks the section that states the limit
    # on every keyword the record carries, and the answer cites a line of the
    # table of contents.
    previous.locator["kind"] = "toc" if is_table_of_contents(previous.text) else previous.locator["kind"]
    return True


def _chunk(ordinal: int, page: dict, section: str | None, piece: str) -> Chunk:
    return Chunk(
        ordinal=ordinal,
        text=piece,
        page_start=page["page_no"],
        page_end=page["page_no"],
        section_path=section,
        locator={
            "page": page["page_no"],
            "section": section,
            "table": "table" if _has_table(piece) else None,
            "kind": "toc" if is_table_of_contents(piece) else "body",
            "bbox": _bbox_for(page, piece),
        },
    )


def _slice(text: str) -> list[str]:
    # Half a table is a number without its heading, and that stays true when
    # the chunk opens with the section title the table belongs to.
    if len(text) <= MAX_CHARS or _has_table(text):
        return [text]
    pieces: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + MAX_CHARS)
        if end < len(text):
            window = text.rfind("\n", start + MIN_CHARS, end)
            if window == -1:
                window = text.rfind(" ", start + MIN_CHARS, end)
            if window != -1:
                end = window
        pieces.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - OVERLAP_CHARS, start + 1)
    return [piece for piece in pieces if piece]


def _bbox_for(page: dict, piece: str) -> dict | None:
    """The coordinates of the block this text came from, when the parser gave them."""
    head = piece.strip()[:60]
    for block in page.get("blocks") or []:
        if block.get("bbox") and head and head[:30] in (block.get("text") or ""):
            return block["bbox"]
    return None
