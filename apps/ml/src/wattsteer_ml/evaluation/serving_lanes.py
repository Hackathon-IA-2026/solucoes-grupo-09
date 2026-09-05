"""The two served lanes — the morning view and the evening view — run apart.

`docs/specs/forecaster.md`, "And the third option, which dissolves the trade":

    Serve two artifacts: A-full at ``gate_early``, published ~09:00, and the
    winner of (A-full, B-common) at ``gate_late``, published ~19:00 and
    superseding it.

The eleven hours of operator notice are only a cost if the evening artifact
*replaces* the morning one, and it does not have to. The bitemporal design
already treats a later forecast for the same valid hours as a newer vintage, so
the second lane needs no special case anywhere it is read — only somewhere it is
*trained and gated*, which is here.

**The one property this module exists for: the lanes are independent.**
:func:`run_serving_lanes` runs the gate once per lane, and a lane that refuses,
raises, or produces no candidate at all cannot stop the other from promoting.
That is not a convenience. The morning view is the fallback that makes a wrong
DESSEM call recoverable rather than a product regression, and a driver that
aborted the batch on the first failure would take the fallback down with the
thing it is the fallback for. So every per-lane failure is caught, named, and
carried in the report — including
:class:`~wattsteer_ml.evaluation.gate.ContractDriftError`, which the gate raises
*after* recording its refusal, so the refusal is on the volume before this
module ever sees the exception.

**They are not two tunings of one experiment.** The early lane has weather,
calendar, capacity and lagged actuals, and no day-ahead programme and no
residual load: `docs/specs/feature-engineering.md` fixes the programme's
publication at D−1 15:00 BRT, six hours after the 09:00 gate, so twelve of set
A's seventy-eight model inputs are structurally NULL there and nobody repaired
it. Every outcome in the report therefore carries its lane's
:class:`~wattsteer_ml.admissibility.LaneVector`, and the report's own
:meth:`ServingLanesReport.contrast` is the only way to get the two lanes'
outcomes side by side — so a reader who reaches for a comparison gets the census
that says the comparison is not one.

**What the shapes here make unrepresentable:**

- **A batch that stopped early.** :class:`ServingLanesReport` is checked to
  carry one outcome per lane it was asked about. A run that abandoned a lane
  cannot be reported as a run of both.
- **An outcome without its evidence.** Each of the four outcomes carries
  exactly the thing that produced it — a decision, a :class:`NoCandidate`, or a
  failure in prose — and the constructor refuses the other three being present.
- **A lane's census going missing.** :class:`LaneOutcome` requires it, and it
  is derived from the lane rather than supplied, so it cannot describe a
  different lane from the one it is filed under.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from wattsteer_ml.admissibility import (
    EARLY_GATE,
    LATE_GATE,
    LaneContrast,
    LaneVector,
    lane_vector,
)
from wattsteer_ml.constants import SUBSYSTEM_THRESHOLD_MW
from wattsteer_ml.evaluation.gate import GateDecision, NoCandidate
from wattsteer_ml.lanes import Lane, format_instant

#: v1's feature set on both lanes. ``dessem_augmented_v1`` competes only for the
#: evening view and only once its two decision folds say so
#: (`docs/specs/forecaster.md`, "The DESSEM A/B"); until then the served lanes
#: are one feature set at two gates, which is exactly the shape that makes the
#: DESSEM question a question about the evening view alone.
SERVED_FEATURE_SET = "dessem_free_v1"

#: The morning view. Published ~09:00 BRT, on the D−1 00Z weather run.
EARLY_LANE = Lane(
    feature_set=SERVED_FEATURE_SET,
    gate_profile=EARLY_GATE,
    threshold_mw=SUBSYSTEM_THRESHOLD_MW,
)

#: The evening view. Published ~19:00 BRT on the D−1 12Z run, superseding the
#: morning one as a newer vintage of the same valid hours.
LATE_LANE = Lane(
    feature_set=SERVED_FEATURE_SET,
    gate_profile=LATE_GATE,
    threshold_mw=SUBSYSTEM_THRESHOLD_MW,
)

#: The two, in the order a civil day publishes them. The threshold sweep's 1 MW
#: and 10 MW lanes are lanes in their own right and are deliberately absent:
#: `docs/specs/forecaster.md` promotes only the 5 MW lane for serving, and a
#: retrain driver that walked every lane on the volume would gate three
#: artifacts nobody serves.
SERVING_LANES: tuple[Lane, ...] = (EARLY_LANE, LATE_LANE)

#: What one lane's turn produced.
#:
#: ``promoted`` and ``refused`` are the gate's two decisions. ``no_candidate``
#: is a retrain that produced no artifact for the gate to decide about
#: (:class:`~wattsteer_ml.evaluation.gate.NoCandidate`) — the log is untouched
#: and the incumbent goes on serving. ``failed`` is everything else: the lane
#: raised, and the *other* lane still ran.
LaneStatus = Literal["promoted", "refused", "no_candidate", "failed"]


class ServingLanesError(RuntimeError):
    """The batch is not a batch: a lane is missing, doubled, or unnamed."""


@dataclass(frozen=True)
class LaneOutcome:
    """One lane's turn, and the evidence for how it went."""

    lane: Lane
    #: What this lane's gate profile lets it see. Derived from the lane by
    #: :meth:`of`, never supplied.
    vector: LaneVector
    status: LaneStatus
    decision: GateDecision | None = None
    no_candidate: NoCandidate | None = None
    #: The exception, as ``TypeName: message``. Set only when ``failed``.
    failure: str | None = None

    def __post_init__(self) -> None:
        present = {
            "decision": self.decision is not None,
            "no_candidate": self.no_candidate is not None,
            "failure": self.failure is not None,
        }
        expected = {
            "promoted": "decision",
            "refused": "decision",
            "no_candidate": "no_candidate",
            "failed": "failure",
        }[self.status]
        carried = sorted(name for name, held in present.items() if held)
        if carried != [expected]:
            raise ServingLanesError(
                f"{self.lane}: a {self.status!r} outcome carries {expected!r} and "
                f"nothing else, and this one carries {carried}"
            )
        if self.decision is not None and self.decision.lane != self.lane:
            raise ServingLanesError(
                f"{self.lane}: the decision filed here is about {self.decision.lane}"
            )
        if self.vector.gate_profile != self.lane.gate_profile:
            raise ServingLanesError(
                f"{self.lane}: the census filed here is for {self.vector.gate_profile}"
            )

    @classmethod
    def of(cls, lane: Lane, outcome: GateDecision | NoCandidate) -> LaneOutcome:
        """The outcome of a gate run that returned rather than raised."""
        if isinstance(outcome, NoCandidate):
            return cls(
                lane=lane,
                vector=lane_vector(lane),
                status="no_candidate",
                no_candidate=outcome,
            )
        return cls(
            lane=lane,
            vector=lane_vector(lane),
            status="promoted" if outcome.promotes else "refused",
            decision=outcome,
        )

    @classmethod
    def raised(cls, lane: Lane, error: BaseException) -> LaneOutcome:
        """The outcome of a gate run that raised. The other lane still runs."""
        return cls(
            lane=lane,
            vector=lane_vector(lane),
            status="failed",
            failure=f"{type(error).__name__}: {error}",
        )

    @property
    def promotes(self) -> bool:
        return self.status == "promoted"

    @property
    def artifact_id(self) -> str | None:
        """The artifact this lane may serve after its turn, if it promoted one.

        ``None`` for the other three, and deliberately not "the incumbent's id":
        this module ran a gate, and what the lane serves afterwards is
        :func:`wattsteer_ml.artifacts.current`'s answer, read from the promotion
        log rather than remembered here.
        """
        if self.decision is None or not self.promotes:
            return None
        return self.decision.artifact_id

    def as_dict(self) -> dict[str, Any]:
        return {
            "lane": self.lane.directory_name,
            "gate_profile": self.lane.gate_profile,
            "status": self.status,
            "artifact_id": self.artifact_id,
            "reason": _reason(self),
            "experiment": self.vector.card_fields(),
        }


