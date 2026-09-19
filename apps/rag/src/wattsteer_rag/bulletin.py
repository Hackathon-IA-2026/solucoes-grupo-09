"""The daily bulletin's HTML, read one table row at a time.

The BDO publishes its numbers as HTML tables, and three things about that HTML
decided the shape of this reader, all measured on the stored bulletins of
5 to 14 September 2026:

- Tables sit inside tables. A pattern match on `<table>...</table>` stops at the
  first inner close, so the energy balance came out as one pipe table with its
  blocks run together, and "LAPA" and the SIN's solar total ended up in the same
  chunk. A model asked for LAPA quoted 11,802, the SIN's figure, not 9,39.
- The balance names neither the subsystem nor the column in its text. Both are
  drawn in the background image; the markup only carries them in the id of the
  cell (`lbl_GeracaoEolicaNE` is verified, `lbl_GeracaoEolicaNE_P` scheduled).
  Without them "Eólica | 65,74% | 17.253 | 16.228" answers no question.
- A table of plants is 200 rows under one header. A number six rows below its
  header is a number without a column.

So every row becomes one self-describing line: the day, the table's title, and
each value next to the name of its column. A line is emitted as a one-row pipe
table, which the chunker keeps as its own chunk, so a quote can only carry the
numbers of the row it came from.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

NUMERIC = re.compile(r"[-+]?[\d.,]+%?|\d{2}/\d{2}/\d{4}|\d{2}:\d{2}(:\d{2})?")
MARKER = re.compile(r"\s*-->\s*")  # "--> CONJUNTO EOLICO ARIZONA -->": an arrow image's alt text
TITLE_MAX_CHARS = 90
SKIPPED = {"script", "style", "title"}
TABLE_TAGS = {"table", "tr", "td", "th"}

# The balance's ids: a subsystem suffix, then an optional scheduled/verified mark.
SUBSYSTEM = {"NE": "Nordeste", "SE": "Sudeste/Centro-Oeste", "N": "Norte", "S": "Sul"}
BALANCE_ID = re.compile(r"^lbl_.*?(NE|SE|N|S)(_?P|_V)?$")
SIN_ID = re.compile(r"^lbl_sin_\w+_(p|v|perc)$")
# The rows of the balance, by the name in their first cell. Only these are read
# by id: the international exchange rows carry ids ending in _N too.
BALANCE_ROWS = {
    *("Hidro", "Termo", "Nuclear", "Eólica", "Solar", "Total", "Carga(*)", "Carga (*)"),
    *("Hidro Nacional", "Itaipu Binacional", "Termo Nuclear", "Termo Convencional", "Total SIN"),
    *("Intercâmbio Internacional", "50 Hz", "60 Hz"),
}


@dataclass
class Cell:
    text: str = ""
    ids: list[str] = field(default_factory=list)
    colspan: int = 1


class _Rows(HTMLParser):
    """Every `<tr>` with its own cells, nested tables included, in page order.

    Text outside any cell is a row of its own: the regional accumulated data
    names its subsystem ("Subsistema Sul") in a `<span>` above the table, and
    without it five files carry the same columns for five different regions.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[Cell]] = []
        self._levels: list[dict] = []  # one per open table: the row and the cell being read
        self._loose: list[str] = []
        self._skip = 0  # inside <script> or <style>

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in SKIPPED:
            self._skip += 1
        elif (cell := self._open_cell()) is not None and tag not in TABLE_TAGS:
            self._inside_cell(cell, tag, dict(attrs))
        else:
            self.flush_loose()
            self._structure(tag, dict(attrs))

    def _structure(self, tag: str, attrs: dict) -> None:
        if tag == "table":
            self._levels.append({"row": None, "cell": None})
        elif not self._levels:
            return
        elif tag == "tr":
            self._close_row()
            self._levels[-1]["row"] = []
        elif tag in ("td", "th"):
            self._close_cell()
            span = attrs.get("colspan") or "1"
            self._levels[-1]["cell"] = Cell(colspan=int(span) if span.isdigit() else 1)

    def _inside_cell(self, cell: Cell, tag: str, attrs: dict) -> None:
        if tag == "br":
            cell.text += " "  # "no<br>Mês" is two words
        if attrs.get("id"):
            cell.ids.append(attrs["id"])

    def handle_endtag(self, tag: str) -> None:
        if tag in SKIPPED:
            self._skip = max(0, self._skip - 1)
            return
        if self._open_cell() is None:
            self.flush_loose()
        if not self._levels:
            return
        if tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr":
            self._close_row()
        elif tag == "table":
            self._close_row()
            self._levels.pop()

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if (cell := self._open_cell()) is not None:
            cell.text += data
        else:
            self._loose.append(data)

    def flush_loose(self) -> None:
        text = _clean("".join(self._loose))
        self._loose.clear()
        if text:
            self.rows.append([Cell(text=text)])

    def _open_cell(self) -> Cell | None:
        return self._levels[-1]["cell"] if self._levels else None

    def _close_cell(self) -> None:
        level = self._levels[-1]
        if level["cell"] is not None and level["row"] is not None:
            cell = level["cell"]
            cell.text = _clean(cell.text)
            level["row"].append(cell)
        level["cell"] = None

    def _close_row(self) -> None:
        self._close_cell()
        level = self._levels[-1]
        if level["row"]:
            cells = [cell for cell in level["row"] if cell.text]
            if cells:
                self.rows.append(cells)
        level["row"] = None


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", MARKER.sub(" ", text)).strip()


