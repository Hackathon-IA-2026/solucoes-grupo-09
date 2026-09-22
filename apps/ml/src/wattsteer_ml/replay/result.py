"""One replay in, one published contract out — the shape `replay.md` fixes.

The counterpart of :mod:`wattsteer_ml.optimizer.result` for a replayed day, and
deliberately the same split: :mod:`wattsteer_ml.replay.scoring` computes the
numbers and refuses the postures that would flatter them, and this module turns
one :class:`~wattsteer_ml.replay.scoring.ReplayScores` into the object the §45/47
screens read. Nothing here computes a KPI. It cannot: every scalar it publishes
is read off a :class:`~wattsteer_ml.optimizer.simulator.ScoredRealisation` the
one simulator produced.

**The three fields that stop this contract being a trap.** ``planning_basis``
says the plan was built on the P50 of the pinned D−1 vintage; ``scored_on`` says
the top-level scalars are evaluated on the **observed** realisation, where an
`OptimizationResult`'s identically-named fields are evaluated on the planning
envelope; ``execution_rule`` says which rule produced the executed series. All
three travel as *data*, so a screen states them by reading rather than by
repeating.

**The headline can only come from the observed realisation.** :func:`_headline`
takes a single ``ScoredRealisation`` and nothing else — it cannot see the
perfect-foresight bound, the P50 column or the plan — so "no headline field is
populated from ``upper_bound``" is a property of the function's signature rather
than a rule somebody remembered. The bound is published under ``upper_bound``,
labelled ``perfect_foresight``, and its only arithmetic use is
``forecast_value_gap_mwh``.

**The denominator is the whole local day.** ``baseline_curtailment_mwh`` is
``Σ_t a[t]``, the observed realisation's own baseline, and the threshold never
enters it: what ``threshold_mw`` does is gate whether ``avoidability`` is defined
at all, and choose which hours are drawn as episodes. Move it and the episodes
move; the percentage does not.

**A day with no forecast gets a different object, not a hollowed-out one.**
:func:`observed_only_result` publishes the pre-F1 view: the settled profile, the
episodes, the perfect-foresight bound and the typed refusal that says why.
``scored``, ``avoided_energy_mwh`` and ``recovered_floor_mwh`` are absent rather
than zero, and they are absent structurally — that function takes an
:class:`~wattsteer_ml.replay.scoring.ObservedOnlyView`, which holds no plan, no
scored realisation and no floor for them to be read from.

**Episodes are carried, not computed.** A `CurtailmentEpisode` is a read-time
view over the settled hours and Postgres already draws it
(``canonical_curtailment_episodes``); re-deriving the run-detection here would
be a second implementation of a published parameterised query, in a language
that cannot see the rows. So they arrive as data and this module's contribution
is the one thing a caller cannot be trusted with: an episode drawn at a
threshold other than the result's is **refused** rather than rendered, because
an episode list beside a threshold that did not produce it is exactly the
unstamped magnitude the domain model's rule 8 exists to prevent.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from wattsteer_ml.constants import MAX_GAP_HOURS
from wattsteer_ml.optimizer import (
    EXECUTION_RULE,
    PLANNING_BASIS,
    ScoredRealisation,
    brl_per_mwh,
    dispatch_payload,
    scored_payload,
    solver_receipt,
)
from wattsteer_ml.replay.calendar import (
    VINTAGE_AFFECTS,
    VINTAGE_EXEMPT,
)
from wattsteer_ml.replay.premium import RevisionPremium, published_premium
from wattsteer_ml.replay.scoring import (
    SCORED_ON,
    ObservedOnlyView,
    ReplayPostureError,
    ReplayScores,
)


@dataclass(frozen=True)
class ReplayEpisode:
    """One run of curtailed hours, with the parameters that drew it.

    Both parameters, on every episode, because a duration or a total without the
    threshold and the gap tolerance that produced it cannot be compared with
    another one. ``ended_at`` is exclusive — the ``valid_time`` of the first hour
    below the threshold — which is the interval convention the whole surface
    uses.
    """

    started_at: datetime
    ended_at: datetime
    duration_hours: int
    total_mwh: float
    peak_mw: float
    threshold_mw: float
    max_gap_hours: int

    def as_payload(self, subsystem: str) -> dict[str, object]:
        """The episode as the shared `CurtailmentEpisode` shape publishes it.

        ``subsystem`` is the replay's own, passed in rather than stored: a
        replay is one subsystem, so an episode read for it cannot be in any
        other. The shape gained the field for the Overview (`40721c1`), where
        one list spans the grid, and a replay that omitted it published
        episodes its own schema refused.
        """
        return {
            "subsystem": subsystem,
            "started_at": self.started_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ended_at": self.ended_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "duration_hours": self.duration_hours,
            "total_mwh": self.total_mwh,
            "peak_mw": self.peak_mw,
            "threshold_mw": self.threshold_mw,
            "max_gap_hours": self.max_gap_hours,
        }


def replay_result(
    wire: dict[str, Any],
    scenario_hash: str,
    scores: ReplayScores,
    *,
    episodes: Sequence[ReplayEpisode] = (),
    max_gap_hours: int = MAX_GAP_HOURS,
    premium: RevisionPremium | None = None,
) -> dict[str, Any]:
    """The published contract for one replayed day.

    ``scores`` has already refused every posture that would flatter the numbers
    — it cannot exist otherwise — so what is left here is assembly, plus the two
    checks that belong to the *published* object rather than to the arithmetic:
    the scenario describes the day being replayed, and every episode was drawn
    at the parameters the result carries.
    """
    day = scores.day
    forecast = scores.forecast
    observed = scores.observed_scoring
    _check_the_scenario_is_the_day(
        wire, target_date=day.target_date, subsystem=forecast.subsystem
    )
    _check_the_episodes_were_drawn_here(
        episodes, threshold_mw=scores.threshold_mw, max_gap_hours=max_gap_hours
    )
    rate = brl_per_mwh(wire)
    return {
        "target_date": day.target_date.isoformat(),
        "subsystem": forecast.subsystem,
        "threshold_mw": scores.threshold_mw,
        "max_gap_hours": max_gap_hours,
        "scenario_hash": scenario_hash,
        "integrity": _integrity(scores, premium),
        # Top level, exactly as in `OptimizationResult`: a field whose whole
        # purpose is that shared names do not shift meaning must not shift
        # position either. The vintage *detail* under `integrity` is
        # replay-only; the verdict is not.
        "vintage_fidelity": day.vintage_fidelity,
        "forecast_origin": forecast.origin.as_payload(),
        "actual": scores.observed.as_payload(),
        "forecast": forecast.as_payload(),
        "planning_basis": PLANNING_BASIS,
        "execution_rule": EXECUTION_RULE,
        # ← the top-level scalars below are on the ACTUAL, not on the envelope.
        "scored_on": SCORED_ON,
        **_headline(observed),
        # What was promised at D−1, what happened, and by how much.
        "recovered_floor_mwh": scores.recovered_floor_mwh,
        "floor_met": scores.floor_met,
        "floor_margin_mwh": scores.floor_margin_mwh,
        "scored": {
            "p10": scored_payload(scores.band.p10),
            "p50": scored_payload(scores.band.p50),
            "p90": scored_payload(scores.band.p90),
            SCORED_ON: scored_payload(observed),
        },
        "upper_bound": scores.upper_bound.as_payload(),
        # Two series and never one: the plan, and what the execution rule did
        # against the day. They are equal only where the realisation equals the
        # planning basis.
        "dispatch": dispatch_payload(scores.plan.hours),
        "executed": dispatch_payload(observed.hours),
        # Executed, like everything else at this level: "recovered" is not
        # "delivered", and some of the absorbed energy is still in the fleet at
        # midnight or did not survive the round trip.
        "stored_at_horizon_end_mwh": observed.stored_at_horizon_end_mwh,
        "round_trip_loss_mwh": observed.round_trip_loss_mwh,
        "economic_scenario": {
            "brl_per_mwh": rate,
            "brl": observed.recovered_mwh * rate,
        },
        "episodes": [episode.as_payload(forecast.subsystem) for episode in episodes],
        "solver": solver_receipt(scores.plan),
    }


def observed_only_result(
    wire: dict[str, Any],
    scenario_hash: str,
    view: ObservedOnlyView,
    *,
    episodes: Sequence[ReplayEpisode] = (),
    max_gap_hours: int = MAX_GAP_HOURS,
) -> dict[str, Any]:
    """The published contract for a day no honest forecast exists for.

    The settled profile, the episodes at the threshold in force, the
    perfect-foresight bound — and the refusal that says why, as a typed code the
    screen renders one sentence from rather than a message this service wrote.

    **What is not here is the point.** ``scored``, ``avoided_energy_mwh`` and
    ``recovered_floor_mwh`` are *absent*, not zero: a zero would be a claim
    about a plan, and on this day WattSteer made none. That absence is
    structural in the same way the headline's fence is —
    :class:`~wattsteer_ml.replay.scoring.ObservedOnlyView` holds no plan, no
    scored realisation and no floor, and :func:`_headline` is not reachable from
    here because there is no ``ScoredRealisation`` to hand it. There is no
    ``dispatch`` and no ``solver`` receipt either: the bound's plan is a
    hindsight solve and publishing its schedule would be publishing a plan
    WattSteer could not have built.
    """
    day = view.day
    # Unreachable: `ObservedOnlyView` refuses a day without one. Narrowed rather
    # than asserted so that the type checker reads the same guarantee.
    if day.refusal is None:  # pragma: no cover
        raise ReplayPostureError("an observed-only day carries the refusal that says why")
    _check_the_scenario_is_the_day(
        wire, target_date=day.target_date, subsystem=view.observed.subsystem
    )
    _check_the_episodes_were_drawn_here(
        episodes, threshold_mw=view.threshold_mw, max_gap_hours=max_gap_hours
    )
    return {
        "target_date": day.target_date.isoformat(),
        "subsystem": view.observed.subsystem,
        "threshold_mw": view.threshold_mw,
        "max_gap_hours": max_gap_hours,
        "scenario_hash": scenario_hash,
        # `false`, and the refusal beside it: the boundary is legible rather
        # than arbitrary, and the client renders `t("error." + code)`.
        "replayable": False,
        "refusal": day.refusal.as_payload(),
        # The vintage verdict travels on a refused day too. "This day cannot be
        # replayed" and "its actuals would have been a restatement" are two
        # facts, and `replay.md` keeps them apart.
        "vintage_fidelity": day.vintage_fidelity,
        "actual": view.observed.as_payload(),
        # A property of the day and the fleet, with nothing of WattSteer's
        # beside it to compare against — so no `forecast_value_gap_mwh`.
        "upper_bound": view.upper_bound.as_payload(),
        "episodes": [episode.as_payload(view.observed.subsystem) for episode in episodes],
    }


def _headline(observed: ScoredRealisation) -> dict[str, Any]:
    """The four top-level scalars, from the observed realisation and nowhere else.

    One argument, and it is the realisation the headline is scored on. That is
    the fence: perfect foresight, the P50 column and the MILP's own objective
    are all unreachable from inside this function, so ``avoided_energy_mwh``
    cannot be populated from a hindsight number by any edit that does not first
    widen this signature.

    "Avoided", "recovered" and "absorbed" are one quantity with three names, and
    the screen renders one headline for it. ``avoidability`` is `None` — never
    zero — on a day where no hour reaches the threshold.
    """
    return {
        "baseline_curtailment_mwh": observed.baseline_mwh,
        "optimized_curtailment_mwh": observed.remaining_mwh,
        "avoided_energy_mwh": observed.recovered_mwh,
        "avoidability": observed.avoidability,
    }


def _integrity(
    scores: ReplayScores, premium: RevisionPremium | None = None
) -> dict[str, Any]:
    """The two honesty axes, side by side, and the extent of the second one.

    ``model_saw_this_day`` is `False` because
    :func:`~wattsteer_ml.replay.calendar.assert_held_out` raised if it were
    otherwise — asserted, never computed hopefully.

    **``provenance`` and ``vintage_fidelity`` are two fields and neither is
    derived from the other.** The first is the *model's* information set and is
    fixed by choosing the artifact; the second is the *data's* and is fixed by
    when WattSteer started watching. Today every `fold_holdout` day is also
    `revision_optimistic`, so one merged badge would be indistinguishable from
    the right answer — right up to the moment a post-go-live quarter is held
    out, at which point it would be wrong and would be discovered by a user.
    The verdict here is :attr:`~wattsteer_ml.replay.calendar.ReplayDay.
    vintage_fidelity`, read off the day the calendar judged; nothing in this
    module recomputes it and nothing consults ``provenance`` to reach it.

    It appears twice in the contract on purpose: at the top level, where an
    `OptimizationResult` also carries it and a shared name must not shift
    position, and here beside ``provenance``, where the two axes are read
    against each other. One value, one source, two places a reader looks.

    ``revision_premium_recovered_mwh`` is the measured size of the second
    caveat, or `None`. It is computable only once ONS has restated days
    WattSteer holds both vintages of, and until then the largest caveat on the
    largest part of the replayable window is honestly labelled and honestly
    unquantified — the screen says **unmeasured**, in that word. A zero would
    read as "measured, and small", which is why
    :func:`~wattsteer_ml.replay.premium.published_premium` is what turns the
    absence into `null` and there is no arithmetic here that could produce a
    ``0.0`` in its place.
    """
    held_out_by = scores.day.held_out_by
    # Unreachable: `ReplayScores` refuses a day without one. Narrowed rather
    # than asserted so that the type checker reads the same guarantee.
    if held_out_by is None:  # pragma: no cover
        raise ReplayPostureError("a replayable day carries the artifact that held it out")
    return {
        "provenance": scores.day.provenance,
        "model_saw_this_day": False,
        "held_out_by": held_out_by.as_payload(),
        "vintage_fidelity": scores.day.vintage_fidelity,
        "vintage_affects": list(VINTAGE_AFFECTS),
        "vintage_exempt": list(VINTAGE_EXEMPT),
        "revision_premium_recovered_mwh": published_premium(premium),
    }


def _check_the_scenario_is_the_day(
    wire: dict[str, Any], *, target_date: date, subsystem: str
) -> None:
    """The fleet was planned for the day being replayed, on its subsystem.

    The plan came out of the live builder, which reads ``target_date`` off the
    scenario to build the horizon. A scenario naming another day would produce a
    24-hour dispatch indexed against a different civil day — including a
    different daylight-saving shape — and the mismatch would show up as a
    plausible number rather than an error.
    """
    planned = str(wire.get("target_date", ""))
    if planned != target_date.isoformat():
        raise ReplayPostureError(
            f"the scenario plans {planned or '(no date)'} and the replay is "
            f"of {target_date.isoformat()}"
        )
    planned_subsystem = wire.get("subsystem")
    if planned_subsystem != subsystem:
        raise ReplayPostureError(
            f"the scenario is {planned_subsystem!r} and the replayed day is {subsystem!r}"
        )


def _check_the_episodes_were_drawn_here(
    episodes: Sequence[ReplayEpisode], *, threshold_mw: float, max_gap_hours: int
) -> None:
    """Every episode carries the parameters the result carries. Refused if not."""
    for episode in episodes:
        if episode.threshold_mw != threshold_mw or episode.max_gap_hours != max_gap_hours:
            raise ReplayPostureError(
                f"an episode drawn at threshold {episode.threshold_mw} MW / gap "
                f"{episode.max_gap_hours} h cannot be rendered beside a replay at "
                f"{threshold_mw} MW / {max_gap_hours} h"
            )


__all__ = [
    "ReplayEpisode",
    "observed_only_result",
    "replay_result",
]
