"""What a rule is allowed to see: scalars, codes and dates. Never a `Φ`.

`docs/specs/diagnosis.md`, "Domain rules — the arbitration mechanism now, most
of the content later", and seam 8. A rule is a predicate over
``(feature_row, composed_forecast, attribution, recent_observations)`` — and
this module is the boundary those four cross to reach one.

**This is the half of the valve nothing else can restore.** The rules module
cannot change a number because it is never handed one it could change: what
:func:`build_rule_context` produces is a frozen projection carrying *floats,
ints, bools, codes and a date*, and no reference to the
:class:`~wattsteer_ml.diagnosis.day_attribution.DayAttribution` those figures
were read off, to a contribution, to a background or to a design matrix. A rule
holding only a copy of ``Σ_j |Φ_j|`` has nothing to write to; the published
attribution is a different object in a different module, and the payload copies
its numbers from *that* one. That is why the valve is structural here rather
than a convention the next session is asked to respect — and
:mod:`wattsteer_ml.diagnosis.rules` is checked, as an AST walk, for never
naming an attribution type at all.

**Every field has a stated provenance** (:data:`FIELD_PROVENANCE`), because the
spec admits a rule only when "every quantity in its predicate is an ingested
column or an artifact field". A field with no provenance is an invented input,
which is the same failure as an invented constant one level down, and the test
that walks this mapping is what makes the admission rule checkable rather than
aspirational.

Two derivations happen here rather than in a rule, and both are stated:

- **The day's weather condition is the day's worst hour.** ``run_age`` is the
  maximum over the 24 rows and ``centroid_coverage`` the minimum, because
  "the model was reading a stale run" is true of the day if it is true of an
  hour of it, and the conservative direction is the one that says so.
- **A NULL is a NaN.** :mod:`wattsteer_ml.training.design` fills an absent
  feature with ``np.nan`` — LightGBM reads NULL natively — so "the headline
  feature is NULL at serve time" is read here as "NaN in any of the day's 24
  rows", and only for the groups the display cut actually selected.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from datetime import date
from typing import Literal

import numpy as np
import numpy.typing as npt

from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.diagnosis.day_attribution import DayAttribution
from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_MAP,
    DriverGroupMap,
    GroupCode,
)
from wattsteer_ml.evaluation import HOURS_PER_DAY

#: ``RestrictionCause.reason``, verbatim from `docs/domain-model.md` §4. The
#: code is the identifier; the English gloss is UI copy and appears nowhere
#: here. Spelt in this module rather than in :mod:`wattsteer_ml.constants`
#: because nothing on the modelling side has needed the reason vocabulary
#: before now.
ReasonCode = Literal["REL", "CNF", "ENE", "PAR"]

REASON_CODES: tuple[ReasonCode, ...] = ("REL", "CNF", "ENE", "PAR")

#: External (grid) unavailability — and **not** "relaxamento"
#: (`docs/domain-model.md` §4). The one reason the forecaster ruled out
#: modelling, on the ground that no ingested dataset carries transmission
#: availability, which is why a day dominated by it is a day the model is
#: explaining a mechanism it structurally cannot see.
UNMODELLED_REASON: ReasonCode = "REL"

#: The two pipeline-condition columns ``stale_inputs`` reads, named here so the
#: rule quotes a constant rather than a string literal. Both are in the
#: artifact's ordered feature list and both belong to ``data_conditions``.
WEATHER_RUN_AGE_FEATURE = "weather_run_age_hours"
WEATHER_CENTROID_COVERAGE_FEATURE = "weather_centroid_coverage"

#: Where each :class:`RuleContext` field came from. The spec's admission rule
#: for any future rule is that "every quantity in its predicate is an ingested
#: column or an artifact field"; this is that sentence made checkable. ``key``
#: is the pair that identifies the day and is not a quantity a predicate
#: compares.
Provenance = Literal["key", "artifact", "forecast", "attribution", "observation"]

FIELD_PROVENANCE: Mapping[str, Provenance] = {
    "subsystem": "key",
    "target_date": "key",
    "lowest_risk_bin_edge": "artifact",
    "day_occurrence_probability": "forecast",
    "hours_p50_nonzero": "forecast",
    "sum_abs_attributed_mwh": "attribution",
    "attribution_stderr_mwh": "attribution",
    "ranking_is_noise": "attribution",
    "notable_groups": "attribution",
    "weather_run_age_hours": "observation",
    "weather_centroid_coverage": "observation",
    "null_headline_features": "observation",
    "recent_reasons": "observation",
}


class RuleContextError(ValueError):
    """The four inputs a rule reads cannot be projected into one context."""


@dataclass(frozen=True)
class ReasonMix:
    """The reported reasons on the most recent settled day, as shares of MWh.

    ``RestrictionCause`` is ONS's own **reported** reason and this product
    displays it as evidence; reading it here makes no causal claim and none is
    permitted downstream (`docs/domain-model.md` §10). The shares are of
    constrained-off MWh on one settled ``(subsystem, date)``.
    """

    settled_date: date
    shares: Mapping[ReasonCode, float]

    def __post_init__(self) -> None:
        for code, share in self.shares.items():
            if code not in REASON_CODES:
                raise RuleContextError(f"{code!r} is not a ReasonCode")
            if not math.isfinite(share) or share < 0.0:
                raise RuleContextError(f"{code} carries the share {share!r}")

    @property
    def top_reason(self) -> ReasonCode | None:
        """The largest share, or ``None`` when the day names no single reason.

        Ties do not resolve: two reasons sharing the largest share means no one
        reason accounts for the largest share of the day, and a rule that fired
        on the alphabetically luckier of them would report a coin toss as a
        finding.
        """
        if not self.shares:
            return None
        largest = max(self.shares.values())
        winners = [code for code, share in self.shares.items() if share == largest]
        if len(winners) != 1 or largest <= 0.0:
            return None
        return winners[0]

    @property
    def top_reason_share(self) -> float | None:
        top = self.top_reason
        return None if top is None else self.shares[top]


def reason_mixes_from_payload(
    payload: object,
) -> dict[Subsystem, ReasonMix]:
    """Read the ``recent_reasons`` block of a publication request.

    **The wire half of the read the gateway performs.** ``recent_reasons`` is an
    *observation*, and the worker is what reads it: ``reason-mix.ts`` resolves
    the most recent settled Brasília day per subsystem, cut at
    ``actuals_cutoff(target_date, gate_profile, 'restricao-coff')`` so the rule
    cannot see ONS rows that had not been published when the forecast was made,
    and puts the shares on the request to ``POST /internal/publish/diagnosis``.
    This function turns that block into the :class:`ReasonMix` values
    :func:`build_rule_context` already takes.

    It is read here rather than queried here for the reason the forecast rows
    are written by the worker and not by this service: one producer per
    quantity. A second read of the same series at a second instant would be a
    second producer of the same ratio, under a different vintage axis, with
    nothing saying which of the two the screen was showing.

    Shape::

        {"NE": {"settled_date": "2026-03-02",
                "shares": {"REL": 0.62, "ENE": 0.38}}}

    **An absent subsystem is absent.** It is not defaulted to an empty mix:
    ``RuleContext.recent_reasons`` is ``None`` in that case and
    ``unmodelled_outage_regime`` does not fire, which is the honest outcome.
    "Nothing was restricted" and "we cannot see that day yet" must not be the
    same input to a rule that annotates the screen, and a mix of zero shares
    would make them one.

    Args:
        payload: the request's ``recent_reasons`` value. ``None`` and ``{}``
            both mean "no subsystem has one", which is legal.

    Returns:
        The mixes, by subsystem code.

    Raises:
        RuleContextError: if the block is not a mapping, names something that is
            not a subsystem, or carries a mix without a settled date. A
            malformed block is refused rather than dropped, because a dropped
            one is indistinguishable from a genuinely absent day and would turn
            a bug into a rule that quietly stops firing.
    """
    if payload is None:
        return {}
    if not isinstance(payload, Mapping):
        raise RuleContextError(
            f"recent_reasons is {type(payload).__name__} and not a mapping of "
            "subsystem to reason mix"
        )
    mixes: dict[Subsystem, ReasonMix] = {}
    for code, raw in payload.items():
        if code not in SUBSYSTEM_CODES:
            raise RuleContextError(
                f"recent_reasons names {code!r}, which is not a subsystem. The "
                f"four are {', '.join(SUBSYSTEM_CODES)}, and SIN is not one of them"
            )
        if not isinstance(raw, Mapping):
            raise RuleContextError(f"recent_reasons[{code!r}] is not a reason mix")
        settled = raw.get("settled_date")
        if not isinstance(settled, str):
            raise RuleContextError(
                f"recent_reasons[{code!r}] carries no settled_date; a reason mix "
                "is the mix of one named day and a mix with no day is a number "
                "with nothing to attach it to"
            )
        try:
            settled_date = date.fromisoformat(settled)
        except ValueError as error:
            raise RuleContextError(
                f"recent_reasons[{code!r}].settled_date is {settled!r}"
            ) from error
        shares = raw.get("shares")
        if not isinstance(shares, Mapping):
            raise RuleContextError(f"recent_reasons[{code!r}] carries no shares")
        # `ReasonMix.__post_init__` is the authority on the codes and the
        # values: an unknown reason and a negative share are refused there, and
        # refusing them twice in two vocabularies is how the two drift apart.
        mixes[code] = ReasonMix(
            settled_date=settled_date,
            shares={str(reason): float(share) for reason, share in shares.items()},  # type: ignore[misc]
        )
    return mixes


@dataclass(frozen=True)
class RuleContext:
    """The whole world a rule may read. Copies, never handles.

    Nothing on this type refers back to the object it was projected from, so a
    rule cannot reach a published number even by accident — which is the
    property that makes "no rule may change a number" true of the code rather
    than of the intent behind it.
    """

    subsystem: Subsystem
    target_date: date
    #: ``risk_bins["low"][1]`` — the boundary between ``low`` and ``elevated``,
    #: and the lowest **edge** the artifact publishes. ``low[0]`` is ``0`` and
    #: is the domain's bound rather than a measured edge, so "below the lowest
    #: risk-bin edge" cannot mean it: no probability is below zero and a rule
    #: reading it would never fire.
    lowest_risk_bin_edge: float
    #: The path ensemble's day-grain probability, not a per-hour output.
    day_occurrence_probability: float
    #: A **count** of hours whose composed P50 is non-zero — never an
    #: arithmetic on their bands.
    hours_p50_nonzero: int
    sum_abs_attributed_mwh: float
    attribution_stderr_mwh: float
    #: ``Σ_j |Φ_j| ≤ 2 × attribution_stderr_mwh``, decided next to the two
    #: numbers it compares by ``DayAttribution.ranking_is_noise`` and copied
    #: here as a fact. The ``2`` is the spec's and lives there; no rule holds
    #: it.
    ranking_is_noise: bool
    #: The groups the display cut selected — ``share ≥ 0.03``, top six. The
    #: predicate is shared with the client; nothing here merges or drops a bar.
    notable_groups: tuple[GroupCode, ...]
    #: The day's worst hour on each pipeline condition. ``None`` when the
    #: column was NULL across the whole day, which is itself a degradation and
    #: is reported as one rather than as a zero.
    weather_run_age_hours: float | None
    weather_centroid_coverage: float | None
    #: Headline features of **notable** groups that were NULL for at least one
    #: of the day's 24 rows.
    null_headline_features: tuple[str, ...]
    #: The most recent settled day's reported reason mix, when one was read.
    #: ``None`` means it was not available — an absence, and never something a
    #: rule fires on.
    recent_reasons: ReasonMix | None

    def __post_init__(self) -> None:
        if not 0.0 <= self.day_occurrence_probability <= 1.0:
            raise RuleContextError(
                f"{self.day_occurrence_probability!r} is not a probability"
            )
        if not 0.0 <= self.lowest_risk_bin_edge <= 1.0:
            raise RuleContextError(
                f"the lowest risk-bin edge is {self.lowest_risk_bin_edge!r}"
            )
        if not 0 <= self.hours_p50_nonzero <= HOURS_PER_DAY:
            raise RuleContextError(
                f"{self.hours_p50_nonzero!r} hours of a {HOURS_PER_DAY}-hour day "
                "carry a non-zero P50"
            )
        for name in ("sum_abs_attributed_mwh", "attribution_stderr_mwh"):
            value: float = getattr(self, name)
            if not math.isfinite(value) or value < 0.0:
                raise RuleContextError(f"{name} is {value!r}")


def _column(names: Sequence[str], feature: str) -> int:
    try:
        return list(names).index(feature)
    except ValueError as error:
        raise RuleContextError(
            f"{feature!r} is not in the artifact's feature contract; the rule "
            "that reads it would silently never fire"
        ) from error


def _worst_hour(
    rows: npt.NDArray[np.float64], column: int, *, take: Literal["max", "min"]
) -> float | None:
    """The day's worst hour on one column, or ``None`` if every hour is NULL."""
    values = rows[:, column]
    present = values[~np.isnan(values)]
    if present.size == 0:
        return None
    return float(np.max(present) if take == "max" else np.min(present))


