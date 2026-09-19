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

SECTION = re.compile(r"^\s*(?:#+\s*)*(\d+(?:\.\d+)*)\.?\s+([^\n]{3,250})$", re.M)
SECTION_MAX_CHARS = 120  # longer only in capitals: "6.2.2 CONTROLE ... PREVENINDO A PERDA DA LT ..."


# The daily report's highlights run "Submercado Sul:" as a line of its own and
# then the paragraphs about it, with no number in front. Read as prose, the
# submarket was lost to every paragraph but the first, and a reduction quoted
# from the second was refused, rightly, as not saying which submarket it was.
SUBMARKET = re.compile(r"^[ \t#]*(Submercado [^:\n]{2,40}:)[ \t]*$", re.M)
SUBMARKET_HEADING = re.compile(r"^(Submercado)\s+([^:\n]{2,40}):$")


def heading_of(block: str) -> re.Match | None:
    """A numbered title, however many "#" the parser put in front of it.

    Without the capitals rule a numbered paragraph ("6.1.1. Cabe ao COSR-NE
    adotar ...") would read as a heading; without the long-title rule 6.2.2 of
    IO-ON.NE.2NO, 125 characters, did not, and its table went to 6.2.3.
    """
    if submarket := SUBMARKET_HEADING.match(block.strip()):
        return submarket
    match = SECTION.match(block.strip())
    if match and (len(match.group(2)) <= SECTION_MAX_CHARS or match.group(2).isupper()):
        return match
    return None


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
    return heading_of(stripped) is not None


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


def split_page(markdown: str, section: str | None = None) -> list[tuple[str | None, str]]:
    """Break a page into (section, text) pairs, keeping tables whole.

    `section` is where the previous page ended: text above the first heading of
    a page continues it (the Northeast highlights of an IPDO run onto the next
    page, and so do the tables of an operating instruction's section).
    """
    markdown = SUBMARKET.sub(r"\n\n\1\n\n", markdown)
    out: list[tuple[str | None, str]] = []
    current_section: str | None = section
    buffer: list[str] = []
    # Headings not yet followed by anything. The vision model reads a page of
    # IO-ON.NE.2NO as "6.2.2 ..., 6.2.3 ..., table, table": both titles first.
    # Taken in order, the first table gets the first title; flushing on the
    # second heading had left 6.2.2 alone and filed its limit under 6.2.3.
    waiting: list[tuple[str, str]] = []

    def flush() -> None:
        text = "\n\n".join(buffer).strip()
        if text:
            out.append((current_section, text))
        buffer.clear()

    for block in re.split(r"\n{2,}", markdown):
        block = block.strip()
        if not block:
            continue
        heading = heading_of(block)
        if heading:
            flush()
            if _parent_waiting(waiting, heading.group(1)):
                out.append(waiting.pop())
            current_section = f"{heading.group(1)} {heading.group(2).strip()}"
            waiting.append((current_section, re.sub(r"^(?:#+\s*)+", "", block)))
            continue
        if _is_table(block):
            # A table that follows its own heading keeps it. Flushing here left
            # "## 5.4. LIMITAÇÃO DA TRANSMISSÃO NA LT 500 KV AÇU III /
            # JAGUARUANA II - C1(V7)" alone, too short to be a chunk, so it was
            # glued to the end of section 5.3 and the limits of 5.4 became a
            # table nobody could name. The only quotable thing left was the
            # heading, which is not evidence.
            flush()
            section, title = waiting.pop(0) if waiting else (current_section, "")
            for piece in split_steps(block):
                out.append((section, f"{title}\n\n{piece}" if title else piece))
            continue
        # Prose belongs to the last heading; any before it had nothing under them.
        out.extend(waiting[:-1])
        if waiting:
            buffer.append(waiting[-1][1])
            waiting.clear()
        buffer.append(block)
    flush()
    out.extend(waiting)
    return out


def _parent_waiting(waiting: list[tuple[str, str]], number: str) -> bool:
    """6.2 right above 6.2.1 is the parent's title, not the owner of a table."""
    return bool(waiting) and number.startswith(waiting[-1][0].split(" ", 1)[0] + ".")


