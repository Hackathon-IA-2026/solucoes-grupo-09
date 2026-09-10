"""The whole day — the hour-wise sum, the disagreement it hides, and its own error.

`docs/specs/diagnosis.md`, "Aggregation across the day", and seam 6. This module
turns one ``(subsystem, target_date)`` into the ranking the Explain screen shows:
eight signed day contributions in MWh, a published measure of how much each
group's hours disagreed with each other, the peak hour's own attribution beside
the day's, and a standard error that says when the ranking is smaller than its
own noise.

**The day attribution is the exact hour-wise sum**, ``Φ_j = Σ_t φ_{j,t}`` over
the 24 hours of the target date in ``America/Sao_Paulo``. The reason is one
line: **expectations add and quantiles do not.** The day's expected MWh really
is ``Σ_t E[Y_t]``, the baseline really is ``Σ_t v_t(∅)``, and Shapley values are
linear in the value function — so the sum of the hourly attributions *is* the
attribution of the day's expected total against a typical day's, with no
averaging rule and no weighting scheme to defend. This is the same argument that
forbids summing a band, running in the one direction where it is valid.

Ranking the mean of hourly ranks, or of hourly shares, is refused here and would
be refused anywhere: both are averages of normalisations, so an hour whose whole
attribution is 0.2 MWh would weigh as much as one carrying 90 MWh.

**The day is a Brasília civil date, not a UTC one.**
:class:`~wattsteer_ml.evaluation.RowKey` already carries the civil ``target_date``
and the local hour derived against it, so a day is 24 keys with 24 distinct local
hours — and :func:`attribute_day` refuses anything else. That refusal is the DST
canary one layer up from the feature spec's: a day that arrived as 23 or 25 rows
stops here rather than publishing a sum over the wrong hours.

**The cost of summing is measured rather than waved at.** A group can dominate at
noon and reverse at dawn, and the sum hides it, so every group publishes

```
hour_disagreement_j = Σ_t |φ_{j,t}| / max(|Σ_t φ_{j,t}|, ε)
```

``1.0`` means every hour pulled the same way. :data:`BOTH_DIRECTIONS_THRESHOLD`
is where the narration is required to say the driver acted in both directions
across the day — a judgement placed where being wrong is conservative, and named
here rather than buried in a comparison.

**The selection predicate is shared; the merge is not.** The narration is
assembled server-side and has to know which groups are notable, so
:meth:`DayAttribution.notable` applies the display cut — ``share ≥ 0.03``,
capped at six rows. What stays the client's is merging the remainder into one
``other`` row and giving it ``direction: "mixed"``. Nothing in this module
merges a group into another, and nothing here can produce a ``"mixed"``
direction: a group is one player with one signed contribution.
"""

from __future__ import annotations

import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any

import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.diagnosis.attribution import (
    EXPLAINS_CODE,
    LOCAL_ACCURACY_TOLERANCE,
    AttributionError,
    ComposedExpectation,
    Direction,
    HourAttribution,
    LocalAccuracyError,
    attribute_hour,
    resample_hour,
)
from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    DriverGroupMap,
    GroupCode,
)
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training.background import MatchedBackground

#: What the day payload says it attributed. `api-surface.md` spells it this way;
#: :data:`~wattsteer_ml.diagnosis.attribution.ATTRIBUTION_TARGET_HOUR` is the
#: hour it is summed from.
ATTRIBUTION_TARGET_DAY = "expected_mwh_day"

#: ``ε`` in the disagreement ratio — a floor on the denominator, never a
#: smoother on the numerator. A group whose hours cancel exactly has genuinely
#: infinite disagreement; the floor makes that a large finite number instead of
#: a division by zero, and such a group's ``|Φ|`` is ~0, so its share puts it
#: below the fold anyway.
DISAGREEMENT_EPSILON = 1e-9

