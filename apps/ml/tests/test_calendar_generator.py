"""Seam 4, the calendar half: the guard against a silent library upgrade.

``docs/specs/feature-engineering.md`` §"Testing Decisions" asks for exactly two
things here and they are different tests:

1. **A fixture pinning known Brazilian holidays across several years**, moveable
   feasts included. That is a claim about the *content* — Carnival 2024 really is
   12–13 February — and it fails if the library moves a feast or if the
   national/regional split is computed wrongly.
2. **That regenerating at the pinned version reproduces the stored table
   exactly.** That is a claim about the *artifact*, and it is what turns a
   ``holidays`` bump into a red build instead of three years of silently
   restated training features.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wattsteer_ml import calendar_generator
from wattsteer_ml.calendar_generator import (
    CALENDAR_VERSION,
    GENERATOR,
    CalendarDay,
    artifact_path,
    calendar_digest,
    generate_calendar,
    generate_rows,
    render,
    repository_root,
)


def _artifact() -> dict[str, object]:
    stored: dict[str, object] = json.loads(artifact_path().read_text(encoding="utf-8"))
    return stored


def test_regenerating_reproduces_the_stored_artifact_exactly() -> None:
    """The upgrade guard. Byte for byte, not row set for row set.

    A comparison of parsed rows would pass a regeneration that reordered them,
    and the digest the loader checks is computed over the order — so the file is
    the thing that has to match.
    """
    assert render(generate_calendar()) == artifact_path().read_text(encoding="utf-8")


def test_the_artifact_names_the_version_that_produced_it() -> None:
    stored = _artifact()
    assert stored["version"] == CALENDAR_VERSION
    assert stored["generator"] == GENERATOR
    # The pin is the point: an artifact that did not say which library version
    # produced it could not be regenerated for comparison at all.
    assert GENERATOR.startswith("holidays==")


def test_the_digest_is_over_the_rows_in_the_order_they_are_written() -> None:
    stored = _artifact()
    days = stored["days"]
    assert isinstance(days, list)
    rows = [
        CalendarDay(row["day"], row["uf"], row["category"], row["name"]) for row in days
    ]
    assert stored["digest"] == calendar_digest(rows)
    assert stored["row_count"] == len(rows)


def test_known_holidays_are_pinned_across_several_years() -> None:
    """Moveable feasts and fixed ones, national, over three consecutive years.

    Carnival, Good Friday and Corpus Christi all hang off Easter and are the
    three the spec names, because they are the ones a library upgrade can move.
    """
    national = {
        (row.day, row.name)
        for row in generate_rows("2024-01-01", "2026-12-31")
        if row.uf == "BR"
    }

    for day, name in [
        # 2024 — a leap year, and Easter on 31 March.
        ("2024-02-12", "Carnaval"),
        ("2024-02-13", "Carnaval"),
        ("2024-03-29", "Sexta-feira Santa"),
        ("2024-05-30", "Corpus Christi"),
        ("2024-09-07", "Independência do Brasil"),
        # 2025 — Easter on 20 April.
        ("2025-03-03", "Carnaval"),
        ("2025-03-04", "Carnaval"),
        ("2025-04-18", "Sexta-feira Santa"),
        ("2025-06-19", "Corpus Christi"),
        ("2025-04-21", "Tiradentes"),
        # 2026 — Easter on 5 April.
        ("2026-02-16", "Carnaval"),
        ("2026-02-17", "Carnaval"),
        ("2026-04-03", "Sexta-feira Santa"),
        ("2026-06-04", "Corpus Christi"),
        ("2026-12-25", "Natal"),
    ]:
        assert (day, name) in national, f"{name} moved off {day}"


def test_state_rows_are_the_regional_holidays_and_only_those() -> None:
    """The national/regional separation, at its two hardest cases.

    Independência da Bahia is regional and must be present under ``BA``.
    Tiradentes is national and must not be repeated under any UF — including
    the Federal District, where ``holidays`` renders it joined to Fundação de
    Brasília in one string and a name-blind subtraction would keep both.
    """
    rows = generate_rows("2025-01-01", "2025-12-31")
    by_day = {(row.day, row.uf, row.name) for row in rows}

    assert ("2025-07-02", "BA", "Independência da Bahia") in by_day
    assert ("2025-04-21", "DF", "Fundação de Brasília") in by_day
    assert ("2025-11-15", "PR", "Nossa Senhora do Rocio") in by_day

    for _, uf, name in by_day:
        if uf != "BR":
            assert name not in {
                "Tiradentes",
                "Finados",
                "Proclamação da República",
                "Natal",
            }, f"{name} is national and must not be stored under {uf}"


def test_municipal_subdivisions_are_out_of_scope() -> None:
    """`holidays` carries one — `São Paulo Capital` — and it is not a UF."""
    ufs = {row.uf for row in generate_rows("2025-01-01", "2025-12-31")}
    assert all(uf == "BR" or len(uf) == 2 for uf in ufs)
    assert "São Paulo Capital" not in ufs
    # 27 federal units plus the national scope; not every UF has a regional
    # holiday in every year, so this is a ceiling rather than an equality.
    assert len(ufs) <= 28


def test_both_categories_are_generated() -> None:
    """Carnival and Corpus Christi are ``optional`` in the library's taxonomy.

    Generating only ``public`` would drop the two moveable feasts that move the
    load curve most, which is the whole reason the spec names the categories.
    """
    rows = generate_rows("2025-01-01", "2025-12-31")
    categories = {row.category for row in rows}
    assert categories == {"public", "optional"}
    optional_national = {
        row.name for row in rows if row.uf == "BR" and row.category == "optional"
    }
    assert {"Carnaval", "Corpus Christi"} <= optional_national


def test_the_artifact_path_is_found_by_search_not_by_counting_levels() -> None:
    """The container bug, as an assertion.

    ``parents[4]`` was right for ``apps/ml/src/wattsteer_ml/`` and wrong for the
    container's ``/app/src/wattsteer_ml/``, where it raised ``IndexError`` at
    *import* time — and ``declined.package_modules`` imports every module in the
    package, so that one line 500'd ``/v1/meta``.
    """
    root = repository_root()
    assert root is not None
    # The root is the checkout, identified by what is actually being addressed.
    assert (root / "packages" / "core" / "fixtures" / "calendar").is_dir()
    assert artifact_path().is_file()
    # Non-vacuity: the depth that the counted form encoded is an accident of
    # this layout, and the search must not depend on it.
    depth = len(Path(__file__).resolve().relative_to(root).parts)
    assert depth != 5, "the layout moved; this test is asserting the old accident"


def test_without_a_checkout_it_refuses_instead_of_raising_indexerror(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A container has no calendar to generate, and should be told so."""
    monkeypatch.setattr(calendar_generator, "repository_root", lambda: None)
    with pytest.raises(RuntimeError, match="not running from a checkout"):
        calendar_generator.artifact_path()