def read_rows(raw: str) -> list[list[Cell]]:
    parser = _Rows()
    parser.feed(raw)
    parser.close()
    parser.flush_loose()
    return parser.rows


def _is_number(text: str) -> bool:
    return bool(NUMERIC.fullmatch(text.replace(" ", "")))


def _balance_label(cell: Cell) -> str | None:
    """What the balance's background image says about this cell, read from its id."""
    for cell_id in cell.ids:
        if "Itaipu" in cell_id:
            return f"Itaipu {'programado' if cell_id.endswith('_P') else 'verificado'}"
        if match := SIN_ID.match(cell_id):
            return {"p": "SIN programado", "v": "SIN verificado", "perc": "SIN participação"}[match.group(1)]
        if match := BALANCE_ID.match(cell_id):
            subsystem = SUBSYSTEM[match.group(1)]
            if cell.text.endswith("%"):
                return f"{subsystem} participação"
            return f"{subsystem} {'programado' if match.group(2) in ('P', '_P') else 'verificado'}"
    return None


class _Table:
    """The title and the column names in force while rows go by."""

    def __init__(self) -> None:
        self.title = ""
        self.header: list[str] = []
        self.full: list[str] = []  # the last row with every column
        # The page's first title names the balance: "Balanço de Energia Diário"
        # or "... Acumulado no Mês Até o Dia". A fixed "Balanço de Energia" made
        # the two read alike, and the month's 276 was given as the day's 271.
        self.page_title = "Balanço de Energia"
        self._titled = False
        self.spanned: list[int] = []  # header positions under a cell with colspan > 1
        self.header_just_set = False

    def set_title(self, title: str) -> None:
        self.title, self.header = title, []
        if not self._titled:
            self.page_title, self._titled = title, True

    def take_header(self, cells: list[Cell]) -> None:
        names = [name for cell in cells for name in [cell.text] * cell.colspan]
        if not (self.header_just_set and self._under_spans(names)):
            self.header = names
            self.spanned = [i for i, cell in enumerate(_expanded(cells)) if cell.colspan > 1]
        self.header_just_set = True

    def _under_spans(self, names: list[str]) -> bool:
        """A second header row, naming the columns under the cells that span."""
        spanned = self.spanned
        if spanned and len(names) == len(self.header):
            # "Sudeste/Centro-Oeste" spans "Previsto | Verificado | Desvio".
            self.header = [
                f"{self.header[i]} {name}" if i in spanned else name for i, name in enumerate(names)
            ]
            return True
        if spanned and len(names) == len(spanned):
            # "Vazão - m³/s" spans "Afluência | Defluência | ..." and nothing else moves.
            for position, name in zip(spanned, names, strict=True):
                self.header[position] = f"{self.header[position]} {name}"
            return True
        return False

    def pair(self, texts: list[str]) -> list[str]:
        """Each value next to its column, in a row a rowspan may have shortened."""
        self.header_just_set = False
        if len(texts) == 1:
            return texts  # a note or a sentence under the table, not a value of its first column
        if self.header and len(texts) < len(self.header) and len(self.full) == len(self.header):
            return self._pair_short(texts)
        if len(texts) == len(self.header):
            self.full = texts
        if len(texts) != len(self.header):
            # Numbers with no name to pair with (the balance's exchange arrows
            # are drawn in the image) answer nothing and would borrow the title
            # of whatever table came before.
            return [] if all(_is_number(text) for text in texts) else texts
        return _named(self.header, texts)

    def _pair_short(self, texts: list[str]) -> list[str]:
        """A rowspan removes a cell from either side, and only the shape says which.

        The reservoirs drop the basin on the left ("SEGREDO | 605,52 | ..."
        under "IGUACU"); the spinning reserve drops the hour on the right
        ("COSR-N | 20.283 | 17.567 | 2.716"). Borrowing from the left in both
        cases stored "Disponibilidade Sincronizada (a): SIN | Geração
        Verificada (b): 101.479 | Reserva Girante: 95.645", and the answer quoted
        it faithfully. The side kept is the one whose text-or-number pattern
        matches the last complete row; the cell borrowed on the left is the one
        the rowspan repeats, and nothing is invented on the right.
        """
        missing = len(self.header) - len(texts)
        borrowed = self.full[:missing] + texts
        if _shape(borrowed) == _shape(self.full):
            return _named(self.header, borrowed)
        return _named(self.header[: len(texts)], texts)