#: Where a group stops being "this driver raised the forecast" and starts being
#: "this driver acted in both directions across the day". `docs/specs/diagnosis.md`
#: is candid that ``2.0`` is a judgement rather than a measurement, and it is
#: placed where being wrong is conservative: over-declaring mixed behaviour costs
#: a clause in the narration, under-declaring it hides a reversal. Named here so
#: the number is one edit rather than a literal in a comparison.
BOTH_DIRECTIONS_THRESHOLD = 2.0

#: ``B`` in the bootstrap over the background sample. The spec's 200.
STDERR_RESAMPLES = 200

#: The display cut, applied server-side because the narration has to know which
#: groups are notable. **Selecting is shared; merging is not** — see
#: :meth:`DayAttribution.notable`.
NOTABLE_SHARE_FLOOR = 0.03
NOTABLE_ROW_CAP = 6


class DayAttributionError(AttributionError):
    """The day cannot be summed from what it was given."""


class IncompleteDayError(DayAttributionError):
    """The 24 hours of a Brasília civil day were not all present.

    Not a fallback. A day summed from 23 rows is a smaller number that looks
    exactly like a smaller day, and every share taken of it is a share of the
    wrong denominator.
    """


@dataclass(frozen=True)
class DayGroupContribution:
    """One player's signed day contribution, its share, and its disagreement."""

    code: GroupCode
    label_code: str
    #: ``Φ_j = Σ_t φ_{j,t}`` in MWh, summed with :func:`math.fsum` over the 24
    #: hours. Signed: the model's expectation for the day sits this much higher
    #: (or lower) than a typical day's *because this group is what it is rather
    #: than typical* — a statement about the model, never about the grid.
    phi_mwh: float
    #: ``|Φ_j| / Σ_k |Φ_k|`` **over all eight groups** — not over the rows the
    #: screen displays, which was circular, since the display cut is itself
    #: applied to ``share``. So the shares sum to 1, a day whose drivers cancel
    #: still produces a full bar chart, and they are shares of the **total
    #: attributed movement**: not of the curtailment, and not of "the attributed
    #: magnitude".
    share: float
    direction: Direction
    #: ``Σ_t |φ_{j,t}| / max(|Σ_t φ_{j,t}|, ε)``. Always ``≥ 1``, and exactly
    #: ``1`` when every hour shared a sign.
    hour_disagreement: float
    #: ``φ_{j,t}`` for each of the 24 hours, in local-hour order. The number the
    #: disagreement is computed from, kept so a reader can check it and so the
    #: 24 × 8 heatmap the spec defers has its data already.
    hourly_phi_mwh: tuple[float, ...]

    def __post_init__(self) -> None:
        if not math.isfinite(self.phi_mwh):
            raise DayAttributionError(f"Φ for {self.code!r} is {self.phi_mwh!r}")
        if not 0.0 <= self.share <= 1.0:
            raise DayAttributionError(f"share for {self.code!r} is {self.share!r}")
        expected: Direction = "lowers" if self.phi_mwh < 0.0 else "raises"
        if self.direction != expected:
            raise DayAttributionError(
                f"{self.code!r} carries Φ = {self.phi_mwh} and direction "
                f"{self.direction!r}; the sign is not a separate decision"
            )
        if len(self.hourly_phi_mwh) != HOURS_PER_DAY:
            raise IncompleteDayError(
                f"{self.code!r} carries {len(self.hourly_phi_mwh)} hours and a "
                f"Brasília civil day is {HOURS_PER_DAY}"
            )
        if self.hour_disagreement < 1.0:
            raise DayAttributionError(
                f"{self.code!r} reports hour_disagreement "
                f"{self.hour_disagreement!r}; Σ|φ_t| ≥ |Σ φ_t| is a triangle "
                "inequality and a ratio below 1 means the two were computed "
                "from different hours"
            )

    @property
    def acts_in_both_directions(self) -> bool:
        """Whether the narration is required to say the driver reversed."""
        return self.hour_disagreement >= BOTH_DIRECTIONS_THRESHOLD

    def to_payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "label_code": self.label_code,
            "phi_mwh": self.phi_mwh,
            "share": self.share,
            "direction": self.direction,
            "hour_disagreement": self.hour_disagreement,
        }


