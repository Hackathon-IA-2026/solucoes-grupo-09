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
from datetime import datetime
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
from wattsteer_ml.replay.scoring import SCORED_ON, ReplayPostureError, ReplayScores


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

    def as_payload(self) -> dict[str, object]:
        return {
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
    _check_the_scenario_is_the_day(wire, scores)
    _check_the_episodes_were_drawn_here(episodes, scores, max_gap_hours)
    rate = brl_per_mwh(wire)
    return {
        "target_date": day.target_date.isoformat(),
        "subsystem": forecast.subsystem,
        "threshold_mw": scores.threshold_mw,
        "max_gap_hours": max_gap_hours,
        "scenario_hash": scenario_hash,
        "integrity": _integrity(scores),
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
        "episodes": [episode.as_payload() for episode in episodes],
        "solver": solver_receipt(scores.plan),
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


def _integrity(scores: ReplayScores) -> dict[str, Any]:
    """Provenance, the artifact's windows, and the vintage caveat's extent.

    ``model_saw_this_day`` is `False` because
    :func:`~wattsteer_ml.replay.calendar.assert_held_out` raised if it were
    otherwise — asserted, never computed hopefully.

    ``revision_premium_recovered_mwh`` is `None` and says so. It is computable
    only once ONS has restated days WattSteer holds both vintages of, and until
    then the largest caveat on the largest part of the replayable window is
    honestly labelled and honestly unquantified. A zero would read as "measured,
    and small".
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
        "vintage_affects": list(VINTAGE_AFFECTS),
        "vintage_exempt": list(VINTAGE_EXEMPT),
        "revision_premium_recovered_mwh": None,
    }


def _check_the_scenario_is_the_day(wire: dict[str, Any], scores: ReplayScores) -> None:
    """The fleet was planned for the day being replayed, on its subsystem.

    The plan came out of the live builder, which reads ``target_date`` off the
    scenario to build the horizon. A scenario naming another day would produce a
    24-hour dispatch indexed against a different civil day — including a
    different daylight-saving shape — and the mismatch would show up as a
    plausible number rather than an error.
    """
    target_date = str(wire.get("target_date", ""))
    if target_date != scores.day.target_date.isoformat():
        raise ReplayPostureError(
            f"the scenario plans {target_date or '(no date)'} and the replay is "
            f"of {scores.day.target_date.isoformat()}"
        )
    subsystem = wire.get("subsystem")
    if subsystem != scores.forecast.subsystem:
        raise ReplayPostureError(
            f"the scenario is {subsystem!r} and the replayed forecast is "
            f"{scores.forecast.subsystem!r}"
        )


def _check_the_episodes_were_drawn_here(
    episodes: Sequence[ReplayEpisode], scores: ReplayScores, max_gap_hours: int
) -> None:
    """Every episode carries the parameters the result carries. Refused if not."""
    for episode in episodes:
        if (
            episode.threshold_mw != scores.threshold_mw
            or episode.max_gap_hours != max_gap_hours
        ):
            raise ReplayPostureError(
                f"an episode drawn at threshold {episode.threshold_mw} MW / gap "
                f"{episode.max_gap_hours} h cannot be rendered beside a replay at "
                f"{scores.threshold_mw} MW / {max_gap_hours} h"
            )


__all__ = [
    "ReplayEpisode",
    "replay_result",
]