def _shape(texts: list[str]) -> list[bool]:
    return [_is_number(text) for text in texts]


def _named(names: list[str], texts: list[str]) -> list[str]:
    return [
        f"{name}: {value}" if name and name != value else value
        for name, value in zip(names, texts, strict=True)
    ]


def bulletin_lines(raw: str, heading: str = "") -> list[str]:
    """One line per row that carries a number or a sentence, each able to stand alone."""
    table = _Table()
    lines: list[str] = []
    for cells in read_rows(raw):
        texts = [cell.text for cell in cells]
        if balance := _balance_values(cells):
            lines.append(_line(heading, table.page_title, balance))
        elif _is_title(texts):
            table.set_title(texts[0])
        elif len(texts) > 1 and not any(_is_number(text) for text in texts):
            table.take_header(cells)
        elif values := table.pair(texts):
            lines.append(_line(heading, table.title, values))
    return lines


def _expanded(cells: list[Cell]) -> list[Cell]:
    return [cell for cell in cells for _ in range(cell.colspan)]


def _is_title(texts: list[str]) -> bool:
    """A heading, not a sentence: "Não houve integração ... neste dia." is the answer."""
    text = texts[0]
    return (
        len(texts) == 1
        and len(text) <= TITLE_MAX_CHARS
        and not text.endswith(".")
        and not any(ch.isdigit() for ch in text)
    )


def _balance_values(cells: list[Cell]) -> list[str] | None:
    if cells[0].text not in BALANCE_ROWS or len(cells) < 2:
        return None
    labels = [_balance_label(cell) for cell in cells[1:]]
    # Every value named, or the row is not one of the balance's: the exchange
    # total is also called "Total" and only one of its ids looks like Norte's.
    if not all(labels):
        return None
    return [cells[0].text, *(f"{label}: {cell.text}" for label, cell in zip(labels, cells[1:], strict=True))]


def _line(heading: str, title: str, values: list[str]) -> str:
    context = " - ".join(part for part in (heading, title) if part)
    return "| " + " | ".join([context, *values] if context else values) + " |"