@dataclass(frozen=True)
class DayAttribution:
    """One ``(subsystem, target_date)``: eight day contributions and their error.

    Local accuracy is checked **here**, at construction, exactly as it is for one
    hour: the shares are shares of ``Σ_k |Φ_k|``, and if the eight numbers do not
    add up to ``day_expected_mwh − baseline_expected_mwh`` then they are not a
    decomposition of anything and the bar chart is a picture of nothing. So is
    the hour count: an incomplete day cannot exist as a value.
    """

    subsystem: Subsystem
    target_date: date
    #: Always :data:`ATTRIBUTION_TARGET_DAY`. The field exists so the wire says
    #: what was attributed rather than the reader assuming it.
    target: str
    #: All eight, ranked by ``|share|``. The display cut is
    #: :meth:`notable`; the ``other`` merge is the client's.
    contributions: tuple[DayGroupContribution, ...]
    #: ``Σ_t v_t(∅)`` — a typical day in this subsystem, in MWh.
    baseline_expected_mwh: float
    #: ``Σ_t g(x_t)`` — this day's composed expected MWh.
    day_expected_mwh: float
    #: ``Σ_j Φ_j − (day_expected_mwh − baseline_expected_mwh)``, published rather
    #: than swallowed. Zero in exact arithmetic; it inherits the 24 hours' own
    #: residuals and nothing else.
    local_accuracy_residual_mwh: float
    #: 24, asserted. Carried on the wire because "this is a whole civil day" is a
    #: claim the payload can make rather than one a reader has to take on trust.
    hours_attributed: int
    #: The local hour with the largest ``E[Y_t]``, and that hour's own eight
    #: contributions. Returned **beside** the day, never instead of it: the
    #: headline ranking is always the day's.
    peak_hour_local: int
    peak_hour: HourAttribution
    #: The bootstrap over the background sample: resample ``B(s, h)`` with
    #: replacement, recompute ``v(∅)`` and ``Σ_j |Φ_j|``, take the standard
    #: deviation of the day total. The number that turns "this ranking is noise"
    #: into a measurement — `docs/specs/diagnosis.md`'s ``attribution_is_noise``
    #: rule fires on ``Σ_j |Φ_j| ≤ 2 × attribution_stderr_mwh``.
    attribution_stderr_mwh: float
    #: The same bootstrap's spread on the baseline itself, which moves under a
    #: redraw for the same reason the ranking does.
    baseline_stderr_mwh: float
    stderr_resamples: int
    stderr_seed: int
    background_rows: int
    background_seed: int
    background_source: str
    coalitions: int
    #: Wall clock for the whole day — 24 instances plus the bootstrap — so the
    #: publication budget is argued about with a number.
    elapsed_seconds: float
    driver_group_version: str
    driver_group_hash: str
    #: The 24 hours the day was summed from, in local-hour order. Kept for the
    #: peak, for the heatmap and for the tests that assert the sum; each has had
    #: its coalition block dropped, so the day holds one hour's worth of
    #: intermediate arithmetic and not 24.
    hours: tuple[HourAttribution, ...] = field(repr=False, compare=False, default=())

    def __post_init__(self) -> None:
        codes = tuple(one.code for one in self.contributions)
        if sorted(codes) != sorted(DRIVER_GROUP_CODES):
            raise DayAttributionError(
                f"a day attribution is all eight groups exactly once, got {codes!r}"
            )
        if self.hours_attributed != HOURS_PER_DAY:
            raise IncompleteDayError(
                f"the day of {self.target_date.isoformat()} was summed from "
                f"{self.hours_attributed} hours; a Brasília civil day is "
                f"{HOURS_PER_DAY} and a short day is a smaller number that looks "
                "exactly like a smaller day"
            )
        if not 0 <= self.peak_hour_local < HOURS_PER_DAY:
            raise DayAttributionError(
                f"peak hour {self.peak_hour_local!r} is outside the day"
            )
        if self.attribution_stderr_mwh < 0.0 or self.baseline_stderr_mwh < 0.0:
            raise DayAttributionError("a standard deviation is not negative")
        movement = self.day_expected_mwh - self.baseline_expected_mwh
        attributed = math.fsum(one.phi_mwh for one in self.contributions)
        scale = max(1.0, abs(self.day_expected_mwh), abs(self.baseline_expected_mwh))
        if abs(attributed - movement) > LOCAL_ACCURACY_TOLERANCE * scale:
            raise LocalAccuracyError(
                f"the eight day contributions sum to {attributed} and "
                f"day_expected_mwh − baseline_expected_mwh is {movement}; a "
                f"residual of {attributed - movement} is above the arithmetic's "
                f"own {LOCAL_ACCURACY_TOLERANCE} × {scale}"
            )

    @property
    def total_attributed_mwh(self) -> float:
        """``Σ_j Φ_j`` — equal to the day's movement, which is why it is not stored."""
        return math.fsum(one.phi_mwh for one in self.contributions)

    @property
    def sum_abs_attributed_mwh(self) -> float:
        """``Σ_j |Φ_j|`` — the shares' denominator, and the movement's size."""
        return math.fsum(abs(one.phi_mwh) for one in self.contributions)

    @property
    def top_two_share(self) -> float:
        """The two largest shares, added **here** so the renderer never adds.

        `docs/specs/diagnosis.md`'s numeric whitelist rejects any number the
        narration computed rather than read, and the prototype's own fixture
        narration adds two shares together. The rule is only enforceable if
        nothing the copy wants requires arithmetic.
        """
        return math.fsum(one.share for one in self.contributions[:2])

    @property
    def ranking_is_noise(self) -> bool:
        """``Σ_j |Φ_j| ≤ 2 × attribution_stderr_mwh`` — the ranking is smaller
        than its own background-sampling error.

        The predicate the ``attribution_is_noise`` rule evaluates. It is computed
        here, next to the two numbers it compares, and it decides nothing: the
        rules ticket owns what withholding a narration means, and no rule may
        change a ``Φ``, a sign or a share.
        """
        return self.sum_abs_attributed_mwh <= 2.0 * self.attribution_stderr_mwh

    def contribution(self, code: GroupCode) -> DayGroupContribution:
        """One group's row. The code set is closed, so this cannot miss."""
        for one in self.contributions:
            if one.code == code:
                return one
        raise DayAttributionError(f"unknown group code {code!r}")

    def notable(self) -> tuple[DayGroupContribution, ...]:
        """The groups above the fold — ``share ≥ 0.03``, capped at six rows.

        **The predicate is shared; the merge is not.** The narration is assembled
        server-side and has to know which groups it is allowed to name, so the
        selection lives here. What stays the client's is merging everything this
        leaves out into a single ``other`` row, summing its ``φ`` and deciding
        whether that row's direction is ``"mixed"`` — the one summing step in the
        whole design, and the one place a sign can still be lost.

        Nothing is merged here and nothing is dropped from
        :attr:`contributions`: all eight go on the wire, ranked, whatever this
        returns.
        """
        return tuple(
            one
            for one in self.contributions[:NOTABLE_ROW_CAP]
            if one.share >= NOTABLE_SHARE_FLOOR
        )

    def to_payload(self) -> dict[str, Any]:
        """The day's attribution block, as codes and numbers.

        ``explains`` is not decoration: the screen is required to say, once, that
        the bars explain the **expected MWh** and not the P10, the P90, the
        band's width or the day's occurrence probability.
        """
        return {
            "target": self.target,
            "explains": EXPLAINS_CODE,
            "subsystem": self.subsystem,
            "target_date": self.target_date.isoformat(),
            "hours_attributed": self.hours_attributed,
            "baseline_expected_mwh": self.baseline_expected_mwh,
            "day_expected_mwh": self.day_expected_mwh,
            "total_attributed_mwh": self.total_attributed_mwh,
            "sum_abs_attributed_mwh": self.sum_abs_attributed_mwh,
            "stderr_mwh": self.attribution_stderr_mwh,
            "stderr_resamples": self.stderr_resamples,
            "top_two_share": self.top_two_share,
            "peak_hour_local": self.peak_hour_local,
            "driver_group_version": self.driver_group_version,
            "driver_group_hash": self.driver_group_hash,
            "groups": [one.to_payload() for one in self.contributions],
            "peak_hour_groups": [
                one.to_payload() for one in self.peak_hour.contributions
            ],
        }

    def timing_fields(self) -> dict[str, Any]:
        """What the publication run records about what this day cost."""
        return {
            "elapsed_seconds": self.elapsed_seconds,
            "hours_attributed": self.hours_attributed,
            "coalitions": self.coalitions,
            "background_rows": self.background_rows,
            "background_seed": self.background_seed,
            "background_source": self.background_source,
            "row_evaluations": (
                self.hours_attributed * self.coalitions * self.background_rows
            ),
            "stderr_resamples": self.stderr_resamples,
            "local_accuracy_residual_mwh": self.local_accuracy_residual_mwh,
        }


