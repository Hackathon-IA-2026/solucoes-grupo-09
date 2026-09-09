"""Whether a P50-planned day has any hour to act in. The number ticket 011 is owed.

`docs/specs/forecaster.md`, "What falls out, and what it does to the optimizer":
because ``Q_Y(q) = 0`` for every ``q ≤ 1 − p``, the served P10 is non-zero only
where ``p > 0.90`` and the served P50 only where ``p > 0.50``.
`flex-optimizer.md` rejected planning on P10 on exactly that ground and called it
a falsifiable prediction. **It is not falsifiable — it is arithmetic.** But the
same arithmetic runs one notch weaker against the posture the optimizer *did*
choose, and nobody has written down how often it bites:

    hours_per_day_p_ge_50, hours_per_day_p_ge_90     (mean, p25, p75)
    share_of_hours_with_p50_zero, share_with_p10_zero
    share_of_days_with_no_non_zero_p50_hour

If :attr:`P50Collapse.share_of_days_with_no_non_zero_p50_hour` is large, the
optimizer's chosen posture collapses in the same way it argued P10 would, and
ticket 011 has to reopen. This module produces the evidence; it decides nothing.

**Measured off the band, not off ``p``.** The two share figures count bands whose
quantile is exactly ``0.0``, which is the value
:meth:`~wattsteer_ml.mixture.HurdleMixture.quantile` returns from its
sub-threshold branch and from nowhere else. So they cannot disagree with the
composition about where the breakpoint is, and re-deriving them from ``p`` — the
obvious shortcut — is precisely the second opinion this file must not hold. The
two ``hours_per_day`` figures are counted from ``p`` because that is what their
published names say (``_ge_50`` is ``p ≥ 0.50``); note the one-tick difference
from the strict ``p > 0.50`` that makes a P50 non-zero, which is why the shares
are the figures the optimizer should read and these two are the distribution
behind them.

**A day is a subsystem-day, and an incomplete one is excluded and counted.** A
plan is built for one subsystem over one local day, so that is the unit
"a day with no hour to act in" is about. A ``(day, subsystem)`` with fewer than
twenty-four served hours is dropped from every day-grain figure and reported as
:attr:`P50Collapse.days_excluded_incomplete` — counting it as a collapse would
score the ingest, and counting it as a normal day would divide by a denominator
of a different size. The hour-grain shares are over every served hour regardless,
because an hour is complete on its own.

**What this module deliberately cannot do.** There is no field here for a label
and no argument that takes one. The collapse is a property of the *forecast* —
of the classifier's operating region — and an observed MWh has no part in it. A
version of this measurement that filtered to curtailed hours would answer a
different and much more flattering question.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol

import numpy as np

from wattsteer_ml.caveated import CaveatedFigure
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.matrix import HOURS_PER_DAY, RowKey
from wattsteer_ml.mixture import QuantileBand

#: The label the pooled row carries. Not a subsystem code, so a reader of the
#: table cannot mistake the pooled figure for one of the four.
POOLED_LABEL = "fold"

#: ``p ≥ 0.50`` and ``p ≥ 0.90`` — the two thresholds the published names spell.
P50_THRESHOLD = 0.50
P90_THRESHOLD = 0.90

#: What ``share_of_hours_with_p50_zero`` — the metrics table's
#: ``share_p50_zero`` — is not, published in the same dictionary as the number.
#:
#: Forecaster 17 established that this share has no model-quality content: it is
#: ``1 - P(p > 0.50)`` by construction, because ``Q_Y(q) = 0`` for every
#: ``q <= 1 - p``. It is published anyway, and should be: it is exactly the
#: figure the optimizer's posture question turns on, which is what this whole
#: module was built for. That is also why the caveat is **attached rather than
#: only collected** — the consumer here is a code path holding a metrics row,
#: and a census on ``/v1/meta`` does nothing at all for it.
SHARE_P50_ZERO_IS_NOT_MODEL_QUALITY = CaveatedFigure(
    "This share is the mixture's breakpoint restated and carries no "
    "information about how good the model is. Q_Y(q) = 0 for every q <= 1 - p, "
    "so an hour's P50 is zero exactly where p <= 0.50 and the share is "
    "1 - P(p > 0.50) by construction — an identity, not a measurement. It "
    "moves whenever anything moves p: a recalibrated classifier, a different "
    "prevalence, a different subsystem threshold. Read it as what it is, which "
    "is how many hours a P50-planned dispatch has to act in, and never as "
    "evidence that a model, a lane or a threshold is better than another.",
    figure="share_p50_zero, and share_of_hours_with_p50_zero which is the same figure",
    misreading=(
        "that a lower share is a better model, because the model found more "
        "hours worth acting in"
    ),
    surface=(
        "the model card's `p50_collapse` entries, `share_of_hours_with_p50_zero_caveat`, "
        "and every metrics row's `share_p50_zero_caveat` — published in the "
        "same dictionary as the figure, because the consumer is the optimizer's "
        "posture question and not a reviewer reading `/v1/meta`"
    ),
)


class CollapseError(ValueError):
    """The served hours cannot support the figure that was asked for."""


class ServedBand(Protocol):
    """The published hour, narrowed to the two things a collapse is counted from.

    ``p`` and the band, and deliberately nothing else.
    :class:`~wattsteer_ml.mixture.ComposedForecast` satisfies it, so a freshly
    composed fold-evaluation hour is measurable; so does a value assembled from a
    **persisted** ``curtailment_forecast_hour`` row, which carries those same
    three numbers and cannot carry the
    :class:`~wattsteer_ml.mixture.HurdleMixture` behind them. Requiring the
    mixture here would have forced a reader of stored rows to invent one, and an
    invented mixture is a second opinion about the composition — the one thing
    this file exists not to hold.
    """

    @property
    def band(self) -> QuantileBand: ...

    @property
    def occurrence_probability(self) -> float: ...


class ServedHour(Protocol):
    """One served subsystem-hour: who it is about, and what was published.

    Structural rather than nominal, so
    :class:`~wattsteer_ml.training.hurdle.HourForecast`,
    :class:`~wattsteer_ml.training.conformal.ScoredHour` and
    :class:`~wattsteer_ml.evaluation.collapse_report.PublishedHour` all satisfy
    it without this module importing any of them — which is what keeps
    ``evaluation`` free of an import cycle back through ``training``.
    """

    @property
    def key(self) -> RowKey: ...

    @property
    def forecast(self) -> ServedBand: ...


@dataclass(frozen=True)
class HoursPerDay:
    """A count-per-day distribution, as three numbers and never as one.

    `docs/specs/forecaster.md` asks for mean, p25 and p75 together. A mean alone
    hides the shape that decides the question: twelve days with four actionable
    hours and twelve with none has the same mean as twenty-four days with two,
    and only one of those two worlds breaks a P50-planned dispatch.
    """

    mean: float
    p25: float
    p75: float

    @classmethod
    def of(cls, counts: Sequence[int]) -> HoursPerDay:
        """Linear-interpolated percentiles, the ``numpy.percentile`` default.

        Stated rather than left implicit: nearest-rank and linear interpolation
        disagree by up to a whole hour on the small day counts a single fold
        holds, and a figure the optimizer reads has to be reproducible from its
        own definition.
        """
        if not counts:
            raise CollapseError(
                "hours-per-day over no complete day is not a measurement; a fold "
                "with none is reported as absent, not as 0.0"
            )
        values = np.asarray(counts, dtype=np.float64)
        return cls(
            mean=float(values.mean()),
            p25=float(np.percentile(values, 25.0)),
            p75=float(np.percentile(values, 75.0)),
        )

    def as_card_entry(self) -> dict[str, float]:
        return {"mean": self.mean, "p25": self.p25, "p75": self.p75}


@dataclass(frozen=True)
class P50Collapse:
    """The six figures, for one fold or for one subsystem of it.

    Built through :meth:`of`, which is the only place the arithmetic lives.
    ``None`` is returned there rather than a row of zeros when nothing was
    served: a zero share of collapsed days and *no days at all* are opposite
    readings of the same slot, and the optimizer must not have to guess which
    one it is looking at.
    """

    #: :data:`POOLED_LABEL` for the fold, or a subsystem code.
    label: str
    #: Served hours behind the two hour-grain shares.
    hours: int
    #: Complete subsystem-days behind the four day-grain figures.
    days: int
    #: ``(day, subsystem)`` pairs served fewer than twenty-four hours, dropped
    #: from the day-grain figures and counted here instead.
    days_excluded_incomplete: int
    hours_per_day_p_ge_50: HoursPerDay
    hours_per_day_p_ge_90: HoursPerDay
    share_of_hours_with_p50_zero: float
    share_with_p10_zero: float
    #: **The deliverable.** Share of complete subsystem-days on which no hour
    #: has a non-zero P50 — days a P50-planned dispatch sees nothing to do on.
    share_of_days_with_no_non_zero_p50_hour: float

    def __post_init__(self) -> None:
        if self.hours <= 0:
            raise CollapseError(f"{self.label}: no served hour to measure")
        if self.days <= 0:
            raise CollapseError(
                f"{self.label}: no complete subsystem-day; the day-grain figures "
                "have no denominator and the row is reported as absent"
            )

    @classmethod
    def of(cls, hours: Iterable[ServedHour], *, label: str) -> P50Collapse | None:
        """Count the six figures over served hours. ``None`` when nothing was."""
        served = list(hours)
        if not served:
            return None
        by_day: dict[tuple[date, Subsystem], list[ServedBand]] = {}
        for hour in served:
            by_day.setdefault((hour.key.target_date, hour.key.subsystem), []).append(
                hour.forecast
            )
        complete = [
            forecasts for forecasts in by_day.values() if len(forecasts) == HOURS_PER_DAY
        ]
        if not complete:
            return None
        ge_50 = [
            sum(1 for one in day if one.occurrence_probability >= P50_THRESHOLD)
            for day in complete
        ]
        ge_90 = [
            sum(1 for one in day if one.occurrence_probability >= P90_THRESHOLD)
            for day in complete
        ]
        blind = 0
        for day in complete:
            if all(one.band.p50 == 0.0 for one in day):
                blind += 1
        return cls(
            label=label,
            hours=len(served),
            days=len(complete),
            days_excluded_incomplete=len(by_day) - len(complete),
            hours_per_day_p_ge_50=HoursPerDay.of(ge_50),
            hours_per_day_p_ge_90=HoursPerDay.of(ge_90),
            share_of_hours_with_p50_zero=_share(
                one.forecast.band.p50 == 0.0 for one in served
            ),
            share_with_p10_zero=_share(one.forecast.band.p10 == 0.0 for one in served),
            share_of_days_with_no_non_zero_p50_hour=blind / len(complete),
        )

    def as_card_entry(self) -> dict[str, Any]:
        """The shape ticket 011 reads, under names that need no harness."""
        return {
            "label": self.label,
            "hours": self.hours,
            "days": self.days,
            "days_excluded_incomplete": self.days_excluded_incomplete,
            "hours_per_day_p_ge_50": self.hours_per_day_p_ge_50.as_card_entry(),
            "hours_per_day_p_ge_90": self.hours_per_day_p_ge_90.as_card_entry(),
            "share_of_hours_with_p50_zero": self.share_of_hours_with_p50_zero,
            "share_of_hours_with_p50_zero_caveat": (SHARE_P50_ZERO_IS_NOT_MODEL_QUALITY),
            "share_with_p10_zero": self.share_with_p10_zero,
            "share_of_days_with_no_non_zero_p50_hour": (
                self.share_of_days_with_no_non_zero_p50_hour
            ),
        }


@dataclass(frozen=True)
class CollapseBlock:
    """The pooled row and the per-subsystem rows, produced together.

    `docs/specs/forecaster.md` asks for the distribution "per fold and per
    subsystem", and the two are one value here so that a report cannot publish
    the pooled figure while quietly dropping the subsystem it collapsed in. The
    positives concentrate heavily in NE; a pooled
    ``share_of_days_with_no_non_zero_p50_hour`` of 0.4 could be 0.05 in NE and
    0.95 in S, and those are different instructions to the optimizer.
    """

    pooled: P50Collapse
    by_subsystem: tuple[P50Collapse, ...]

    @classmethod
    def of(cls, hours: Iterable[ServedHour]) -> CollapseBlock | None:
        served = list(hours)
        pooled = P50Collapse.of(served, label=POOLED_LABEL)
        if pooled is None:
            return None
        cells = [
            P50Collapse.of(
                [one for one in served if one.key.subsystem == code], label=code
            )
            for code in SUBSYSTEM_CODES
        ]
        return cls(
            pooled=pooled,
            by_subsystem=tuple(cell for cell in cells if cell is not None),
        )

    def as_card_entry(self) -> dict[str, Any]:
        return {
            "p50_collapse": self.pooled.as_card_entry(),
            "p50_collapse_by_subsystem": [
                cell.as_card_entry() for cell in self.by_subsystem
            ],
            "p50_collapse_note": (
                "share_of_days_with_no_non_zero_p50_hour is counted over complete "
                "subsystem-days of served bands, never over hours, and an "
                "incomplete day is excluded and counted in "
                "days_excluded_incomplete rather than read as a collapse."
            ),
        }


def _share(flags: Iterable[bool]) -> float:
    counted = 0
    hit = 0
    for flag in flags:
        counted += 1
        hit += 1 if flag else 0
    if not counted:
        raise CollapseError("a share over no rows")
    return hit / counted
