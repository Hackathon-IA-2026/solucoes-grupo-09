"""Parity of the canonical read contract with the TypeScript side.

``packages/core/test/canonical-contract.test.ts`` reads the **same** directory
and asserts the **same** ``expected`` values against the TypeScript
implementation. Neither side compares against the other — only against the
vectors — so a shared misunderstanding cannot cancel out. See
``packages/core/fixtures/canonical-contract/README.md``.

Both suites fail when the directory holds a case they did not enumerate, so
adding a vector there is sufficient and neither language can quietly skip one.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml.canonical import (
    CANONICAL_BASE_PATH,
    CANONICAL_READS,
    VintageSource,
    combine_fidelity,
    combine_go_live,
    vintage_fidelity,
)
from wattsteer_ml.canonical_reads import _filters, _shift, view_name

# apps/ml/tests/… → repo root → packages/core/fixtures/canonical-contract
FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "canonical-contract"
)


def _instant(raw: str | None) -> datetime | None:
    """Parse an ISO-8601 instant. The vectors are UTC with an explicit ``Z``."""
    return None if raw is None else datetime.fromisoformat(raw.replace("Z", "+00:00"))


def _cases(subdirectory: str) -> list[tuple[str, dict[str, Any]]]:
    directory = FIXTURES / subdirectory
    files = sorted(directory.glob("*.json"))
    assert files, f"no vectors in {directory} — a passing run would mean nothing"
    return [(path.name, json.loads(path.read_text())) for path in files]


MANIFEST: dict[str, Any] = json.loads((FIXTURES / "manifest.json").read_text())


def test_base_path_matches_the_vector() -> None:
    assert MANIFEST["base_path"] == CANONICAL_BASE_PATH


def test_reads_are_exactly_the_vector_in_order() -> None:
    assert [read.name for read in CANONICAL_READS] == [
        read["name"] for read in MANIFEST["reads"]
    ]


@pytest.mark.parametrize("expected", MANIFEST["reads"], ids=lambda r: str(r["name"]))
def test_each_read_is_described_identically(expected: dict[str, Any]) -> None:
    actual = next(read for read in CANONICAL_READS if read.name == expected["name"])
    assert {
        "name": actual.name,
        "kind": actual.kind,
        "producer": actual.producer,
        "grain": actual.grain,
        "key": list(actual.key),
        "carries_restriction_cause": actual.carries_restriction_cause,
        "fidelity_axis": actual.fidelity_axis,
    } == expected


def test_a_restriction_cause_is_reachable_from_exactly_one_read() -> None:
    """`docs/domain-model.md` §3, asserted rather than trusted.

    A reason is a property of a ReportingEntity and there is no path in the type
    system from a Plant to one. A second ``True`` here would mean that path had
    been opened on this side.
    """
    carrying = [read.name for read in CANONICAL_READS if read.carries_restriction_cause]
    assert carrying == ["curtailment-by-reporting-entity"]


def test_forecast_reads_name_a_producer_and_observations_cannot() -> None:
    for read in CANONICAL_READS:
        if read.kind == "forecast":
            assert read.producer is not None
        else:
            assert read.producer is None


@pytest.mark.parametrize(("file", "case"), _cases("vintage-fidelity"))
def test_vintage_fidelity(file: str, case: dict[str, Any]) -> None:
    window_start = _instant(case["window_start"])
    assert window_start is not None, file
    assert (
        vintage_fidelity(window_start, _instant(case["go_live_at"])) == (case["expected"])
    )


@pytest.mark.parametrize(("file", "case"), _cases("vintage-fidelity"))
def test_composing_one_source_is_that_source(file: str, case: dict[str, Any]) -> None:
    """Keeps the two functions honest about each other without either being
    defined in terms of the other."""
    window_start = _instant(case["window_start"])
    assert window_start is not None, file
    go_live_at = _instant(case["go_live_at"])
    only = VintageSource(
        read="curtailment-by-reporting-entity",
        vintage_fidelity=vintage_fidelity(window_start, go_live_at),
        go_live_at=go_live_at,
    )
    assert combine_fidelity([only]) == only.vintage_fidelity


@pytest.mark.parametrize(("file", "case"), _cases("combine-fidelity"))
def test_combine_fidelity(file: str, case: dict[str, Any]) -> None:
    sources = [
        VintageSource(
            read=entry["read"],
            vintage_fidelity=entry["vintage_fidelity"],
            go_live_at=_instant(entry["go_live_at"]),
        )
        for entry in case["sources"]
    ]
    assert combine_fidelity(sources) == case["expected_vintage_fidelity"], file
    combined = combine_go_live(sources)
    assert combined == _instant(case["expected_go_live_at"]), file


# --- The views, and the path this service takes to them ---------------------
#
# Ticket 016 moved the contract into SQL and this service onto the views. What
# can be asserted without a database is the part that decides whether the two
# languages are pointing at the same thing, and the part that decides whether
# this service could ever start talking HTTP again.


def test_every_read_resolves_to_a_view_by_the_shared_rule() -> None:
    """The view name is derived from the manifest, not tabulated beside it.

    `apps/api/src/database/canonical-views.ts` declares the same eight names
    under the same rule, and `apps/api/test/contract.test.ts` checks it from the
    other side. A lookup table would be a second place the pairing is written,
    and the failure it invites is the quiet one: a renamed view and a stale entry
    that still parses.
    """
    assert [view_name(read.name) for read in CANONICAL_READS] == [
        "canonical_curtailment_by_reporting_entity",
        "canonical_curtailment_by_plant",
        "canonical_system_context",
        "canonical_system_exchange",
        "canonical_day_ahead_balance",
        "canonical_weather_forecast",
        "canonical_installed_capacity",
        "canonical_conjunto_membership",
    ]


def test_a_name_that_is_not_a_canonical_read_has_no_view() -> None:
    with pytest.raises(KeyError):
        view_name("constrained_off_hour")


def test_a_filter_the_contract_does_not_offer_is_refused() -> None:
    """The column name reaches the SQL text, so the whitelist is the safety.

    It is also the vocabulary boundary: `reason` is not filterable on the plant
    read because no reason exists at plant grain, and asking says so loudly
    rather than returning every row.
    """
    with pytest.raises(KeyError):
        _filters("curtailment-by-plant", {"reason": "CNF"})
    with pytest.raises(KeyError):
        _filters("system-context", {"subsystem; drop table plant": "NE"})
    # And the offered ones render as bind parameters, never as literals.
    clauses, values = _filters("system-context", {"subsystem": "NE"})
    assert clauses == "and subsystem = $1"
    assert values == ["NE"]


def test_filter_parameters_are_renumbered_past_the_window() -> None:
    """`$1` and `$2` are the window; a read's own filters start at `$3`.

    Renumbered descending, so `$2` cannot be rewritten twice on its way to `$4`
    — the bug this test exists for.
    """
    clauses, _ = _filters(
        "curtailment-by-reporting-entity",
        {"technology": "WIND", "reporting_entity_code": "CJU_X"},
    )
    assert _shift(clauses, 2) == "and technology = $3 and reporting_entity_code = $4"


def test_the_service_holds_no_http_client() -> None:
    """The acceptance criterion, checked over the source rather than intended.

    Ticket 016's whole point is that the modelling side reads Postgres directly.
    An HTTP dependency reappearing here would restore the `ml → api → ml` cycle
    the ticket removed, and it would do it quietly, one import at a time.
    """
    package = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"
    sources = "\n".join(path.read_text() for path in sorted(package.glob("*.py")))
    for client in ("import httpx", "import requests", "import aiohttp", "urlencode"):
        assert client not in sources, client


def test_no_module_here_names_a_base_table() -> None:
    """The views are the surface; the tables underneath them are not ours.

    `canonical_read_go_live` is a view and is allowed; the tables it aggregates
    over are named only inside it, on the platform's side of the boundary.
    """
    package = Path(__file__).resolve().parents[1] / "src" / "wattsteer_ml"
    sources = "\n".join(path.read_text() for path in sorted(package.glob("*.py")))
    for table in (
        "curtailment_report_hour",
        "plant_detail_hour",
        "subsystem_energy_balance_hour",
        "subsystem_exchange_hour",
        "dessem_balance_half_hour",
        "weather_forecast_hour",
        "generating_unit",
    ):
        assert table not in sources, table
