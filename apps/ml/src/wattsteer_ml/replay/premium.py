"""The vintage caveat, measured rather than shrugged at.

`docs/specs/replay.md`, "The caveat gets measured, in Replay's own currency":

```
revision_premium_recovered_mwh
  = mean over post-go-live days d of
      recovered(plan_d, a_d @ AsOf(published_at_d + 48h))
    − recovered(plan_d, a_d @ AsOf(now))
```

It is `forecaster.md`'s ``revision_premium_qloss`` — :class:`
~wattsteer_ml.evaluation.metrics.RevisionPremium` — expressed in the currency
Replay publishes. Same construct, same discipline, different unit: one thing
scored against two label vintages, so that every number carrying the
`revision_optimistic` stamp has a measured size rather than an adjective.

## Why this is a second axis and not the held-out one again

The held-out assertion is about the **model's** information set and is settled
before a number exists — :func:`~wattsteer_ml.replay.calendar.assert_held_out`
raises rather than labels. This module is about the **data's** information set,
which no assertion can repair: ONS restates history in place, under the same
filenames, with no version marker. So the shape here is not a precondition but a
measurement, and the two travel as separate fields on the contract precisely
because today they coincide and in two months they will not.

## What the shapes here make unrepresentable

- **A premium computed on the days that need it.** A pre-go-live day has no
  as-ingested vintage — WattSteer was not watching — so a "premium" for it could
  only be fabricated. :class:`DayVintages` refuses a day that is not
  `point_in_time`, which means the measurement is taken where it is honest and
  *applied* where it is needed, and the asymmetry is visible rather than
  implicit.
- **A number scored from two different plans.** There is one ``plan`` on the
  object and the two recoveries are properties over it. Nothing can hand this
  class a pre-computed scoring, so "the same plan against two vintages" is the
  only thing it can express — a premium over two plans would measure the
  optimizer and call it a restatement.
- **A vintage that is not the one the formula names.** ``as_ingested_at`` is
  checked against ``published_at + 48 h``, so a "premium" between today's read
  and yesterday's read cannot be published under this name.
- **A mean over nothing.** :func:`revision_premium` returns ``None`` for an
  empty set of days, and :class:`RevisionPremium` refuses to hold none. `null`
  is what the contract publishes until ONS has restated days WattSteer holds
  both vintages of, and the screen says **unmeasured** in that word. A zero
  would read as "measured, and small".

**Zero is not the same as `null` here, and that is the point of the split.**
Once both vintages exist and agree, the premium is a measured ``0.0`` — ONS did
not restate those days — and publishing it is a claim. Before they exist there
is no claim to make.

## The sign

``as_ingested − latest``, the spec's order, which is `forecaster.md`'s order
too. Its interpretation is *not* the same as ``revision_premium_qloss``'s,
because the two quantities point in opposite directions: a lower qloss is
better, a higher recovery is better. So a **positive** premium here means the
plan recovered more against the actuals as first published than against today's
restatement — today's number is the more conservative of the two — and a
negative one means the restatement flatters the replay by that many MWh. The
spec's own table says the direction of the label error is unknown "in either
direction", so nothing here asserts a sign, and the note travelling with the
number says which way it was subtracted.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from wattsteer_ml.optimizer import DispatchPlan, ScoredRealisation, simulate
from wattsteer_ml.replay.calendar import ReplayDay
from wattsteer_ml.replay.scoring import ObservedDay, ReplayPostureError, same_profile

#: The lag `replay.md` writes into the formula: ``AsOf(published_at_d + 48h)``
#: is the actuals as they stood two days after the forecast was published —
#: settled, and before ONS has had a chance to restate them. An hour count and
#: not a date: it is a property of the settlement cycle, not of the calendar.
SETTLEMENT_LAG_HOURS = 48

_SETTLEMENT_LAG = timedelta(hours=SETTLEMENT_LAG_HOURS)

#: How the published scalar was subtracted, carried beside it. A signed
#: difference with no stated order is a number a reader has to guess at, and
#: guessing wrong inverts the caveat.
PREMIUM_NOTE = (
    "recovered against the actuals as first settled, minus recovered against "
    "today's restatement, over the post-go-live days held in both vintages. "
    "Positive means the replay's published number is the more conservative of "
    "the two; negative means today's restatement flatters it by that much."
)


@dataclass(frozen=True)
class DayVintages:
    """One replayed day's plan, scored against two vintages of its own actuals.

    The two ``ObservedDay`` values are the *same* (subsystem, date) read at two
    ``as_of`` instants — that is the whole content of the object, and every
    check below exists so that it cannot quietly be anything else.
    """

    day: ReplayDay
    #: The plan WattSteer built at the gate. One, shared: the premium is a
    #: difference between two realisations, never between two plans.
    plan: DispatchPlan
    threshold_mw: float
    #: ``published_at_d`` — the instant the pinned forecast was published.
    published_at: datetime
    #: ``a_d @ AsOf(published_at_d + 48h)``.
    as_ingested: ObservedDay
    #: ``a_d @ AsOf(now)`` — the same day as the replay screen scores.
    latest: ObservedDay
    as_ingested_at: datetime
    latest_at: datetime

    def __post_init__(self) -> None:
        self._check_the_day_can_hold_two_vintages()
        self._check_both_vintages_are_the_same_day()
        self._check_the_vintages_are_the_two_the_formula_names()

    # --- the preconditions -------------------------------------------------

    def _check_the_day_can_hold_two_vintages(self) -> None:
        """Post-go-live and replayable, or there is no second vintage to hold.

        A `revision_optimistic` day predates ingestion go-live, so WattSteer
        never held the actuals as first published and no read can recover them.
        Refused here rather than filtered by a caller: a mean that silently
        dropped such days would be a mean whose population nobody stated, and
        one that included them would be a mean over an invented vintage.
        """
        if self.day.refusal is not None:
            raise ReplayPostureError(
                f"{self.day.target_date.isoformat()} is not replayable, so it "
                "has no plan and no recovery number to take a premium over"
            )
        if self.day.vintage_fidelity != "point_in_time":
            raise ReplayPostureError(
                f"{self.day.target_date.isoformat()} is "
                f"{self.day.vintage_fidelity}, so WattSteer never held the "
                "actuals as they were first published and no revision premium "
                "is computable for it. The premium is measured on the days "
                "that have both vintages and applied as a caveat to the days "
                "that cannot"
            )

    def _check_both_vintages_are_the_same_day(self) -> None:
        """Two vintages of one day, not two days."""
        for label, observed in (
            ("as-ingested", self.as_ingested),
            ("latest", self.latest),
        ):
            if observed.target_date != self.day.target_date:
                raise ReplayPostureError(
                    f"the {label} vintage is "
                    f"{observed.target_date.isoformat()} and the replayed day "
                    f"is {self.day.target_date.isoformat()}; a difference "
                    "between two days is not a difference between two vintages"
                )
        if self.as_ingested.subsystem != self.latest.subsystem:
            raise ReplayPostureError(
                f"the as-ingested vintage is {self.as_ingested.subsystem} and "
                f"the latest is {self.latest.subsystem}; one subsystem per day"
            )

    def _check_the_vintages_are_the_two_the_formula_names(self) -> None:
        """``published_at + 48 h`` and something strictly later than it.

        The lag is checked rather than assumed because the name of this figure
        is a claim about *which* two reads were differenced. A premium taken
        between two reads a minute apart measures nothing and would publish
        under the same field.
        """
        expected = self.published_at + _SETTLEMENT_LAG
        if self.as_ingested_at != expected:
            raise ReplayPostureError(
                f"the as-ingested vintage was read at "
                f"{self.as_ingested_at.isoformat()} and the formula names "
                f"{expected.isoformat()} — published_at plus "
                f"{SETTLEMENT_LAG_HOURS} h; a premium over some other pair of "
                "reads is not this figure"
            )
        if self.latest_at <= self.as_ingested_at:
            raise ReplayPostureError(
                f"the latest vintage was read at {self.latest_at.isoformat()}, "
                f"at or before the as-ingested one at "
                f"{self.as_ingested_at.isoformat()}; there is no restatement "
                "between a read and itself"
            )

    # --- the two recoveries, from one plan ---------------------------------

    @property
    def as_ingested_scoring(self) -> ScoredRealisation:
        """``recovered(plan_d, a_d @ AsOf(published_at_d + 48h))``.

        Through the optimizer's own :func:`~wattsteer_ml.optimizer.simulate`,
        imported and never reimplemented — the same function the replay screen's
        headline came out of, so the premium is a difference in the *input* and
        in nothing else.
        """
        return simulate(self.plan, self.as_ingested.hours, threshold_mw=self.threshold_mw)

    @property
    def latest_scoring(self) -> ScoredRealisation:
        """``recovered(plan_d, a_d @ AsOf(now))`` — the replay screen's own number."""
        return simulate(self.plan, self.latest.hours, threshold_mw=self.threshold_mw)

    @property
    def premium_recovered_mwh(self) -> float:
        """This day's contribution: as-ingested minus latest. See :data:`PREMIUM_NOTE`."""
        return self.as_ingested_scoring.recovered_mwh - self.latest_scoring.recovered_mwh

    @property
    def restated(self) -> bool:
        """Whether ONS actually moved this day's actuals between the two reads.

        Reported rather than inferred from the premium: a day can be restated in
        hours the plan did not touch, which moves the baseline and leaves the
        recovery unchanged. A premium of zero over restated days is a finding;
        a premium of zero over unrestated ones is arithmetic.
        """
        return not same_profile(self.as_ingested.hours, self.latest.hours)

    def as_payload(self) -> dict[str, object]:
        return {
            "date": self.day.target_date.isoformat(),
            "subsystem": self.latest.subsystem,
            "restated": self.restated,
            "recovered_as_ingested_mwh": self.as_ingested_scoring.recovered_mwh,
            "recovered_latest_mwh": self.latest_scoring.recovered_mwh,
            "premium_recovered_mwh": self.premium_recovered_mwh,
        }