def day_rows(
    keys: Sequence[RowKey],
    matrix: npt.NDArray[np.float64],
    *,
    subsystem: Subsystem,
    target_date: date,
) -> tuple[tuple[RowKey, ...], npt.NDArray[np.float64]]:
    """The 24 rows of one Brasília civil day, selected out of a scored block.

    Selection is by :attr:`RowKey.target_date`, which is already the civil day
    on the grid's clock — ``RowKey.from_feature_row`` derives the local hour as
    the offset from Brasília midnight rather than from the UTC hour, which it is
    not for any hour of any Brazilian day. So this is the civil-day selection and
    there is no timezone arithmetic here to get wrong.

    The rows come back in local-hour order, which is the order the day sum and
    the disagreement are defined over.

    Raises:
        IncompleteDayError: if the block does not hold exactly 24 distinct local
            hours for this cell.
    """
    if matrix.ndim != 2 or matrix.shape[0] != len(keys):
        raise DayAttributionError(
            f"{len(keys)} keys and a matrix of shape {matrix.shape}"
        )
    chosen = [
        (key, index)
        for index, key in enumerate(keys)
        if key.subsystem == subsystem and key.target_date == target_date
    ]
    chosen.sort(key=lambda pair: pair[0].local_hour)
    hours = [key.local_hour for key, _ in chosen]
    if hours != list(range(HOURS_PER_DAY)):
        raise IncompleteDayError(
            f"({subsystem!r}, {target_date.isoformat()}) is {sorted(set(hours))} in "
            f"this block and a Brasília civil day is hours 0–{HOURS_PER_DAY - 1}, "
            "each exactly once"
        )
    positions = [index for _, index in chosen]
    return tuple(key for key, _ in chosen), np.ascontiguousarray(matrix[positions, :])


