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
    read_url,
    vintage_fidelity,
)

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


def test_read_url_builds_the_path_from_the_manifest() -> None:
    url = read_url(
        "https://api.example/",
        "curtailment-by-reporting-entity",
        as_of="2026-03-01T00:00:00Z",
    )
    assert url == (
        "https://api.example/v1/canonical/curtailment-by-reporting-entity"
        "?as_of=2026-03-01T00%3A00%3A00Z"
    )


def test_read_url_refuses_a_name_that_is_not_in_the_contract() -> None:
    with pytest.raises(KeyError):
        read_url("https://api.example", "constrained_off_hour")