@dataclass(frozen=True)
class RevisionPremium:
    """The mean over the days that have both vintages — and never over none.

    Held as the days rather than as a scalar so that the population is part of
    the figure: "0.4 MWh over three days" and "0.4 MWh over ninety" are not the
    same claim, and a caller that received only the mean could not tell them
    apart.
    """

    days: tuple[DayVintages, ...]

    def __post_init__(self) -> None:
        if not self.days:
            raise ReplayPostureError(
                "a revision premium over no days is not zero, it is unmeasured; "
                "publish null and let the screen say so"
            )
        subsystems = {day.latest.subsystem for day in self.days}
        if len(subsystems) > 1:
            raise ReplayPostureError(
                f"these days span {sorted(subsystems)}; a mean of recovered MWh "
                "across subsystems is a mean over different fleets and different "
                "curtailment magnitudes"
            )
        dates = [day.day.target_date for day in self.days]
        if len(set(dates)) != len(dates):
            raise ReplayPostureError(
                "the same day appears twice; a day weighted twice in the mean is "
                "a day whose restatement counts double"
            )

    @property
    def recovered_mwh(self) -> float:
        """``revision_premium_recovered_mwh`` — the published scalar."""
        return sum(day.premium_recovered_mwh for day in self.days) / len(self.days)

    @property
    def days_restated(self) -> int:
        """How many of the days ONS actually moved. Zero is a real finding."""
        return sum(1 for day in self.days if day.restated)

    def as_payload(self) -> dict[str, object]:
        return {
            "revision_premium_recovered_mwh": self.recovered_mwh,
            "days": len(self.days),
            "days_restated": self.days_restated,
            "note": PREMIUM_NOTE,
            "contributions": [day.as_payload() for day in self.days],
        }


def revision_premium(days: Sequence[DayVintages]) -> RevisionPremium | None:
    """The premium over these days, or ``None`` because there are none.

    The one entry point, and the reason the contract's field is nullable: until
    ONS has restated days WattSteer holds both vintages of, there is nothing to
    average and the honest answer is an absence. `replay.md`'s open risk 3 is
    this function returning ``None`` for months, and the screen saying
    **unmeasured** for exactly that long.
    """
    return RevisionPremium(days=tuple(days)) if days else None


def published_premium(premium: RevisionPremium | None) -> float | None:
    """The scalar the contract carries, or ``null``. Never a zero standing in.

    A one-line function because it is the one place the ``None`` is turned into
    the wire's ``null``: a caller writing ``premium.recovered_mwh if premium
    else 0.0`` is the mistake this exists to have a name for.
    """
    return None if premium is None else premium.recovered_mwh


__all__ = [
    "PREMIUM_NOTE",
    "SETTLEMENT_LAG_HOURS",
    "DayVintages",
    "RevisionPremium",
    "published_premium",
    "revision_premium",
]