def attribute_day(
    *,
    keys: Sequence[RowKey],
    target_rows: npt.NDArray[np.float64],
    background: MatchedBackground,
    expectation: ComposedExpectation,
    group_map: DriverGroupMap = DRIVER_GROUP_MAP,
    stderr_resamples: int = STDERR_RESAMPLES,
    stderr_seed: int = 0,
) -> DayAttribution:
    """The eight day contributions for one ``(subsystem, target_date)``.

    Each hour is attributed on its own, against its own matched background cell,
    by :func:`~wattsteer_ml.diagnosis.attribution.attribute_hour` — this function
    adds no game and solves none. What it does is the one aggregation the design
    permits: ``Φ_j = Σ_t φ_{j,t}``, with :func:`math.fsum`, over 24 hours it has
    checked are the 24 hours of a Brasília civil day.

    The bootstrap re-weights the evaluations the hours already paid for rather
    than redrawing and re-evaluating ``g``: see
    :func:`~wattsteer_ml.diagnosis.attribution.resample_phi`. Each hour's block
    is dropped as soon as it has been resampled, so the day never holds 24 of
    them.

    Args:
        keys: the 24 target rows' identities. Their subsystem and civil date must
            agree and their local hours must be ``0 … 23``, each once.
        target_rows: ``x_t``, one row per key, in the same order, encoded against
            ``background``'s contract.
        background: ``B``, drawn once and stamped elsewhere.
        expectation: ``g``, the forecaster's own composition.
        group_map: the eight players.
        stderr_resamples: ``B`` in the bootstrap. Zero is refused — a day with no
            error bar would publish "this ranking is certain".
        stderr_seed: the bootstrap's seed, recorded on the result so the standard
            error is reproducible from the artifact and the day.

    Returns:
        Eight signed day contributions in MWh, ranked by ``|share|``, with the
        hour count, local accuracy and every disagreement already asserted.

    Raises:
        IncompleteDayError: if the 24 hours are not all present, exactly once.
        DayAttributionError: if the keys disagree about which cell they are.
    """
    started = time.perf_counter()
    subsystem, target_date = _one_day(keys)
    # Two, not one: the standard deviation is taken with ``ddof=1``, so a single
    # replicate has no spread to report and would publish a NaN error bar — which
    # compares false against every threshold and would silently turn the
    # `attribution_is_noise` rule off.
    if stderr_resamples < 2:
        raise DayAttributionError(
            f"stderr_resamples is {stderr_resamples!r}; the bootstrap is what turns "
            "'this ranking is noise' into a measurement and is not optional"
        )
    if target_rows.ndim != 2 or target_rows.shape[0] != len(keys):
        raise DayAttributionError(
            f"{len(keys)} keys and target rows of shape {target_rows.shape}"
        )

    hours: list[HourAttribution] = []
    # ``(24, resamples, 8)`` — one replicate's ``φ`` per hour, per player.
    replicates = np.empty(
        (HOURS_PER_DAY, stderr_resamples, len(DRIVER_GROUP_CODES)), dtype=np.float64
    )
    baselines = np.empty((HOURS_PER_DAY, stderr_resamples), dtype=np.float64)
    for index, key in enumerate(keys):
        hour = attribute_hour(
            key=key,
            target_row=target_rows[index],
            background=background,
            expectation=expectation,
            group_map=group_map,
            retain_coalition_rows=True,
        )
        # Seeded from the day's seed and the hour's own coordinate, so a cell's
        # resample depends on neither the iteration order nor how many hours ran
        # before it — the same discipline the background's own draw uses.
        generator = np.random.default_rng([stderr_seed, key.local_hour])
        resampled = resample_hour(hour, resamples=stderr_resamples, generator=generator)
        replicates[index] = resampled.phi_mwh
        baselines[index] = resampled.baseline_expected_mwh
        hours.append(replace(hour, coalition_rows=None))

    day_expected = math.fsum(one.expected_mwh for one in hours)
    day_baseline = math.fsum(one.baseline_expected_mwh for one in hours)

    hourly: dict[GroupCode, tuple[float, ...]] = {
        code: tuple(one.contribution(code).phi_mwh for one in hours)
        for code in DRIVER_GROUP_CODES
    }
    day_phi = {code: math.fsum(values) for code, values in hourly.items()}
    denominator = math.fsum(abs(value) for value in day_phi.values())

    contributions = tuple(
        DayGroupContribution(
            code=code,
            label_code=group_map.group(code).label_code,
            phi_mwh=day_phi[code],
            # A day where every group's Φ is exactly zero has no movement to take
            # shares of. Zero is the only honest answer; 1/8 each would draw
            # eight equal bars under a title that says "share of the movement"
            # when there was none.
            share=(abs(day_phi[code]) / denominator if denominator > 0.0 else 0.0),
            direction="lowers" if day_phi[code] < 0.0 else "raises",
            hour_disagreement=_hour_disagreement(hourly[code]),
            hourly_phi_mwh=hourly[code],
        )
        for code in DRIVER_GROUP_CODES
    )

    peak = max(hours, key=lambda one: (one.expected_mwh, -one.key.local_hour))
    totals = np.abs(replicates.sum(axis=0)).sum(axis=1)

    return DayAttribution(
        subsystem=subsystem,
        target_date=target_date,
        target=ATTRIBUTION_TARGET_DAY,
        contributions=tuple(
            sorted(contributions, key=lambda one: (-one.share, one.code))
        ),
        baseline_expected_mwh=day_baseline,
        day_expected_mwh=day_expected,
        local_accuracy_residual_mwh=math.fsum(day_phi.values())
        - (day_expected - day_baseline),
        hours_attributed=len(hours),
        peak_hour_local=peak.key.local_hour,
        peak_hour=peak,
        attribution_stderr_mwh=float(np.std(totals, ddof=1)),
        baseline_stderr_mwh=float(np.std(baselines.sum(axis=0), ddof=1)),
        stderr_resamples=stderr_resamples,
        stderr_seed=stderr_seed,
        background_rows=background.rows_per_cell,
        background_seed=background.seed,
        background_source=background.source,
        coalitions=hours[0].coalitions,
        elapsed_seconds=time.perf_counter() - started,
        driver_group_version=str(group_map.version),
        driver_group_hash=group_map.driver_group_hash,
        hours=tuple(hours),
    )


