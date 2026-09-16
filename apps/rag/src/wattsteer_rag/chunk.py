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
            flush()
            out.append((current_section, block))
            continue
        buffer.append(block)
    flush()
    return out


def chunk_pages(pages: list[dict]) -> list[Chunk]:
    """`pages` are dicts with page_no, markdown and the parser's blocks."""
    chunks: list[Chunk] = []
    ordinal = 0
    for page in pages:
        for section, text in split_page(page["markdown"]):
            for piece in _slice(text):
                if len(piece) < MIN_CHARS and chunks and not _is_table(piece):
                    # Too small to stand alone: attach to the previous chunk of
                    # the same page rather than emit a citation nobody can use.
                    previous = chunks[-1]
                    if previous.page_end == page["page_no"] and len(previous.text) + len(piece) < MAX_CHARS:
                        previous.text = f"{previous.text}\n\n{piece}"
                        continue
                ordinal += 1
                chunks.append(
                    Chunk(
                        ordinal=ordinal,
                        text=piece,
                        page_start=page["page_no"],
                        page_end=page["page_no"],
                        section_path=section,
                        locator={
                            "page": page["page_no"],
                            "section": section,
                            "table": "table" if _is_table(piece) else None,
                            "kind": "toc" if is_table_of_contents(piece) else "body",
                            "bbox": _bbox_for(page, piece),
                        },
                    )
                )
    return chunks


def _slice(text: str) -> list[str]:
    if len(text) <= MAX_CHARS or _is_table(text):
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