@dataclass(frozen=True)
class ServingLanesReport:
    """Both lanes' turns, and the contrast that keeps them legible."""

    at: datetime
    outcomes: tuple[LaneOutcome, ...]

    def __post_init__(self) -> None:
        if not self.outcomes:
            raise ServingLanesError("a report over no lane is not a report")
        lanes = [outcome.lane for outcome in self.outcomes]
        if len(set(lanes)) != len(lanes):
            raise ServingLanesError(
                f"a lane took two turns in one run: {[str(lane) for lane in lanes]}"
            )

    def for_lane(self, lane: Lane) -> LaneOutcome:
        for outcome in self.outcomes:
            if outcome.lane == lane:
                return outcome
        raise ServingLanesError(f"{lane} did not take a turn in this run")

    @property
    def promoted(self) -> tuple[Lane, ...]:
        return tuple(outcome.lane for outcome in self.outcomes if outcome.promotes)

    def contrast(self) -> LaneContrast:
        """The two lanes' censuses, held together. The only way to get both.

        Raises when the run did not hold exactly one early lane and one late
        one — a contrast is between two gate profiles, and a report of one lane
        has nothing to contrast it with.
        """
        by_gate = {outcome.lane.gate_profile: outcome.vector for outcome in self.outcomes}
        missing = sorted({EARLY_GATE, LATE_GATE} - set(by_gate))
        if missing:
            raise ServingLanesError(
                f"a contrast needs both gate profiles and this run has no {missing} lane"
            )
        return LaneContrast(early=by_gate[EARLY_GATE], late=by_gate[LATE_GATE])

    def as_dict(self) -> dict[str, Any]:
        return {
            "at": format_instant(self.at),
            "lanes": [outcome.as_dict() for outcome in self.outcomes],
            "promoted": [lane.directory_name for lane in self.promoted],
            "contrast": self.contrast().as_dict(),
        }


