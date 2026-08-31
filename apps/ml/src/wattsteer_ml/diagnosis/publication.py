"""What a published attribution is: the rows the worker writes, and nothing else.

`docs/specs/diagnosis.md`, "Persistence, so Replay can read it", and
`docs/specs/api-surface.md`'s boundary decision, which fixes the direction:

    The worker calls the ML service over the private network at
    ``POST /internal/publish/diagnosis`` — **worker → ml, never gateway → ml**.
    The ML service is read-only against Postgres, so it returns the computed
    rows and the **worker** writes them.

So this module **computes and returns; it never writes**. There is no ``INSERT``
here, no session, no engine: the pool is opened read-only and would refuse one,
but the reason none is attempted is the ownership rule — every write in this
product belongs to the service that owns the Drizzle schema.

## What a published attribution row carries, and why each field is on it

**The eight day contributions, always all eight.** A rule may ``annotate``,
``demote`` or ``withhold``; **no rule may change a number and no rule may delete
a driver**. ``withhold`` suppresses the model narration and the template renders
instead — it acts on the *narration* and never on the ranking. So this module
emits the full ranking at both grains whatever fired, the fired rules travel
beside it, and the strictest action is recorded rather than applied.

**The shares are shares of all eight groups.** ``|Φ_j| / Σ_k |Φ_k|``, exactly as
:class:`~wattsteer_ml.diagnosis.day_attribution.DayAttribution` computed them,
copied and never recomputed here. A share taken over the *displayed* rows is
circular — the display cut is applied to the share itself — and a wrong
denominator is invisible once stored.

**The peak hour's own eight, beside the day's.** Never instead of them: the
headline ranking is always the day's, and the peak hour is a second block on the
same publication.

**``driver_group_hash`` is on the row.** The map is data with a version and a
hash over its feature→group pairs, and it moves for exactly the change that
re-ranks the screen — a feature changing group, arriving or leaving. A stored
attribution whose grouping has since changed has to be *identifiable* as such
rather than silently re-rendered under a new map, and the hash is what makes
that a comparison instead of a guess.

**``background_source`` is the attribution's ``correction_regime``.** The
forecast rows name the rule that composed their band because ``run_label``
changes on retrains that changed nothing and does not change when a rule changes
under a promoted bundle. "Typical" has exactly the same exposure and a live
instance of it: the matched background this ticket's dependency draws is a
seeded sample from the base-fit block, and the artifact's frozen sample —
`docs/specs/diagnosis.md`'s first addition to the bundle — has not landed. A row
that does not say which of the two defined its "typical" cannot be told apart
from one measured against the other, and the two are different explanations.

**``observed`` and ``typical`` are numbers with a unit code**, never
preformatted strings — a preformatted value is a translated string by another
name. They are stored rather than derived at read time because deriving
``typical`` means holding the matched background, which means loading the
artifact: the one thing a stored attribution exists to make unnecessary. Their
day-grain definition is :func:`headline_readings`'.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal

import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.diagnosis.attribution import HourAttribution
from wattsteer_ml.diagnosis.background import MatchedBackground
from wattsteer_ml.diagnosis.day_attribution import DayAttribution
from wattsteer_ml.diagnosis.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    DriverGroupMap,
    GroupCode,
)
from wattsteer_ml.evaluation import RowKey

#: ``origin_kind`` on every row this module produces. A publication is a
#: **record**; ``backfilled_holdout`` is a counterfactual publication instant and
#: is produced by the backtest, never here.
SERVED_ORIGIN_KIND: Literal["served"] = "served"

#: ``ForecastOrigin.producer`` for a WattSteer attribution.
PRODUCER: Literal["wattsteer"] = "wattsteer"

#: The two rankings one publication carries. ``peak_hour`` is stored beside
#: ``day`` and never instead of it.
Grain = Literal["day", "peak_hour"]

#: The whole of what a rule may do. Three actions, ordered so that two rules
#: cannot both claim the last word: ``withhold`` > ``demote`` > ``annotate``.
RuleAction = Literal["annotate", "demote", "withhold"]

RULE_ACTION_ORDER: tuple[RuleAction, ...] = ("annotate", "demote", "withhold")


class AttributionPublicationError(ValueError):
    """These attributions cannot produce a publication."""


@dataclass(frozen=True)
class FiredRule:
    """One rule that fired, and the inputs that fired it.

    Recorded so that a strange narration can be traced back to the rule that
    shaped it. The action is the whole of the rule's power: it governs what gets
    *said*, and nothing in this publication's numbers.
    """

    code: str
    action: RuleAction
    facts: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.action not in RULE_ACTION_ORDER:
            raise AttributionPublicationError(
                f"{self.code!r} claims the action {self.action!r}; a rule may "
                "annotate, demote or withhold, and may do nothing else"
            )

    def as_row(self) -> dict[str, Any]:
        return {"code": self.code, "action": self.action, "facts": dict(self.facts)}


@dataclass(frozen=True)
class DriverReading:
    """The observed/typical pair the screen may show beside one bar.

    A group has no single value, so the pair is the *headline feature*'s, and
    the feature is named on the row — that is what stops a value pair being read
    as the whole group's reading.
    """

    feature: str
    unit: str
    observed: float
    typical: float

    def __post_init__(self) -> None:
        for name, value in (("observed", self.observed), ("typical", self.typical)):
            if not math.isfinite(value):
                raise AttributionPublicationError(
                    f"{self.feature!r} reports {name} {value!r}"
                )


def headline_readings(
    attribution: DayAttribution,
    *,
    keys: Sequence[RowKey],
    target_rows: npt.NDArray[np.float64],
    background: MatchedBackground,
    group_map: DriverGroupMap = DRIVER_GROUP_MAP,
) -> dict[tuple[Grain, GroupCode], DriverReading]:
    """Each group's headline feature, observed against typical, at both grains.

    **The definition, stated rather than assumed**, because the spec fixes the
    pair's *shape* — two numbers and a unit code — and not its day-grain reading:

    - ``day``: ``observed`` is the mean of the headline feature over the day's
      24 rows and ``typical`` is its mean over the 24 matched background cells.
      Both means over the same 24 local hours, which is what makes them
      comparable: "typical" here is exactly the sample the baseline ``v(∅)`` was
      averaged over, read one column at a time.
    - ``peak_hour``: the peak hour's own value, against the mean over that one
      ``(subsystem, local_hour)`` cell.

    The cells all hold ``rows_per_cell`` rows, so the mean over the pooled rows
    and the mean of the cell means are the same number and there is no weighting
    decision hidden here.

    Raises:
        AttributionPublicationError: if the rows were encoded under a different
            feature contract than the background, which would silently read one
            feature's values under another's name.
    """
    if target_rows.ndim != 2 or target_rows.shape[0] != len(keys):
        raise AttributionPublicationError(
            f"{len(keys)} keys and target rows of shape {target_rows.shape}"
        )
    names = background.feature_names
    if target_rows.shape[1] != len(names):
        raise AttributionPublicationError(
            f"the target rows are {target_rows.shape[1]} columns wide and the "
            f"background's contract names {len(names)}"
        )
    index = {name: position for position, name in enumerate(names)}

    by_hour = {key.local_hour: position for position, key in enumerate(keys)}
    peak_position = by_hour.get(attribution.peak_hour_local)
    if peak_position is None:
        raise AttributionPublicationError(
            f"hour {attribution.peak_hour_local} is the peak and is not among the "
            f"rows supplied for {attribution.target_date.isoformat()}"
        )

    readings: dict[tuple[Grain, GroupCode], DriverReading] = {}
    for code in DRIVER_GROUP_CODES:
        group = group_map.group(code)
        column = index.get(group.headline_feature)
        if column is None:
            raise AttributionPublicationError(
                f"{group.headline_feature!r} is {code}'s headline feature and is "
                "not in the background's feature contract; the pair beside the "
                "bar would be some other feature's"
            )
        day_typical = float(
            np.mean(
                [
                    float(np.mean(background.cell_for(key).matrix[:, column]))
                    for key in keys
                ]
            )
        )
        readings[("day", code)] = DriverReading(
            feature=group.headline_feature,
            unit=group.unit,
            observed=float(np.mean(target_rows[:, column])),
            typical=day_typical,
        )
        peak_key = keys[peak_position]
        readings[("peak_hour", code)] = DriverReading(
            feature=group.headline_feature,
            unit=group.unit,
            observed=float(target_rows[peak_position, column]),
            typical=float(np.mean(background.cell_for(peak_key).matrix[:, column])),
        )
    return readings


@dataclass(frozen=True)
class AttributionRow:
    """One ``(subsystem, target_date)`` explanation, as it is persisted.

    The attribution itself is not restated here — it *is*
    :class:`~wattsteer_ml.diagnosis.day_attribution.DayAttribution`, which has
    already asserted local accuracy, the hour count, every disagreement and the
    shares' denominator. This type decorates it with the two things a stored row
    needs and a computed attribution has no opinion about: the observed/typical
    pair per bar, and the rules that fired.
    """

    attribution: DayAttribution
    readings: Mapping[tuple[Grain, GroupCode], DriverReading]
    rule_flags: tuple[FiredRule, ...] = ()
    #: The groups a ``demote`` rule pushed below the fold. A display fact stored
    #: **beside** a complete contribution and never in place of one: the bar
    #: still carries its ``φ``, its sign and its share, because a rule's power is
    #: over what gets said and never over what is true of the model.
    demoted: frozenset[GroupCode] = frozenset()

    def __post_init__(self) -> None:
        for grain in ("day", "peak_hour"):
            missing = [
                code for code in DRIVER_GROUP_CODES if (grain, code) not in self.readings
            ]
            if missing:
                raise AttributionPublicationError(
                    f"no {grain} reading for {', '.join(missing)}; every bar the "
                    "screen may show carries the pair its subtitle is drawn from"
                )

    @property
    def subsystem(self) -> Subsystem:
        return self.attribution.subsystem

    @property
    def target_date(self) -> date:
        return self.attribution.target_date

    @property
    def governing_rule_action(self) -> RuleAction | None:
        """The strictest action any fired rule took, or ``None`` if none did.

        ``withhold`` > ``demote`` > ``annotate``, so two rules cannot both claim
        the last word. ``None`` is an absence rather than a fourth action: a
        ``none`` action would be an action, and something would eventually take
        it.
        """
        if not self.rule_flags:
            return None
        strictest = max(
            self.rule_flags, key=lambda one: RULE_ACTION_ORDER.index(one.action)
        )
        return strictest.action

    def _driver_rows(self) -> list[dict[str, Any]]:
        """All sixteen bars — the day's eight, then the peak hour's eight.

        Ranked here, by ``|share|`` with the code breaking ties, so the stored
        ``rank`` is a number rather than a position in whatever order a caller
        happened to iterate. Nothing is dropped and nothing is merged: the
        ``share ≥ 0.03`` cut and the ``other`` row are the client's.
        """
        rows: list[dict[str, Any]] = []
        day = sorted(
            self.attribution.contributions, key=lambda one: (-one.share, one.code)
        )
        for rank, contribution in enumerate(day, start=1):
            reading = self.readings[("day", contribution.code)]
            rows.append(
                {
                    **contribution.to_payload(),
                    "rank": rank,
                    "headline_feature": reading.feature,
                    "observed": reading.observed,
                    "typical": reading.typical,
                    "unit": reading.unit,
                    "demoted": contribution.code in self.demoted,
                }
            )
        return rows

    def _peak_rows(self) -> list[dict[str, Any]]:
        peak: HourAttribution = self.attribution.peak_hour
        rows: list[dict[str, Any]] = []
        ordered = sorted(peak.contributions, key=lambda one: (-one.share, one.code))
        for rank, contribution in enumerate(ordered, start=1):
            reading = self.readings[("peak_hour", contribution.code)]
            rows.append(
                {
                    **contribution.to_payload(),
                    "rank": rank,
                    "headline_feature": reading.feature,
                    "observed": reading.observed,
                    "typical": reading.typical,
                    "unit": reading.unit,
                    "demoted": contribution.code in self.demoted,
                }
            )
        return rows

    def as_row(self) -> dict[str, Any]:
        """What crosses the private network for this subsystem's day."""
        one = self.attribution
        return {
            "subsystem": one.subsystem,
            "target_date": one.target_date.isoformat(),
            "target": one.target,
            "hours_attributed": one.hours_attributed,
            "baseline_expected_mwh": one.baseline_expected_mwh,
            "day_expected_mwh": one.day_expected_mwh,
            "total_attributed_mwh": one.total_attributed_mwh,
            "sum_abs_attributed_mwh": one.sum_abs_attributed_mwh,
            "local_accuracy_residual_mwh": one.local_accuracy_residual_mwh,
            "top_two_share": one.top_two_share,
            "stderr_mwh": one.attribution_stderr_mwh,
            "baseline_stderr_mwh": one.baseline_stderr_mwh,
            "stderr_resamples": one.stderr_resamples,
            "stderr_seed": one.stderr_seed,
            "peak_hour_local": one.peak_hour_local,
            "peak_hour_expected_mwh": one.peak_hour.expected_mwh,
            "peak_hour_baseline_expected_mwh": one.peak_hour.baseline_expected_mwh,
            "driver_group_version": one.driver_group_version,
            "driver_group_hash": one.driver_group_hash,
            "background_source": one.background_source,
            "background_seed": one.background_seed,
            "background_rows": one.background_rows,
            "coalitions": one.coalitions,
            "rule_flags": [flag.as_row() for flag in self.rule_flags],
            "governing_rule_action": self.governing_rule_action,
            "groups": self._driver_rows(),
            "peak_hour_groups": self._peak_rows(),
        }