STEP = re.compile(r"^\d+$")


def split_steps(table: str) -> list[str]:
    """One piece per step of a procedure table, each under the table's header.

    A step table holds several controls, and a quote from step 2 was drawn from
    a chunk that also held step 1's limit. Sub-steps (2.1, and the rows of the
    plants table under it) stay with their step.
    """
    lines = table.split("\n")
    if len(lines) < 4 or "Passo" not in lines[0]:
        return [table]
    head, groups = lines[:2], [[]]
    for row in lines[2:]:
        first = next((cell.strip() for cell in row.strip().strip("|").split("|") if cell.strip()), "")
        if STEP.match(first) and groups[-1]:
            groups.append([])
        groups[-1].append(row)
    return ["\n".join(head + group) for group in groups]


# The band every page of an ONS document repeats, as the text layer and the
# vision model return it. A case in the validation of 18/09/2026 quoted
# "Alterado pela(s) MOP(s): ... Submódulo 5.12" as its evidence, and the page
# header table of an operating instruction outranked the section it heads.
# Anchored at the start of a line so that a sentence citing the manual stays.
FURNITURE_LINE = re.compile(
    r"^\s*(?:alterado pela\(s\) mop|mop/ons \d|manual de procedimentos da opera|endereço na internet"
    r"|referência:|instruç(?:ão|ões) de operação\s+código\s+revisão|rap-ons \d+/\d{4} - análise"
    r"|ons\s+de análise de perturbação - rap|\d+\s*/\s*\d+\s*$"
    # The whole line and nothing else: a sentence of the Submódulo 4.2 also
    # starts with "Operador Nacional do Sistema Elétrico – ONS, bem como ...".
    r"|.{0,6}operad\w* nacional d\w sist\w* el\w*\s*$)",
    re.IGNORECASE,
)
# "S", "E", "O S": the logo, read as letters. Never a digit: "57 MW" and "- 25"
# on a line of their own are a limit and a sensitivity in a text-layer table.
STRAY = re.compile(r"^\s*(?:[A-Z]|[A-Z] [A-Z]|OS)\s*$")
HEADER_TABLE = re.compile(r"^\|\s*Instruç(?:ão|ões) de Operação\s*\|\s*Código", re.IGNORECASE)


def strip_furniture(markdown: str) -> str:
    """The page without its running header and footer."""
    blocks = [block for block in re.split(r"\n{2,}", markdown) if not HEADER_TABLE.match(block.strip())]
    kept = [
        "\n".join(
            line for line in block.split("\n") if not FURNITURE_LINE.match(line) and not STRAY.match(line)
        )
        for block in blocks
    ]
    return "\n\n".join(block for block in kept if block.strip())


def chunk_pages(pages: list[dict]) -> list[Chunk]:
    """`pages` are dicts with page_no, markdown and the parser's blocks."""
    chunks: list[Chunk] = []
    carried: str | None = None
    for page in pages:
        for section, text in split_page(strip_furniture(page["markdown"]), carried):
            carried = section
            for piece in _slice(text):
                if _absorbed(chunks, piece, page["page_no"], section):
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


def _can_join(previous: Chunk, piece: str, page_no: int, section: str | None) -> bool:
    """Same page, room left, and the same section: a short "Submercado Norte"
    paragraph glued to the Sul chunk above it would be quoted as the Sul's."""
    if previous.page_end != page_no or len(previous.text) + len(piece) >= MAX_CHARS:
        return False
    return not (section and previous.section_path and section != previous.section_path)


def _absorbed(chunks: list[Chunk], piece: str, page_no: int, section: str | None = None) -> bool:
    """Too small to stand alone: attach to the previous chunk of the same page
    rather than emit a citation nobody can use."""
    # A heading opens a section, so it never joins the one before it, and a short
    # table is still a table: absorbing it buries the rows inside the previous
    # section and loses the locator that says they are rows.
    if len(piece) >= MIN_CHARS or not chunks or _has_table(piece) or _is_heading(piece):
        return False
    previous = chunks[-1]
    if not _can_join(previous, piece, page_no, section):
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
