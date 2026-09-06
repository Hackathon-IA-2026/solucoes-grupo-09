"""The national day, as a quantile of the four subsystems added draw by draw.

`docs/specs/api-surface.md`, "The national readout, and the band that cannot be
built", is the ticket this module closes. The landing hero used to show
``band(2640, 4180, 6320)`` MWh whose P50 was the componentwise sum of four
subsystem P50s, and **medians do not add**: the median of a sum is the sum of
the medians only if the four subsystems are comonotone, which is exactly the
assumption the rest of this product refuses to make.

What makes the honest figure cheap is that
:mod:`wattsteer_ml.training.ensemble` already built the shared draw index. ``U``
is ninety-six columns — ``(subsystem, local_hour)`` — and
:func:`~wattsteer_ml.training.hurdle.day_grain_rows` mints **one**
:class:`~wattsteer_ml.training.ensemble.DrawPlan` and hands it to every
subsystem of every day, so draw ``k`` is the same calendar day in all four. The
national figure is therefore::

    national path k  =  Σ_s  y*_{s,k,·}          (four realisable days, added)
    national band    =  quantiles over k of that sum

No copula is fitted, no second model is trained and no new parameter is
invented. The dependence between subsystems is whatever the calibration window
actually had, on exactly the same footing as the intra-day dependence the
whole-row draw already accepted.

**Nothing here adds a quantile to anything.** :func:`national_day_grain` reaches
:class:`~wattsteer_ml.training.ensemble.PathEnsemble.paths` — draws — and never
:class:`~wattsteer_ml.mixture.QuantileBand`. The bands come out at the end, from
:func:`~wattsteer_ml.training.ensemble.ensemble_quantile` over the summed draws,
by the same inverse-ECDF convention every other day-grain figure uses. That the
national band is *strictly* narrower than the componentwise sum of the four
subsystem bands is the measurable consequence, and
``tests/test_national_band.py`` measures it: the summed-band day is one on which
all four subsystems simultaneously landed at their own ninetieth percentile,
which is far rarer than one in ten. The one case where the two coincide is
perfect comonotonicity, which is the assumption being refused, and that case is
tested too — as the boundary, not as the rule.

**``SIN`` is not a subsystem.** `docs/domain-model.md` makes it unrepresentable
as one, and this module reads no aggregate row of any kind: it consumes four
:class:`~wattsteer_ml.training.ensemble.DayGrainForecast` objects that already
exist and refuses a day that does not carry all four. A national day is a
derived sum over the four or it is not published.

**Expected MWh is not drawn.** ``E[Y]`` adds exactly, across hours and across
subsystems, with no assumption whatever about dependence — so the national
expectation is the sum of the four subsystem expectations and not the mean of
the ensemble, which would agree only to Monte-Carlo error and would make a fact
into an estimate. It is the one national number that was always publishable, and
it stays computed the way it always was.

**Peak power is a peak of the sum, not a sum of peaks.** The national grid's
largest curtailed hour is ``max_t Σ_s y*_{s,k,t}``: the four subsystems' peaks
generally fall in different hours, so ``Σ_s max_t`` is a day that never happened
in draw ``k``. The same argument that forbids adding quantiles forbids adding
maxima.

**Day occurrence is counted over subsystem-hours, against the same τ.** A
national day "has curtailment" when *some* subsystem had an hour above ``τ`` in
that draw. It is not ``1 − Π_s (1 − p_s)`` — that assumes the four subsystems
are independent and overstates national risk exactly as the hourly version
overstated the day's — and it is not a comparison of the summed national hour
against ``τ``, which would be four subsystems' worth of MWh measured against one
subsystem's threshold.

**What forecaster ticket 21 changed here.** Under
``conformal_v1_partial_upper`` the composed P90 of an hour received only part of
``δ_hi``, so every subsystem day total inherited an under-corrected upper tail
and the national P90 — a sum of four of them drawn together — was low by roughly
the sum of the four shortfalls. It **accumulated in level rather than
cancelling**, because each subsystem's ceiling was too low in the same direction
on the same draw, and it did so at day grain, where ticket 07 recorded that the
correction bites twice. That is exactly why the ticket was decided as a fix: an
error that compounds toward a *narrower* national band under-states the worst
case an operator sizes storage against.

The correction now reaches each hour's composed P90 in full, so nothing is
inherited here to accumulate. What the national P90 still inherits is the
mixture's structural zero: an hour with ``p ≤ 0.10`` contributes a zero to every
draw's ceiling, which is the model denying curtailment rather than a correction
falling short. :class:`NationalDayGrain` carries that onto the row.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from wattsteer_ml.canonical import ForecastProducer
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation import HOURS_PER_DAY
from wattsteer_ml.mixture import SERVED_QUANTILES, QuantileBand
from wattsteer_ml.training.bundle import HurdleBundle
from wattsteer_ml.training.ensemble import (
    ENSEMBLE_DRAWS,
    ENSEMBLE_SEED,
    DayGrainForecast,
    DrawPlan,
    ensemble_quantile,
)
from wattsteer_ml.training.hurdle import HourForecast, day_grain_rows, forecast_rows

#: Who produces a WattSteer curtailment forecast. `docs/domain-model.md`: the
#: producer of a *weather* run is ``open_meteo`` and that is a second fact on a
#: second field; the producer of this figure is WattSteer and its run label is
#: the artifact version.
NATIONAL_PRODUCER: ForecastProducer = "wattsteer"

#: What :meth:`NationalDayGrain.as_row` stamps as its ``derivation``. A stored
#: string and not a comment, for the same reason
#: :meth:`~wattsteer_ml.training.ensemble.DayGrainForecast.as_row` stamps
#: ``path_ensemble``: a reader of the database has to be able to tell a national
#: figure drawn from the shared index from one an earlier code path summed.
NATIONAL_DERIVATION = "joint_path_ensemble"


class NationalError(ValueError):
    """A national figure that cannot be built from these subsystems."""


@dataclass(frozen=True)
class ForecastOrigin:
    """Who produced a figure, and which run of theirs it was.

    The model's half of `docs/domain-model.md`'s ``ForecastOrigin``.
    ``published_at``, ``age_hours``, ``origin_kind`` and ``gate_profile`` are
    properties of the *serving* of a forecast and are stamped by the gateway
    that serves it; what the artifact knows about itself is that WattSteer made
    it and which artifact it is.
    """

    producer: ForecastProducer
    #: The artifact version — ``run_label`` for a ``wattsteer`` producer.
    run_label: str

    def __post_init__(self) -> None:
        if self.producer != NATIONAL_PRODUCER:
            raise NationalError(
                f"{self.producer!r} does not produce a WattSteer curtailment "
                f"forecast; the national figure's producer is {NATIONAL_PRODUCER!r} "
                "and its run label is the artifact id"
            )
        if not self.run_label.strip():
            raise NationalError(
                "a national figure with no run label names no artifact, and an "
                "unnamed forecast cannot be replayed"
            )

    @classmethod
    def of_artifact(cls, artifact_id: str) -> ForecastOrigin:
        """The origin of a figure drawn from the bundle ``artifact_id`` names."""
        return cls(producer=NATIONAL_PRODUCER, run_label=artifact_id)


@dataclass(frozen=True)
class NationalDayGrain:
    """One national day: two bands, a probability, an expectation, an origin.

    The national counterpart of
    :class:`~wattsteer_ml.training.ensemble.DayGrainForecast`, and a distinct
    type rather than a fifth row of that one, because ``SIN`` is not a
    ``Subsystem`` and a national figure that could be mistaken for a subsystem's
    is exactly the double count `docs/domain-model.md` makes unrepresentable.
    """

    target_date: date
    threshold_mw: float
    origin: ForecastOrigin
    #: Quantiles of ``Σ_s`` day total, over the draws. Never a sum of bands.
    day_total: QuantileBand
    #: Quantiles of ``max_t Σ_s`` hourly MWh, in MW. Never a sum of peaks.
    peak_power: QuantileBand
    #: The share of draws in which some subsystem had some hour above ``τ``.
    day_occurrence_probability: float
    #: ``Σ_s E[Y_s]`` — exact, and the one national number that always was.
    expected_mwh: float
    #: The four subsystems this was summed over, in canonical order. There are
    #: always four; the field exists so the row says so.
    subsystems: tuple[Subsystem, ...]
    #: The plan all four drew under — the reason draw ``k`` means one calendar
    #: day nationally, carried so a served band can be redrawn.
    plan: DrawPlan

    def __post_init__(self) -> None:
        if not 0.0 <= self.day_occurrence_probability <= 1.0:
            raise NationalError(
                f"{self.day_occurrence_probability!r} is not a probability"
            )
        if self.subsystems != tuple(SUBSYSTEM_CODES):
            raise NationalError(
                f"a national day is a derived sum over {SUBSYSTEM_CODES!r} and "
                f"this one names {self.subsystems!r}"
            )
        if not math.isfinite(self.expected_mwh) or self.expected_mwh < 0.0:
            raise NationalError(f"{self.expected_mwh!r} is not an expected MWh")

    def as_row(self) -> dict[str, Any]:
        """The persistence shape — one row per day, at the ``national`` grain.

        `docs/specs/replay.md` forbids reconstructing a day total by summing an
        hourly band; ``derivation`` is what lets a reader of the database check
        that this one was not, and ``subsystems`` is what lets them check that
        nothing read an ONS aggregate row to get it.
        """
        return {
            "target_date": self.target_date.isoformat(),
            "grain": "national",
            "threshold_mw": self.threshold_mw,
            "forecast_origin": {
                "producer": self.origin.producer,
                "run_label": self.origin.run_label,
            },
            "day_total": {
                "p10": self.day_total.p10,
                "p50": self.day_total.p50,
                "p90": self.day_total.p90,
            },
            "peak_power": {
                "p10": self.peak_power.p10,
                "p50": self.peak_power.p50,
                "p90": self.peak_power.p90,
            },
            "day_occurrence_probability": self.day_occurrence_probability,
            "expected_mwh": self.expected_mwh,
            "subsystems": list(self.subsystems),
            "ensemble_draws": self.plan.draws,
            "ensemble_seed": self.plan.seed,
            "ensemble_calibration_days": self.plan.rows,
            "derivation": NATIONAL_DERIVATION,
            "derivation_note": (
                "quantiles over the 500 draws of the four subsystems' paths added "
                "draw by draw under one shared row index of U. Never a sum of "
                "quantiles, and never an ONS national aggregate row"
            ),
            "upper_tail_note": (
                "each subsystem's day total inherits its hours' composed P90s, "
                "which receive delta_hi in full wherever they are positive "
                "(correction regime conformal_v2_full_upper). What they do not "
                "cover is an hour with p <= 0.10, whose P90 is the mixture's "
                "point mass at zero; those contribute a zero to every draw's "
                "ceiling here, and that is the model denying curtailment rather "
                "than a correction falling short"
            ),
        }


def subsystem_day_expectations(
    hours: Iterable[HourForecast],
) -> dict[tuple[date, Subsystem], float]:
    """``E[Y]`` per ``(day, subsystem)``, summed over the day's hours.

    Expectations add exactly — that is the whole reason this is arithmetic on
    composed hours rather than a mean over draws — so the day's expectation is
    the sum of its twenty-four hourly ones and the national one is the sum of
    four of these. A day with fewer than twenty-four composed hours is absent
    rather than partial, matching
    :func:`~wattsteer_ml.training.hurdle.day_grain_rows`, so the two sides of a
    national row are always over the same hours.
    """
    counted: dict[tuple[date, Subsystem], list[float]] = {}
    for hour in hours:
        key = (hour.key.target_date, hour.key.subsystem)
        counted.setdefault(key, []).append(hour.forecast.expected_mwh)
    return {
        key: math.fsum(values)
        for key, values in counted.items()
        if len(values) == HOURS_PER_DAY
    }


def national_day_grain(
    forecasts: Iterable[DayGrainForecast],
    *,
    expectations: Mapping[tuple[date, Subsystem], float],
    origin: ForecastOrigin,
) -> tuple[NationalDayGrain, ...]:
    """Every complete day's national figures, from the draws it already has.

    Args:
        forecasts: the subsystem day-grain forecasts, as
            :func:`~wattsteer_ml.training.hurdle.day_grain_rows` returned them —
            which is to say already sharing one
            :class:`~wattsteer_ml.training.ensemble.DrawPlan`.
        expectations: ``E[Y]`` per ``(day, subsystem)``, from
            :func:`subsystem_day_expectations`.
        origin: whose artifact these draws came out of.

    A day is national only if all four subsystems are present for it, under one
    plan, at one threshold. A day carrying three subsystems is dropped, for the
    same reason ticket 07 drops a calibration day missing a subsystem-hour: a
    national total over three subsystems is a different quantity wearing the
    same name, and the four-subsystem rule is why nothing here needs a copula.
    """
    grouped: dict[date, dict[Subsystem, DayGrainForecast]] = {}
    for forecast in forecasts:
        day = grouped.setdefault(forecast.target_date, {})
        if forecast.subsystem in day:
            raise NationalError(
                f"{forecast.target_date.isoformat()} carries "
                f"{forecast.subsystem} twice; a subsystem counted twice is a "
                "double count of the grid"
            )
        day[forecast.subsystem] = forecast
    rows: list[NationalDayGrain] = []
    for target_date in sorted(grouped):
        by_subsystem = grouped[target_date]
        if set(by_subsystem) != set(SUBSYSTEM_CODES):
            continue
        rows.append(
            _national_day(
                target_date,
                tuple(by_subsystem[code] for code in SUBSYSTEM_CODES),
                expectations=expectations,
                origin=origin,
            )
        )
    return tuple(rows)


def national_rows(
    bundle: HurdleBundle,
    rows: Sequence[Mapping[str, Any]],
    *,
    origin: ForecastOrigin,
    seed: int = ENSEMBLE_SEED,
    draws: int = ENSEMBLE_DRAWS,
) -> tuple[NationalDayGrain, ...]:
    """The national days of a set of feature rows, end to end.

    Both halves come from the two published routes and from no third one:
    :func:`~wattsteer_ml.training.hurdle.day_grain_rows` for the draws and
    :func:`~wattsteer_ml.training.hurdle.forecast_rows` for the expectations, so
    a national figure cannot disagree with the subsystem figures beside it about
    what was forecast. Both are deterministic functions of ``rows`` and the
    bundle, which is what makes calling them separately safe rather than a
    second opinion.
    """
    return national_day_grain(
        day_grain_rows(bundle, rows, seed=seed, draws=draws),
        expectations=subsystem_day_expectations(forecast_rows(bundle, rows)),
        origin=origin,
    )


def _national_day(
    target_date: date,
    forecasts: tuple[DayGrainForecast, ...],
    *,
    expectations: Mapping[tuple[date, Subsystem], float],
    origin: ForecastOrigin,
) -> NationalDayGrain:
    """One day's national figures, over the four subsystems' aligned draws."""
    plans = {forecast.ensemble.plan for forecast in forecasts}
    if len(plans) != 1:
        raise NationalError(
            f"{target_date.isoformat()} was drawn under {len(plans)} plans; draw "
            "k is only one calendar day nationally if the four subsystems share "
            "one plan, and four plans are four different days added together"
        )
    plan = plans.pop()
    thresholds = {forecast.threshold_mw for forecast in forecasts}
    if len(thresholds) != 1:
        raise NationalError(
            f"{target_date.isoformat()} carries {len(thresholds)} thresholds; a "
            "magnitude and the threshold that produced it travel together"
        )
    threshold_mw = thresholds.pop()
    missing = [
        forecast.subsystem
        for forecast in forecasts
        if (target_date, forecast.subsystem) not in expectations
    ]
    if missing:
        raise NationalError(
            f"{target_date.isoformat()} has no expectation for {missing!r}; "
            "E[Y] adds exactly and is therefore never estimated from the draws"
        )
    paths = tuple(forecast.ensemble.paths for forecast in forecasts)
    national = tuple(
        tuple(
            math.fsum(path[draw][hour] for path in paths) for hour in range(HOURS_PER_DAY)
        )
        for draw in range(plan.draws)
    )
    curtailed = sum(
        1
        for draw in range(plan.draws)
        if any(hour > threshold_mw for path in paths for hour in path[draw])
    )
    return NationalDayGrain(
        target_date=target_date,
        threshold_mw=threshold_mw,
        origin=origin,
        day_total=_band([math.fsum(path) for path in national]),
        peak_power=_band([max(path) for path in national]),
        day_occurrence_probability=curtailed / plan.draws,
        expected_mwh=math.fsum(
            expectations[(target_date, forecast.subsystem)] for forecast in forecasts
        ),
        subsystems=tuple(forecast.subsystem for forecast in forecasts),
        plan=plan,
    )


def _band(values: Sequence[float]) -> QuantileBand:
    """The three served quantiles of one national statistic.

    :func:`~wattsteer_ml.training.ensemble.ensemble_quantile` and not a second
    convention: every published day-grain number is a value some draw actually
    took, and a national one is no different.
    """
    return QuantileBand.sorted_from(
        [ensemble_quantile(values, q) for q in SERVED_QUANTILES]
    )