def _hour_disagreement(hourly: Sequence[float]) -> float:
    """``Σ_t |φ_t| / max(|Σ_t φ_t|, ε)`` — how much this group's hours disagreed.

    ``1.0`` when every hour shared a sign, by the triangle inequality holding
    with equality, and larger the more the hours pulled against each other.

    A group that did nothing at all — every hour exactly zero — pulled the same
    way in all 24 of them, vacuously, and gets ``1.0`` rather than ``0/ε``. That
    is the only value that keeps ``hour_disagreement ≥ 1`` a property of the
    quantity rather than of the data it happened to see.
    """
    absolute = math.fsum(abs(one) for one in hourly)
    if absolute == 0.0:
        return 1.0
    return absolute / max(abs(math.fsum(hourly)), DISAGREEMENT_EPSILON)


def _one_day(keys: Sequence[RowKey]) -> tuple[Subsystem, date]:
    """The cell and civil date these keys agree on, or the reason they do not."""
    if len(keys) != HOURS_PER_DAY:
        raise IncompleteDayError(
            f"a day attribution is the {HOURS_PER_DAY} hours of a Brasília civil "
            f"date and {len(keys)} keys were supplied; the sum over a short day is "
            "a smaller number that looks exactly like a smaller day"
        )
    subsystem = keys[0].subsystem
    target_date = keys[0].target_date
    if subsystem not in SUBSYSTEM_CODES:
        raise DayAttributionError(f"{subsystem!r} is not a subsystem")
    for key in keys:
        if key.subsystem != subsystem or key.target_date != target_date:
            raise DayAttributionError(
                f"a day attribution is one (subsystem, target_date); got "
                f"{key.subsystem!r} {key.target_date.isoformat()} beside "
                f"{subsystem!r} {target_date.isoformat()}"
            )
    if [key.local_hour for key in keys] != list(range(HOURS_PER_DAY)):
        raise IncompleteDayError(
            f"the hours supplied for {target_date.isoformat()} are "
            f"{[key.local_hour for key in keys]}; a Brasília civil day is hours "
            f"0–{HOURS_PER_DAY - 1}, each exactly once and in order"
        )
    return subsystem, target_date
