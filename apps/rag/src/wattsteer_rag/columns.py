"""A small table in a PDF's text layer, given back its column names.

The daily report's page 3 opens with a table (storage by subsystem) and goes on
as prose, so it is read from the text layer, where the table survives only as
aligned words: a header line with the column names, then a label and its
numbers. Worse, the layout sometimes puts the numbers on a line of their own,
above the label on one day and below it on another:

    Energia Armazenada                    SIN      Sul    SE/CO   Norte    NE
    Capacidade Máxima (MWmês)          292.068  20.459  204.615  15.302  51.691
                                       153.799  18.592   96.283  12.137  26.787
    Armazenamento ao final do dia (MWmês)

Measured on 19/09/2026: asked for the Northeast's storage, the answer could not
tell which of five numbers was the Northeast's and the question was refused.
Each row is rewritten as one line, every number next to its column's name. A
line of bare numbers joins the one neighbouring label that has no numbers of
its own, and only when there is exactly one; otherwise it is left as it was,
because a guess here is a number under the wrong subsystem.
"""

from __future__ import annotations

import re

GAP = re.compile(r"\s{2,}")
NUMBER = re.compile(r"^[-+]?\d[\d.,]*%?$")
NAME = re.compile(r"^[A-ZÀ-Ý][A-Za-zÀ-ÿ/]{1,7}$")  # SIN, Sul, SE/CO, Norte, NE


def _parts(line: str) -> list[str]:
    return [part for part in GAP.split(line.strip()) if part]


def _split(line: str) -> tuple[str, list[str]]:
    """(label, trailing numbers); a number inside the label stays in the label."""
    parts = _parts(line)
    numbers: list[str] = []
    while parts and NUMBER.match(parts[-1]):
        numbers.insert(0, parts.pop())
    return " ".join(parts), numbers


def _header(line: str) -> list[str]:
    names = []
    for part in reversed(_parts(line)):
        tokens = part.split()
        if not all(NAME.match(token) for token in tokens):
            break
        names = tokens + names
    return names if len(names) >= 3 else []


def label_columns(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    names: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if header := _header(line):
            names = header
        elif names and line.strip():
            upto, row = _row(lines, index, len(names))
            if row is None:
                names = []  # the table has ended
            else:
                out.append(_labelled(row[0], names, row[1]))
                index = upto + 1
                continue
        out.append(line)
        index += 1
    return "\n".join(out)


def _next(lines: list[str], index: int) -> int | None:
    """The next line with text after `index`: the layout puts blank lines between rows."""
    for position in range(index + 1, len(lines)):
        if lines[position].strip():
            return position
    return None


def _at(lines: list[str], index: int | None) -> tuple[str, list[str]]:
    return _split(lines[index]) if index is not None else ("", [])


def _row(lines: list[str], index: int, width: int) -> tuple[int, tuple[str, list[str]] | None]:
    """The row starting at `index` and the last line it used, or None past the table."""
    label, numbers = _split(lines[index])
    if label and len(numbers) == width:
        return index, (label, numbers)
    second = _next(lines, index)
    other = _at(lines, second)
    if second is not None and _fell_below(label, numbers, other, _at(lines, _next(lines, second)), width):
        return second, (label, other[1])
    if second is not None and _rose_above(label, numbers, other, width):
        return second, (other[0], numbers)
    return index, None


def _fell_below(label: str, numbers: list[str], other: tuple, after: tuple, width: int) -> bool:
    """A label alone, then its numbers, which the label after them does not also claim."""
    bare_below = bool(label) and not numbers and not other[0] and len(other[1]) == width
    return bare_below and not (after[0] and not after[1])


def _rose_above(label: str, numbers: list[str], other: tuple, width: int) -> bool:
    """Bare numbers, then a label alone."""
    return not label and len(numbers) == width and bool(other[0]) and not other[1]


def _labelled(label: str, names: list[str], numbers: list[str]) -> str:
    return " | ".join([label, *(f"{name}: {value}" for name, value in zip(names, numbers, strict=True))])