def run_serving_lanes(
    gate_one: Callable[[Lane], GateDecision | NoCandidate],
    *,
    at: datetime,
    lanes: Sequence[Lane] = SERVING_LANES,
) -> ServingLanesReport:
    """Gate every served lane, once each, whatever the others did.

    ``gate_one`` is the whole of one lane's retrain-and-gate: it trains a
    candidate, assembles the comparator and calls
    :func:`~wattsteer_ml.evaluation.gate.run_gate`, returning that decision or a
    :class:`~wattsteer_ml.evaluation.gate.NoCandidate`. It is a parameter rather
    than an import because the gate needs a database, a fold calendar and a
    trained bundle, and none of those belong to the question this module
    answers, which is *what happens to the second lane when the first one goes
    wrong*.

    **Every exception is caught, and that is the design.** A bare ``except
    Exception`` is usually a smell; here it is the requirement. The two lanes
    are two experiments that happen to be retrained on one schedule, and the
    morning view exists precisely so a failure of the evening one is
    recoverable. Letting an evening ``ContractDriftError`` abort the batch
    before the morning lane ran would delete the recovery. Nothing is
    swallowed: the failure is named in the report, and the gate has already
    written its own refusal to the volume before raising.

    ``KeyboardInterrupt`` and ``SystemExit`` derive from ``BaseException`` and
    are therefore not caught — an operator stopping the retrain is not a lane
    failing.
    """
    seen: list[Lane] = []
    outcomes: list[LaneOutcome] = []
    for lane in lanes:
        if lane in seen:
            raise ServingLanesError(f"{lane} was asked for twice in one run")
        seen.append(lane)
        try:
            outcomes.append(LaneOutcome.of(lane, gate_one(lane)))
        except Exception as error:  # a lane failure must not take the batch
            outcomes.append(LaneOutcome.raised(lane, error))
    return ServingLanesReport(at=at, outcomes=tuple(outcomes))


def _reason(outcome: LaneOutcome) -> str:
    if outcome.decision is not None:
        return outcome.decision.reason
    if outcome.no_candidate is not None:
        return outcome.no_candidate.reason
    return outcome.failure or ""