@dataclass(frozen=True)
class AttributionPublication:
    """One lane, one target date: every subsystem's explanation of it.

    The publication instant is the **gate**, exactly as the forecast's is, and it
    is passed in rather than computed: an attribution is published with the
    forecast it explains, and a request-time stamp would make the origin a lie.
    """

    lane: str
    feature_set: str
    gate_profile: str
    artifact_id: str
    target_date: date
    #: ``gate_at(target_date, gate_profile)``, off the feature rows.
    published_at: datetime
    threshold_mw: float
    #: The regime that composed the expectation these bars decompose.
    correction_regime: str
    rows: tuple[AttributionRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise AttributionPublicationError(
                f"{self.lane} {self.target_date.isoformat()}: a publication with no "
                "attribution is not one. An absence is refused rather than written "
                "as an empty explanation"
            )
        seen: set[Subsystem] = set()
        for row in self.rows:
            if row.target_date != self.target_date:
                raise AttributionPublicationError(
                    f"{self.lane}: an attribution of {row.target_date.isoformat()} "
                    f"arrived in a publication of {self.target_date.isoformat()}"
                )
            if row.subsystem in seen:
                raise AttributionPublicationError(
                    f"{self.lane}: {row.subsystem!r} appears twice, and one "
                    "subsystem-day has one explanation"
                )
            seen.add(row.subsystem)

    @property
    def subsystems(self) -> tuple[Subsystem, ...]:
        """The subsystems this publication covers, in canonical order."""
        covered = {row.subsystem for row in self.rows}
        return tuple(code for code in SUBSYSTEM_CODES if code in covered)

    def as_payload(self) -> dict[str, Any]:
        """What crosses the private network to the worker that writes it."""
        return {
            "lane": self.lane,
            "feature_set": self.feature_set,
            "threshold_mw": self.threshold_mw,
            "target_date": self.target_date.isoformat(),
            "correction_regime": self.correction_regime,
            "forecast_origin": {
                "producer": PRODUCER,
                "run_label": self.artifact_id,
                "published_at": self.published_at.isoformat(),
                "origin_kind": SERVED_ORIGIN_KIND,
                "gate_profile": self.gate_profile,
            },
            "subsystems": list(self.subsystems),
            "attributions": [row.as_row() for row in self.rows],
        }


def build_attribution_publication(
    rows: Sequence[AttributionRow],
    *,
    lane: str,
    feature_set: str,
    gate_profile: str,
    artifact_id: str,
    target_date: date,
    published_at: datetime,
    threshold_mw: float,
    correction_regime: str,
) -> AttributionPublication:
    """Assemble one lane's day of attributions into the rows that are persisted.

    There is no arithmetic here. Every figure on the payload was computed by
    :func:`~wattsteer_ml.diagnosis.day_attribution.attribute_day` and is copied,
    which is what makes the stored row *the* attribution rather than a second
    one that agrees with it to within rounding.
    """
    return AttributionPublication(
        lane=lane,
        feature_set=feature_set,
        gate_profile=gate_profile,
        artifact_id=artifact_id,
        target_date=target_date,
        published_at=published_at,
        threshold_mw=threshold_mw,
        correction_regime=correction_regime,
        rows=tuple(rows),
    )
