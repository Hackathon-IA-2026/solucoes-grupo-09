"""The Brazilian holiday calendar, generated once per version — never at feature time.

``docs/specs/feature-engineering.md`` §"The holiday calendar — data, not a
library call" is unusually specific about this, and the reason is worth keeping
in front of whoever reads the module next:

    A library upgrade that changes one moveable feast would otherwise silently
    restate three years of training features with no migration, no diff and no
    test failure.

Carnival is a moveable feast. ``holidays`` 0.103 places Carnaval 2025 on 3–4
March; a future release that corrected that by a day would, if the calendar were
a library call inside the feature function, rewrite the ``calendar_is_holiday_*``
columns of every past row the next time anyone rebuilt features — and the model
trained on the old columns would still be in production, scoring against the new
ones. Nothing in the system would report that.

So the calendar is **data**. This module runs offline, writes
``packages/core/fixtures/calendar/br_calendar_v1.json``, and the artifact is
loaded into ``feature_calendar_day`` by
``apps/api/src/features/calendar/calendar-repository.ts``. The feature function
reads only that table. Regeneration is an explicit act whose output diff is
reviewed:

* a diff confined to **future** dates is an ordinary extension of the horizon,
* a non-empty diff over **past** dates is a **retrain trigger** — the training
  features are no longer the features the deployed model was fitted on, and a
  new calendar version (``br_calendar_v2``) with a new feature-set version is
  the only honest response. The stored version is immutable, which is what makes
  "no in-place edit" a property of the schema rather than a convention.

:func:`generate_calendar` is deterministic given the pinned library version, and
``tests/test_calendar_generator.py`` asserts it reproduces the checked-in
artifact byte for byte. That test is the guard against a silent upgrade: bumping
``holidays`` in ``pyproject.toml`` without regenerating fails it.

## What is in the table

``(day, uf, name, category)``, plus the pinned generator version on the header
row, exactly as the spec names them.

* ``uf = 'BR'`` is a **national** holiday. ``uf = 'BA'`` is a holiday observed in
  Bahia and not nationally — the national ones are not repeated per state, so the
  national/regional separation is a property of the rows rather than a filter a
  reader has to remember to apply.
* ``category`` is ``holidays``' own: ``public`` or ``optional``. Both are
  generated, because Carnival and Corpus Christi are *optional* in the library's
  taxonomy and move the Brazilian load curve as much as any statutory holiday.
  The column keeps the distinction available for a later refinement without
  requiring a regeneration to recover it.
* Municipal holidays are out of scope — ``holidays`` does not carry them (its
  ``São Paulo Capital`` subdivision is the single exception, and it is skipped
  along with everything else that is not one of the 27 UF codes) and they do not
  move a subsystem.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from hashlib import sha256
from importlib.metadata import version as installed_version
from pathlib import Path

from holidays.constants import OPTIONAL, PUBLIC
from holidays.countries import Brazil

#: The calendar version. A business key, and immutable once loaded: a
#: regeneration that changes any past row is ``br_calendar_v2``, never an edit
#: to this one. Mirrored by ``CALENDAR_VERSION`` in
#: ``apps/api/src/features/calendar/calendar.ts`` and asserted equal there.
CALENDAR_VERSION = "br_calendar_v1"

#: The pinned generator, spelled as the requirement that produces it.
#: ``pyproject.toml`` pins ``holidays==0.103`` exactly, and
#: :func:`generate_calendar` refuses to write an artifact under a different one
#: rather than producing a file whose provenance line is a guess.
GENERATOR = "holidays==0.103"

#: The horizon. It opens well before the feature window (2024-04) so that the
#: lag features of ticket 05 can look backwards out of it, and closes far enough
#: ahead that serving tomorrow never falls off the end — a day outside the range
#: is reported as NULL rather than as "not a holiday", so the edge is visible
#: instead of being a quiet false.
DAY_FROM = "2023-01-01"
DAY_TO = "2032-12-31"

#: The 27 federal units. ``Brazil.subdivisions`` also carries
#: ``São Paulo Capital``, which is municipal; it is excluded by construction
#: rather than by name, since a two-letter code is exactly what a UF is.
UFS: tuple[str, ...] = tuple(
    sorted(code for code in Brazil.subdivisions if len(code) == 2)
)

CATEGORIES: tuple[str, ...] = (PUBLIC, OPTIONAL)

#: Where the artifact lives. Shared rather than inside ``apps/ml`` because the
#: loader that writes it into Postgres is TypeScript, and a file only one of the
#: two languages that use it can see is not a shared definition.
ARTIFACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "packages"
    / "core"
    / "fixtures"
    / "calendar"
    / f"{CALENDAR_VERSION}.json"
)


@dataclass(frozen=True, order=True)
class CalendarDay:
    """One (day, uf, name, category) row. Ordered, so a set has one rendering."""

    day: str
    uf: str
    category: str
    name: str


def _digest_line(row: CalendarDay) -> str:
    return f"{row.day}|{row.uf}|{row.category}|{row.name}"


def calendar_digest(rows: Iterable[CalendarDay]) -> str:
    """A digest over the rows, in the one serialisation both languages compute.

    ``day|uf|category|name`` per line, newline-joined, SHA-256, hex. Deliberately
    trivial: ``calendar-artifact.ts`` recomputes it on load, so the format has to
    be one a reader can reimplement without a library, and the loader refuses an
    artifact whose digest does not match its rows.
    """
    joined = "\n".join(_digest_line(row) for row in rows)
    return f"sha256:{sha256(joined.encode('utf-8')).hexdigest()}"


def generate_rows(day_from: str = DAY_FROM, day_to: str = DAY_TO) -> list[CalendarDay]:
    """Every holiday row in the horizon, national and state-only, sorted.

    A state's rows are the subdivision's holidays **minus the national ones**.
    ``Brazil(subdiv='BA')`` returns Tiradentes as well as Independência
    da Bahia; storing that verbatim would make ``calendar_holiday_state_share``
    read 1.0 on every national holiday and the regional signal would vanish into
    the national one it is separated from on purpose.

    The subtraction is per **name**, not per date, and that is not a detail.
    ``holidays`` renders two holidays falling on one day as a single joined
    string — 21 April 2025 in the Federal District is
    ``'Fundação de Brasília; Tiradentes'`` — so a date-keyed or string-keyed
    subtraction leaves the national holiday attached to the state row and DF
    acquires a spurious regional holiday on every Tiradentes. ``get_list``
    returns the names individually, which is why it is used here rather than
    iterating ``items()``.

    It is also **across categories**, not within one. Rio de Janeiro observes
    Carnival as a statutory *public* holiday where the country observes it as
    *optional*; subtracting category by category would keep an ``RJ`` row for a
    day the whole country already takes off, and
    ``calendar_holiday_state_share`` is meant to measure regional *divergence*,
    not to re-report the national binary sitting in the next column.
    """
    years = list(range(int(day_from[:4]), int(day_to[:4]) + 1))
    rows: set[CalendarDay] = set()
    national_names: dict[object, set[str]] = {}

    for category in CATEGORIES:
        national = Brazil(years=years, categories=(category,))
        for day in national:
            names = set(national.get_list(day))
            national_names.setdefault(day, set()).update(names)
            for name in names:
                rows.add(CalendarDay(day.isoformat(), "BR", category, name))

    for category in CATEGORIES:
        for uf in UFS:
            observed = Brazil(years=years, subdiv=uf, categories=(category,))
            for day in observed:
                for name in set(observed.get_list(day)) - national_names.get(day, set()):
                    rows.add(CalendarDay(day.isoformat(), uf, category, name))

    return sorted(row for row in rows if day_from <= row.day <= day_to)


def generate_calendar(
    day_from: str = DAY_FROM, day_to: str = DAY_TO
) -> dict[str, object]:
    """The artifact, as a dictionary. Deterministic given the pinned library."""
    installed = installed_version("holidays")
    if f"holidays=={installed}" != GENERATOR:
        raise RuntimeError(
            f"holidays is {installed}, and this generator is pinned to "
            f"{GENERATOR}. Bumping the pin is a regeneration: update GENERATOR, "
            "rewrite the artifact, and review the diff — a non-empty diff over "
            "past dates is a retrain trigger and needs a new calendar version."
        )

    rows = generate_rows(day_from, day_to)
    return {
        "version": CALENDAR_VERSION,
        "generator": GENERATOR,
        "day_from": day_from,
        "day_to": day_to,
        "row_count": len(rows),
        "digest": calendar_digest(rows),
        "days": [
            {"day": row.day, "uf": row.uf, "name": row.name, "category": row.category}
            for row in rows
        ],
    }


def render(artifact: dict[str, object]) -> str:
    """The artifact as it is written to disk — one rendering, so a diff is real."""
    return json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def write_calendar(path: Path = ARTIFACT_PATH) -> Path:
    """Regenerate the artifact in place. The reviewable half of the job is the diff."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(generate_calendar()), encoding="utf-8")
    return path


if __name__ == "__main__":  # pragma: no cover - an operator's entry point
    written = write_calendar()
    print(f"wrote {written}")
