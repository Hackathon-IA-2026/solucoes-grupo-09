"""What a replay actually costs — measured, because the spec never prices one.

`docs/specs/replay.md` says the MILP is 3.15 ms and moves on. A replay is not
one MILP. It is **two** — the plan at the gate and the fenced perfect-foresight
bound — plus **five** simulator passes: P10, P50, P90, the observed day, and the
bound's own scoring. The endpoint inherits `/v1/optimize`'s rate limit, which
was sized for one solve, and replay 07's nightly featured-days job needs *every*
replayable day scored. Both of those are decisions taken against a number
nobody had measured.

So this file measures it, against the **published `REFERENCE_FLEET`** — the one
constant floor coverage, the featured-days list and the forecaster's
`Δ recovered_floor_mwh` are all computed against, so a cost measured here is a
cost the nightly job will actually pay.

**The assertion is a ceiling and not an equality.** A wall-clock budget on
shared CI hardware is a flaky test if it is tight, and a useless one if it is
absent: the failure it exists to catch is a formulation change that makes a
replay an order of magnitude dearer than the solve whose budget it inherits.
The measured figure is printed so a reader gets the number rather than the
bound.
"""

from __future__ import annotations

import os
import time
from datetime import UTC, date, datetime
from typing import Any

import pytest

from wattsteer_ml.constants import REFERENCE_FLEET
from wattsteer_ml.evaluation import FOLD_CALENDAR_RULES
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.optimizer import build_plan, score_band, simulate
from wattsteer_ml.publication import BACKFILLED_HOLDOUT_ORIGIN_KIND, PRODUCER
from wattsteer_ml.replay.calendar import HOURS_PER_DAY, DayEvidence, resolve_day
from wattsteer_ml.replay.cards import ArtifactWindows
from wattsteer_ml.replay.result import replay_result
from wattsteer_ml.replay.scoring import (
    ForecastHour,
    ObservedDay,
    PinnedForecast,
    PinnedOrigin,
    score_replay,
)

SUBSYSTEM = "NE"
THRESHOLD_MW = 5.0
LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)
HELD_OUT_DAY = date(2025, 11, 12)
GATE = datetime(2025, 11, 11, 22, 0, tzinfo=UTC)

WINDOWS = ArtifactWindows(
    artifact_id="2025-10-01T03:10:00Z",
    fold_id="F3",
    lane=LANE.directory_name,
    train_start=date(2024, 4, 1),
    train_end=date(2025, 9, 30),
    calibration_start=date(2025, 7, 3),
    calibration_end=date(2025, 9, 30),
)

#: IDEA.md §27's reference profile — a real day's shape rather than a toy's, so
#: the MILP has the same number of binding hours it will have in production.
P50: tuple[float, ...] = (
    *(0.0,) * 10,
    20.0,
    70.0,
    110.0,
    90.0,
    30.0,
    10.0,
    *(0.0,) * 8,
)
P10: tuple[float, ...] = tuple(value * 0.4 for value in P50)
P90: tuple[float, ...] = tuple(value * 1.5 for value in P50)
#: The day that happened: over-forecast in one place, under in another, so the
#: execution rule clips in some hours and leaves a remainder in others.
OBSERVED: tuple[float, ...] = tuple(
    value * (1.6 if index % 2 else 0.7) for index, value in enumerate(P50)
)

#: The measured budget for one replay, milliseconds. Ten times the spec's
#: single-solve figure, which is deliberately loose: the point of the number is
#: to catch an order-of-magnitude regression on the route whose rate limit was
#: sized for one solve, not to police CI's jitter.
REPLAY_BUDGET_MS = 250.0


#: How many replayable days the nightly featured-days recompute has to score.
#: The window opens at F1's test start and runs to yesterday; the figure the
#: test prints is the one replay 07 has to fit in a night.
def _replayable_days(today: date) -> int:
    return (today - FOLD_CALENDAR_RULES.first_test_start).days


def _reference_scenario() -> dict[str, Any]:
    """The published reference fleet, as a `Scenario`.

    Both assets, because that is what `REFERENCE_FLEET` is: a battery *and* a
    flexible load. A cost measured on the battery alone would understate the
    nightly job, which is the thing this measurement exists to inform.
    """
    battery = REFERENCE_FLEET.battery
    load = REFERENCE_FLEET.shiftable_load
    return {
        "v": 1,
        "subsystem": SUBSYSTEM,
        "target_date": HELD_OUT_DAY.isoformat(),
        "assets": [
            {
                "asset_type": "battery",
                "label": battery.label,
                "subsystem": SUBSYSTEM,
                "max_power_mw": battery.max_power_mw,
                "energy_capacity_mwh": battery.energy_capacity_mwh,
                "round_trip_efficiency": battery.round_trip_efficiency,
                "initial_state_of_charge": battery.initial_state_of_charge,
            },
            {
                "asset_type": "shiftable_load",
                "label": load.label,
                "subsystem": SUBSYSTEM,
                "max_power_mw": load.max_power_mw,
                "max_shift_mw": load.max_shift_mw,
                "shift_window_hours": load.shift_window_hours,
                "daily_energy_mwh": load.daily_energy_mwh,
            },
        ],
        "economic_assumptions": {"brl_per_mwh": 180},
    }