def build_rule_context(
    attribution: DayAttribution,
    *,
    target_rows: npt.NDArray[np.float64],
    feature_names: Sequence[str],
    risk_bins: Mapping[str, tuple[float, float]],
    day_occurrence_probability: float,
    hours_p50_nonzero: int,
    recent_reasons: ReasonMix | None = None,
    group_map: DriverGroupMap = DRIVER_GROUP_MAP,
) -> RuleContext:
    """Project the four inputs a rule reads into the only shape a rule sees.

    Args:
        attribution: the day whose narration the rules will govern. Read here
            and **not** carried onto the context: a rule holding it could reach
            a ``Φ``.
        target_rows: the day's 24 feature rows, in local-hour order, encoded
            under ``feature_names``.
        feature_names: the artifact's feature contract, in order — normally
            ``MatchedBackground.feature_names``.
        risk_bins: the artifact's published class edges,
            ``{"low": (0, e1), "elevated": (e1, e2), "high": (e2, 1)}``.
        day_occurrence_probability: the path ensemble's day-grain probability.
        hours_p50_nonzero: the composed day row's count of non-zero P50 hours.
        recent_reasons: the most recent settled day's reported reason mix, or
            ``None`` when it was not read.
        group_map: the map the attribution was computed under.

    Raises:
        RuleContextError: if the rows are not one whole day under the contract
            the names describe, or the artifact publishes no ``low`` bin.
    """
    if target_rows.ndim != 2 or target_rows.shape[0] != HOURS_PER_DAY:
        raise RuleContextError(
            "a rule context is one Brasília civil day; got rows of shape "
            f"{target_rows.shape}"
        )
    if target_rows.shape[1] != len(feature_names):
        raise RuleContextError(
            f"the rows are {target_rows.shape[1]} columns wide and the contract "
            f"names {len(feature_names)}"
        )
    low = risk_bins.get("low")
    if low is None or len(low) != 2:
        raise RuleContextError(
            "the artifact publishes no `low` risk bin, so there is no lowest "
            "edge to be below"
        )

    notable = tuple(one.code for one in attribution.notable())
    null_headlines: list[str] = []
    for code in notable:
        feature = group_map.group(code).headline_feature
        column = _column(feature_names, feature)
        if bool(np.isnan(target_rows[:, column]).any()):
            null_headlines.append(feature)

    return RuleContext(
        subsystem=attribution.subsystem,
        target_date=attribution.target_date,
        lowest_risk_bin_edge=float(low[1]),
        day_occurrence_probability=float(day_occurrence_probability),
        hours_p50_nonzero=int(hours_p50_nonzero),
        sum_abs_attributed_mwh=attribution.sum_abs_attributed_mwh,
        attribution_stderr_mwh=attribution.attribution_stderr_mwh,
        ranking_is_noise=attribution.ranking_is_noise,
        notable_groups=notable,
        weather_run_age_hours=_worst_hour(
            target_rows, _column(feature_names, WEATHER_RUN_AGE_FEATURE), take="max"
        ),
        weather_centroid_coverage=_worst_hour(
            target_rows,
            _column(feature_names, WEATHER_CENTROID_COVERAGE_FEATURE),
            take="min",
        ),
        null_headline_features=tuple(null_headlines),
        recent_reasons=recent_reasons,
    )


def context_field_names() -> tuple[str, ...]:
    """Every field a predicate may read. The provenance test walks this."""
    return tuple(one.name for one in fields(RuleContext))
