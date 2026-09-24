"""Per-subsystem ``δ_lo``, as arithmetic — no booster, no database.

`training/conformal.py::conformalise_by_subsystem` is the whole of the change:
the pooled correction is unchanged, and the lower tail is re-ranked once per
subsystem at the pooled fit's own target, declining (and falling back to the
pooled ``δ_lo``) below the same row floor the marginal fit already uses.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from wattsteer_ml.constants import SUBSYSTEM_CODES, SUBSYSTEM_THRESHOLD_MW, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.mixture import MagnitudeQuantiles, compose
from wattsteer_ml.training.conformal import (
    ConformalError,
    ScoredHour,
    SubsystemDeltaLo,
    conformalise,
    conformalise_by_subsystem,
    minimum_calibration_rows,
)

TAU = float(SUBSYSTEM_THRESHOLD_MW)
WINDOW = (date(2026, 1, 1), date(2026, 3, 31))

#: Comfortably above τ and rising with alpha, so every hour states a P10 and
#: the lower tail always has something to rank.
QUANTILES = MagnitudeQuantiles.from_boosters(q02=36.0, q10=40.0, q50=90.0, q90=200.0)


def _hour(
    *,
    subsystem: Subsystem,
    day_offset: int,
    observed_mwh: float,
    occurrence: float = 0.97,
) -> ScoredHour:
    forecast = compose(
        occurrence_probability=occurrence,
        positive_quantiles=QUANTILES,
        positive_mean_mwh=90.0,
        sub_threshold_mean_mwh=1.0,
        threshold_mw=TAU,
    )
    return ScoredHour(
        key=RowKey(
            target_date=WINDOW[0] + timedelta(days=day_offset),
            local_hour=0,
            subsystem=subsystem,
        ),
        forecast=forecast,
        observed_mwh=observed_mwh,
    )


def _many(
    subsystem: Subsystem, count: int, *, observed_mwh: float = 60.0
) -> list[ScoredHour]:
    return [
        _hour(subsystem=subsystem, day_offset=index, observed_mwh=observed_mwh)
        for index in range(count)
    ]


def test_every_subsystem_gets_a_verdict() -> None:
    """No subsystem is silently left to fall back with nothing on the card."""
    hours: list[ScoredHour] = []
    for subsystem in SUBSYSTEM_CODES:
        hours += _many(subsystem, 20)
    result = conformalise_by_subsystem(hours, window=WINDOW)
    assert set(result.per_subsystem) | set(result.declined) == set(SUBSYSTEM_CODES)
    assert not (set(result.per_subsystem) & set(result.declined))


def test_a_thin_subsystem_declines_and_falls_back_to_pooled() -> None:
    """Below the floor: no invented number, and the fallback is the pooled δ_lo."""
    floor = minimum_calibration_rows()
    hours: list[ScoredHour] = []
    for subsystem in SUBSYSTEM_CODES:
        # Three subsystems comfortably above the floor, one (N) well below it.
        rows = 5 if subsystem == "N" else floor + 30
        hours += _many(subsystem, rows)
    result = conformalise_by_subsystem(hours, window=WINDOW)
    assert "N" in result.declined
    assert "N" not in result.per_subsystem
    assert result.delta_lo_for("N") == result.pooled.delta_lo
    assert result.shift_for("N").lower_spread_multiple == result.pooled.delta_lo


def test_a_thick_subsystem_gets_its_own_delta_that_can_differ_from_pooled() -> None:
    """Perturbing one subsystem's labels moves only that subsystem's δ_lo."""
    floor = minimum_calibration_rows()
    baseline: list[ScoredHour] = []
    for subsystem in SUBSYSTEM_CODES:
        baseline += _many(subsystem, floor + 40, observed_mwh=60.0)
    shifted = [
        _hour(
            subsystem="NE",
            day_offset=hour.key.target_date.toordinal(),
            observed_mwh=20.0,
        )
        if hour.key.subsystem == "NE"
        else hour
        for hour in baseline
    ]
    before = conformalise_by_subsystem(baseline, window=WINDOW)
    after = conformalise_by_subsystem(shifted, window=WINDOW)
    assert before.delta_lo_for("NE") != after.delta_lo_for("NE")
    for subsystem in SUBSYSTEM_CODES:
        if subsystem == "NE":
            continue
        assert before.delta_lo_for(subsystem) == after.delta_lo_for(subsystem)


def test_delta_hi_is_never_split_by_subsystem() -> None:
    """The upper tail stays marginal — nothing measured indicts it."""
    floor = minimum_calibration_rows()
    hours: list[ScoredHour] = []
    for subsystem in SUBSYSTEM_CODES:
        hours += _many(subsystem, floor + 40)
    result = conformalise_by_subsystem(hours, window=WINDOW)
    pooled = conformalise(hours, window=WINDOW)
    assert result.pooled.delta_hi == pooled.delta_hi
    for subsystem in SUBSYSTEM_CODES:
        assert result.shift_for(subsystem).upper_mwh == pooled.delta_hi


def test_a_subsystem_missing_from_both_maps_is_refused() -> None:
    floor = minimum_calibration_rows()
    hours: list[ScoredHour] = []
    for subsystem in SUBSYSTEM_CODES:
        hours += _many(subsystem, floor + 10)
    pooled = conformalise(hours, window=WINDOW)
    fit = SubsystemDeltaLo(subsystem="NE", rows=floor, rank=1, delta_lo=-1.0, fitted=True)
    with pytest.raises(ConformalError, match="does not account for every subsystem"):
        from wattsteer_ml.training.conformal import SubsystemCorrections

        SubsystemCorrections(pooled=pooled, per_subsystem={"NE": fit}, declined=())


def test_a_plain_conformal_correction_ignores_the_subsystem_argument() -> None:
    """`shift_for` on a plain `ConformalCorrection` is `shift()` regardless."""
    floor = minimum_calibration_rows()
    hours = _many("NE", floor + 20)
    correction = conformalise(hours, window=WINDOW)
    for subsystem in SUBSYSTEM_CODES:
        shifted = correction.shift_for(subsystem).lower_spread_multiple
        assert shifted == correction.delta_lo
