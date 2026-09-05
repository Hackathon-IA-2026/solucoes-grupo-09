"""The execution rule against its golden vectors.

``packages/core/fixtures/execution-rule/`` was a **parity** set: a TypeScript
port of the rule lived in ``apps/web`` and these files were what proved the two
identical. ``docs/specs/api-surface.md`` decision 6 deleted the port — a
proved-identical copy is still a copy, and that one was known wrong — so what
these vectors pin now is **regression against the one implementation**, which is
the module this file imports. ``test/one-execution-rule.test.ts`` is the other
half of the edge: it walks the repository, in both languages, and fails if a
second implementation appears.

Every field is recomputed here on every run and asserted against the file, so a
change to the rule that was not meant to move these numbers fails here. The
reader globs the directory and refuses an empty one, so adding a vector is
sufficient.

See ``packages/core/fixtures/execution-rule/README.md``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wattsteer_ml.optimizer import (
    Battery,
    BatteryDispatch,
    Schedule,
    ScoredRealisation,
    simulate,
)

# apps/ml/tests/… → repo root → packages/core/fixtures/execution-rule
FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "fixtures"
    / "execution-rule"
)

#: Two IEEE-754 doubles doing the same arithmetic in a different association
#: order. Eleven significant digits against figures in the hundreds of MWh; a
#: real divergence in the rule is orders of magnitude larger than this.
TOLERANCE_MWH = 1e-9


def _cases() -> list[tuple[str, dict[str, Any]]]:
    files = sorted(FIXTURES.glob("*.json"))
    assert files, f"no vectors in {FIXTURES} — a passing run would mean nothing"
    return [(path.stem, json.loads(path.read_text())) for path in files]


CASES = _cases()


def test_no_vector_file_is_skipped() -> None:
    """The listing above is flat; this compares it against a recursive walk.

    A vector filed under a subdirectory would be read by nothing, and the
    reader's ``assert files`` only sees an empty directory — not a file nobody
    reads. Adding a vector anywhere under here is therefore sufficient, or it
    fails loudly.
    """
    flat = {path.name for path in FIXTURES.glob("*.json")}
    everywhere = {path.name for path in FIXTURES.rglob("*.json")}
    assert everywhere == flat


def run(vector: dict[str, Any]) -> ScoredRealisation:
    """Execute one vector through the one implementation."""
    spec = vector["battery"]
    battery = Battery.from_round_trip(
        key="battery",
        label="Battery",
        max_power_mw=spec["maxPowerMw"],
        energy_capacity_mwh=spec["energyCapacityMwh"],
        round_trip_efficiency=spec["roundTripEfficiency"],
        initial_state_of_charge=spec["initialStateOfCharge"],
    )
    plan = vector["plan"]
    hours = len(vector["realisationMwh"])
    schedule = Schedule(
        assets=(battery,),
        dispatch=(
            BatteryDispatch(
                key="battery",
                label="Battery",
                charge_mw=tuple(plan["batteryChargeMw"]),
                discharge_mw=tuple(plan["batteryDischargeMw"]),
                # Never read: the trajectory is recomputed from the executed
                # dispatch, which is the correction this ticket exists for.
                state_of_charge_mwh=(0.0,) * hours,
            ),
        ),
        load_shift_up_mw=tuple(plan["loadShiftUpMw"]),
        load_shift_down_mw=tuple(plan["loadShiftDownMw"]),
    )
    return simulate(
        schedule, vector["realisationMwh"], threshold_mw=vector["thresholdMw"]
    )


@pytest.mark.parametrize(("name", "vector"), CASES, ids=[case[0] for case in CASES])
def test_the_scalars_match_the_vector(name: str, vector: dict[str, Any]) -> None:
    scored = run(vector)
    expected = vector["expected"]

    assert scored.baseline_mwh == pytest.approx(
        expected["baselineCurtailmentMwh"], abs=TOLERANCE_MWH
    )
    assert scored.recovered_mwh == pytest.approx(
        expected["avoidedEnergyMwh"], abs=TOLERANCE_MWH
    )
    assert scored.remaining_mwh == pytest.approx(
        expected["optimizedCurtailmentMwh"], abs=TOLERANCE_MWH
    )
    assert scored.stored_at_horizon_end_mwh == pytest.approx(
        expected["storedAtHorizonEndMwh"], abs=TOLERANCE_MWH
    )
    assert scored.round_trip_loss_mwh == pytest.approx(
        expected["roundTripLossMwh"], abs=TOLERANCE_MWH
    )

    if expected["avoidability"] is None:
        # `null`, never `0`. The distinction is the whole point of the field.
        assert scored.avoidability is None
    else:
        assert scored.avoidability is not None
        assert scored.avoidability == pytest.approx(
            expected["avoidability"], abs=TOLERANCE_MWH
        )


@pytest.mark.parametrize(("name", "vector"), CASES, ids=[case[0] for case in CASES])
def test_every_hour_matches_the_vector(name: str, vector: dict[str, Any]) -> None:
    """Hour by hour, not just the totals.

    Two rules can reach the same daily figure by different trajectories — the
    prototype's bug did exactly that, reporting the right absorption alongside
    the wrong state of charge — so the trajectory is compared too.
    """
    scored = run(vector)
    expected = vector["expected"]["dispatch"]
    assert len(scored.hours) == len(expected)

    for hour, want in zip(scored.hours, expected, strict=True):
        assert hour.hour_local == want["hourLocal"]
        assert hour.battery_charge_mw == pytest.approx(
            want["batteryChargeMw"], abs=TOLERANCE_MWH
        )
        assert hour.battery_discharge_mw == pytest.approx(
            want["batteryDischargeMw"], abs=TOLERANCE_MWH
        )
        assert hour.state_of_charge_mwh == pytest.approx(
            want["stateOfChargeMwh"], abs=TOLERANCE_MWH
        )
        assert hour.absorbed_mwh == pytest.approx(want["absorbedMwh"], abs=TOLERANCE_MWH)