def _pinned() -> PinnedForecast:
    return PinnedForecast(
        subsystem=SUBSYSTEM,
        target_date=HELD_OUT_DAY,
        threshold_mw=THRESHOLD_MW,
        origin=PinnedOrigin(
            producer=PRODUCER,
            run_label=WINDOWS.artifact_id,
            published_at=GATE,
            origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
            gate_profile=LANE.gate_profile,
        ),
        hours=tuple(
            ForecastHour(
                constrained_off_mwh=QuantileBand(p10=low, p50=mid, p90=high),
                expected_mwh=mid,
                occurrence_probability=1.0 if mid > 0 else 0.1,
            )
            for low, mid, high in zip(P10, P50, P90, strict=True)
        ),
        day_total=QuantileBand(p10=sum(P10), p50=sum(P50), p90=sum(P90)),
        peak_power=QuantileBand(p10=max(P10), p50=max(P50), p90=max(P90)),
        day_occurrence_probability=0.9,
    )


def _one_replay() -> None:
    """Exactly what the endpoint does after the read: score, then publish."""
    wire = _reference_scenario()
    day = resolve_day(
        DayEvidence(
            target_date=HELD_OUT_DAY,
            origin_kind=BACKFILLED_HOLDOUT_ORIGIN_KIND,
            artifact_id=WINDOWS.artifact_id,
            observed_hours=HOURS_PER_DAY,
        ),
        subsystem=SUBSYSTEM,
        lane=LANE.directory_name,
        rules=FOLD_CALENDAR_RULES,
        latest=date(2026, 9, 3),
        windows=WINDOWS,
        sources=(),
    )
    scores = score_replay(
        wire,
        day=day,
        windows=WINDOWS,
        forecast=_pinned(),
        observed=ObservedDay(
            subsystem=SUBSYSTEM, target_date=HELD_OUT_DAY, hours=OBSERVED
        ),
    )
    replay_result(wire, "sha256:" + "0" * 64, scores)


def test_one_replay_is_two_solves_and_five_simulator_passes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The shape of the cost, asserted structurally before it is measured.

    A count rather than a comment: if a future change adds a third solve, this
    is where it is noticed, and the budget below stops meaning what it says.

    ``score_band`` is counted as the three passes it *is* rather than as one
    call, because the number this file exists to publish is the number of times
    the simulator runs, and a caller that counted the wrapper would understate
    the nightly job by a factor of two.
    """
    counted = {"solves": 0, "passes": 0}
    real_build = build_plan
    real_simulate = simulate
    real_band = score_band

    def counted_build(*args: Any, **kwargs: Any) -> Any:
        counted["solves"] += 1
        return real_build(*args, **kwargs)

    def counted_simulate(*args: Any, **kwargs: Any) -> Any:
        counted["passes"] += 1
        return real_simulate(*args, **kwargs)

    def counted_band(*args: Any, **kwargs: Any) -> Any:
        counted["passes"] += 3
        return real_band(*args, **kwargs)

    monkeypatch.setattr("wattsteer_ml.replay.scoring.build_plan", counted_build)
    monkeypatch.setattr("wattsteer_ml.replay.scoring.simulate", counted_simulate)
    monkeypatch.setattr("wattsteer_ml.replay.scoring.score_band", counted_band)
    _one_replay()

    assert (counted["solves"], counted["passes"]) == (2, 5), (
        f"a replay is 2 MILP solves and 5 simulator passes; this one was "
        f"{counted['solves']} and {counted['passes']}"
    )


@pytest.mark.skipif(
    os.environ.get("WATTSTEER_SCALE_TESTS") is None,
    reason="wall-clock budget; run with WATTSTEER_SCALE_TESTS=1",
)
def test_a_replay_costs_what_the_rate_limit_assumes() -> None:
    """One replay on the reference fleet, measured — and the nightly job priced.

    The figure is printed rather than only asserted, because the number is the
    deliverable: the rate limit on this route was sized for one solve, and
    replay 07's nightly recompute has to score every replayable day.
    """
    _one_replay()  # warm the solver backend; the first call pays for its import
    samples = []
    for _ in range(5):
        started = time.perf_counter()
        _one_replay()
        samples.append((time.perf_counter() - started) * 1000)
    median = sorted(samples)[len(samples) // 2]
    days = _replayable_days(date.today())
    print(
        f"\none replay (REFERENCE_FLEET, 24 h): {median:.1f} ms median of "
        f"{len(samples)}; min {min(samples):.1f} ms, max {max(samples):.1f} ms.\n"
        f"nightly featured-days recompute over {days} replayable days: "
        f"{median * days / 1000:.0f} s single-threaded."
    )
    assert median < REPLAY_BUDGET_MS, (
        f"a replay took {median:.1f} ms, over the {REPLAY_BUDGET_MS} ms budget; "
        "this route inherits a rate limit sized for one solve"
    )
