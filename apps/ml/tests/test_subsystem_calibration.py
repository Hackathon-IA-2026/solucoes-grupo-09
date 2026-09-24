"""Per-subsystem occurrence calibration, as arithmetic — no booster, no database.

`training/calibration.py::calibrate_by_subsystem` is the whole of the change:
the pooled :class:`~wattsteer_ml.training.calibration.Calibration` is fitted
exactly as :func:`~wattsteer_ml.training.calibration.calibrate` already fits
it, and the occurrence map is then refitted once per subsystem on that
subsystem's own slice of the calibration window's rows, declining (and
falling back to the pooled map) below either of the two floors —
:data:`~wattsteer_ml.training.calibration.MINIMUM_SUBSYSTEM_CALIBRATION_ROWS`
and :data:`~wattsteer_ml.training.calibration.\
MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS`.

This file mirrors `test_mondrian_delta.py`'s shape for the conformal
correction's own per-subsystem split, one stage earlier in the pipeline.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from out_of_fold_fixtures import pool as out_of_fold_pool
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import RowKey
from wattsteer_ml.training.calibration import (
    MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS,
    MINIMUM_SUBSYSTEM_CALIBRATION_ROWS,
    CalibrationError,
    IsotonicCalibrator,
    SubsystemCalibration,
    SubsystemIsotonic,
    calibrate,
    calibrate_by_subsystem,
)

#: Well outside every fold `out_of_fold_fixtures.SEGMENTS` covers (2024–2025),
#: so nothing the pooled fit's reliability curve reads is dropped as "inside
#: the calibration window" by `outside_calibration_window` — these tests are
#: about the occurrence map's split, not about that exclusion.
WINDOW = (date(2026, 1, 1), date(2026, 3, 31))


def _pairs(
    total: int, positive: int, *, low: float = 0.1, high: float = 0.9
) -> list[tuple[float, bool]]:
    """``total`` rows, ``positive`` of them curtailed, as a clean two-point curve.

    Every curtailed row scores ``high`` and every quiet one scores ``low``, so
    the isotonic fit is a trivial two-knot step and the tests can compare
    curves by their knots rather than by re-deriving pool-adjacent-violators
    arithmetic in the test file.
    """
    if positive > total:
        raise ValueError(f"{positive} positive rows out of {total} total")
    return [(high, True)] * positive + [(low, False)] * (total - positive)


def _rows(
    pairs: dict[Subsystem, list[tuple[float, bool]]],
) -> tuple[list[float], list[bool], list[RowKey]]:
    """Flatten ``{subsystem: [(raw, observed), ...]}`` into calibrate_by_subsystem's
    three parallel sequences, with real, distinct keys.
    """
    raw: list[float] = []
    observed: list[bool] = []
    keys: list[RowKey] = []
    for subsystem, subsystem_pairs in pairs.items():
        day = date(2025, 1, 1)
        for index, (value, label) in enumerate(subsystem_pairs):
            raw.append(value)
            observed.append(label)
            keys.append(
                RowKey(
                    target_date=day + timedelta(days=index),
                    local_hour=index % 24,
                    subsystem=subsystem,
                )
            )
    return raw, observed, keys


#: Comfortably above both floors for every subsystem — the "everyone fits"
#: baseline the perturbation and coverage tests build on.
_ABOVE_FLOOR_TOTAL = MINIMUM_SUBSYSTEM_CALIBRATION_ROWS + 100
_ABOVE_FLOOR_POSITIVE = MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS + 20


def _above_floor_pairs() -> list[tuple[float, bool]]:
    return _pairs(_ABOVE_FLOOR_TOTAL, _ABOVE_FLOOR_POSITIVE)


def _with_some_quiet_rows_relabelled(
    pairs: list[tuple[float, bool]], count: int
) -> list[tuple[float, bool]]:
    """``count`` of the quiet (``low``-raw, ``observed=False``) rows turned
    curtailed, **at the same raw score**.

    Changing which rows are curtailed without changing any raw score is what
    actually moves an isotonic curve here: :func:`_pairs` puts every curtailed
    row at ``high`` and every quiet one at ``low``, so a perturbation that only
    changes the split between the two counts leaves both blocks internally
    homogeneous and the curve identical. This flips labels *within* the quiet
    block instead, which is what a real fold's residuals moving would do.
    """
    flipped = 0
    result: list[tuple[float, bool]] = []
    for value, observed in pairs:
        if not observed and flipped < count:
            result.append((value, True))
            flipped += 1
        else:
            result.append((value, observed))
    if flipped != count:
        raise ValueError(f"only {flipped} quiet rows to flip, asked for {count}")
    return result


def _split(
    pairs: dict[Subsystem, list[tuple[float, bool]]],
) -> SubsystemCalibration:
    raw, observed, keys = _rows(pairs)
    return calibrate_by_subsystem(
        raw,
        observed,
        keys,
        pool=out_of_fold_pool(),
        calibration_window=WINDOW,
    )


# --- Every subsystem gets a verdict -------------------------------------------


def test_every_subsystem_lands_in_exactly_one_of_fitted_or_declined() -> None:
    """No subsystem is silently left to fall back with nothing on the card."""
    result = _split({subsystem: _above_floor_pairs() for subsystem in SUBSYSTEM_CODES})
    assert set(result.per_subsystem) | set(result.declined) == set(SUBSYSTEM_CODES)
    assert not (set(result.per_subsystem) & set(result.declined))
    assert set(result.per_subsystem) == set(SUBSYSTEM_CODES), (
        "every subsystem is above both floors in this fixture; none should decline"
    )


# --- A thin subsystem declines on either floor, and falls back ---------------


def test_a_subsystem_below_the_total_row_floor_declines_and_falls_back() -> None:
    """Below `MINIMUM_SUBSYSTEM_CALIBRATION_ROWS`: no invented curve."""
    pairs = {subsystem: _above_floor_pairs() for subsystem in SUBSYSTEM_CODES}
    pairs["N"] = _pairs(MINIMUM_SUBSYSTEM_CALIBRATION_ROWS - 1, 20)
    result = _split(pairs)
    assert "N" in result.declined
    assert "N" not in result.per_subsystem
    assert result.calibrate_for("N") is result.pooled.isotonic


def test_a_subsystem_below_the_positive_row_floor_declines_and_falls_back() -> None:
    """Below `MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS`, even with rows to spare.

    A subsystem can clear the total-row floor by a wide margin and still have
    too few *curtailed* rows to trust its own curve — that is the whole
    argument for having two floors rather than one, and this is the case where
    only the second one binds.
    """
    pairs = {subsystem: _above_floor_pairs() for subsystem in SUBSYSTEM_CODES}
    pairs["S"] = _pairs(
        MINIMUM_SUBSYSTEM_CALIBRATION_ROWS + 200,
        MINIMUM_SUBSYSTEM_CALIBRATION_POSITIVE_ROWS - 1,
    )
    result = _split(pairs)
    assert "S" in result.declined
    assert "S" not in result.per_subsystem
    assert result.calibrate_for("S") is result.pooled.isotonic


# --- A thick subsystem gets its own curve, and only its own moves ------------


def test_perturbing_one_subsystems_labels_moves_only_that_subsystems_curve() -> None:
    """The property `conformalise_by_subsystem` already has for ``δ_lo``."""
    baseline = {subsystem: _above_floor_pairs() for subsystem in SUBSYSTEM_CODES}
    shifted = dict(baseline)
    # Relabel forty of NE's quiet rows as curtailed, at the same raw score:
    # its own curve must move and nobody else's may.
    shifted["NE"] = _with_some_quiet_rows_relabelled(baseline["NE"], 40)

    before = _split(baseline)
    after = _split(shifted)

    ne_before = before.per_subsystem["NE"].isotonic
    ne_after = after.per_subsystem["NE"].isotonic
    assert ne_before != ne_after

    for subsystem in SUBSYSTEM_CODES:
        if subsystem == "NE":
            continue
        assert (
            before.per_subsystem[subsystem].isotonic
            == after.per_subsystem[subsystem].isotonic
        ), f"{subsystem}'s own curve moved when only NE's labels changed"


def test_a_fitted_subsystems_curve_can_differ_from_the_pooled_map() -> None:
    """The whole point: a subsystem's own curve is not required to agree.

    Every subsystem in this fixture shares the same raw scores and observed
    rate, so the pooled and per-subsystem curves agree here by construction —
    what this test asserts is the *narrower* claim that ``calibrate_for``
    genuinely reads the per-subsystem entry rather than silently reading the
    pooled one for a subsystem that is present in ``per_subsystem``.
    """
    result = _split({subsystem: _above_floor_pairs() for subsystem in SUBSYSTEM_CODES})
    for subsystem in SUBSYSTEM_CODES:
        assert result.calibrate_for(subsystem) is result.per_subsystem[subsystem].isotonic
        assert result.calibrate_for(subsystem) is not result.pooled.isotonic


# --- Structural invariants ----------------------------------------------------


def test_the_fit_arguments_must_be_one_set_of_rows() -> None:
    with pytest.raises(CalibrationError, match="not one set of rows"):
        calibrate_by_subsystem(
            [0.5, 0.6],
            [True],
            [RowKey(target_date=date(2025, 1, 1), local_hour=0, subsystem="N")],
            pool=out_of_fold_pool(),
            calibration_window=WINDOW,
        )


def test_a_subsystem_missing_from_both_maps_is_refused() -> None:
    raw, observed, _keys = _rows({"NE": _above_floor_pairs()})
    pooled = calibrate(
        raw=raw, observed=observed, pool=out_of_fold_pool(), calibration_window=WINDOW
    )
    fit = SubsystemIsotonic(
        subsystem="NE",
        rows=_ABOVE_FLOOR_TOTAL,
        positive_rows=_ABOVE_FLOOR_POSITIVE,
        isotonic=IsotonicCalibrator.fit(raw, observed),
        fitted=True,
    )
    with pytest.raises(CalibrationError, match="does not account for every subsystem"):
        SubsystemCalibration(pooled=pooled, per_subsystem={"NE": fit}, declined=())


def test_a_subsystem_cannot_be_both_fitted_and_declined() -> None:
    raw, observed, _keys = _rows({"NE": _above_floor_pairs()})
    pooled = calibrate(
        raw=raw, observed=observed, pool=out_of_fold_pool(), calibration_window=WINDOW
    )
    fit = SubsystemIsotonic(
        subsystem="NE",
        rows=_ABOVE_FLOOR_TOTAL,
        positive_rows=_ABOVE_FLOOR_POSITIVE,
        isotonic=IsotonicCalibrator.fit(raw, observed),
        fitted=True,
    )
    declined = tuple(s for s in SUBSYSTEM_CODES if s != "NE")
    with pytest.raises(CalibrationError, match="both fitted and declined"):
        SubsystemCalibration(
            pooled=pooled,
            per_subsystem={"NE": fit},
            declined=("NE", *declined),
        )


def test_a_fitted_subsystem_isotonic_must_carry_a_map() -> None:
    with pytest.raises(CalibrationError, match="no isotonic map"):
        SubsystemIsotonic(
            subsystem="N", rows=400, positive_rows=40, isotonic=None, fitted=True
        )


def test_a_declined_subsystem_isotonic_must_not_carry_a_map() -> None:
    raw, observed, _keys = _rows({"N": _above_floor_pairs()})
    with pytest.raises(CalibrationError, match="declined below the floor"):
        SubsystemIsotonic(
            subsystem="N",
            rows=10,
            positive_rows=2,
            isotonic=IsotonicCalibrator.fit(raw, observed),
            fitted=False,
        )


def test_positive_rows_cannot_exceed_total_rows() -> None:
    with pytest.raises(CalibrationError, match="a subset of the whole"):
        SubsystemIsotonic(
            subsystem="N", rows=10, positive_rows=11, isotonic=None, fitted=False
        )
