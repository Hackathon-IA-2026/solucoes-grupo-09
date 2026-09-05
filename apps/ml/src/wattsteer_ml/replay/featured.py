"""The featured days — a query with stated criteria, never a curated list.

`docs/specs/replay.md`, "Which days are replayable — decided", publishes the
rule in one sentence and this module is that sentence, executable:

> The **eight** featured days are: the three days with the largest observed
> ``total_mwh``; the day with the largest **absolute forecast error** on the day
> total; the day with the largest observed total in **each**
> `VintageFidelity` class; the day with the largest observed total in **each**
> provenance class; and — mandatorily — **the day with the largest shortfall
> against its own promised floor**, i.e.
> ``min(scored.observed.recovered − recovered_floor)``. Duplicates collapse and
> the list is padded from the top of the first criterion. Ties break on date,
> ascending.

## Why it is a query and not a list

Hand-picking eight interesting days is **selecting on the outcome**, which is
the same failure the shuffled-label control exists to catch one layer down: a
person choosing the demo days would choose the ones the product looks good on,
and nothing on the screen would show that they had. So the shortlist is
computed, the criteria are published beside it, and every entry says *which
criterion put it there*. "Which days are featured" is then reproducible from the
data by anyone holding the same rows, and the only way to change it is to change
the data or the rule — both of which are visible.

The last clause is the one that matters, and it is the reason this module
exists rather than a ``order by total_mwh desc limit 8``: the set is **obliged
to contain a day WattSteer got wrong**. ``min(recovered − recovered_floor)`` is
the day whose observed recovery fell furthest below the floor the product
promised at D−1 — the product's own worst broken promise, on the demo screen, by
rule. If no day missed its floor the same expression still names a day, the one
with the thinnest margin, and it is labelled :data:`CLOSEST_CALL` rather than
silently rendered as a failure that did not happen.

## What this module is not

It is not a score, not a ranking of quality, and it never reads Postgres. It
takes one :class:`FeaturedCandidate` per replayable day — five numbers and two
classes, every one of them read off a
:class:`~wattsteer_ml.replay.scoring.ReplayScores` that the *same* code path
produced for `POST /v1/replay` — and returns which eight the rule names.
:mod:`wattsteer_ml.replay.shortlist` is the half that talks to the database and
runs the solves.

## The one place the spec is silent, decided here

The published clauses can name at most nine distinct days (three + one + two
fidelity classes + two provenance classes + one floor day), and the list holds
eight. The spec never says which clause gives way, because at today's data the
union is smaller than eight and the sentence is written for the padding case.
Since the acceptance criteria oblige the list to carry *every* populated
`VintageFidelity`, *every* populated provenance and the floor day, the seat
allocation runs in :data:`CRITERION_PRIORITY` — the obligations first and the
three largest totals last — so that what gives way under contention is the tail
of the criterion the list is **padded from** anyway. At worst the third-largest
day is dropped; no obligation ever is.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from wattsteer_ml.canonical import VintageFidelity

#: How many days the shortlist holds. `docs/specs/replay.md`: "The **eight**
#: featured days are…", and the padding clause exists to keep it at eight even
#: when the criteria name fewer.
FEATURED_DAY_COUNT = 8

#: How many days the first criterion names outright — "the three days with the
#: largest observed ``total_mwh``". It is also the criterion the list is padded
#: from, so this is a floor on its contribution and not a cap.
LARGEST_TOTAL_COUNT = 3

#: The criteria, as the codes that travel on the wire beside each featured day.
#: A code rather than a sentence for the reason every refusal in this package is
#: a code: the screen renders the copy, and a client that switched on English
#: prose would break on the first rewording.
LARGEST_OBSERVED_TOTAL = "largest_observed_total"
LARGEST_FORECAST_ERROR = "largest_absolute_forecast_error"
LARGEST_IN_VINTAGE_FIDELITY = "largest_observed_total_in_vintage_fidelity"
LARGEST_IN_PROVENANCE = "largest_observed_total_in_provenance"
WORST_FLOOR_SHORTFALL = "worst_floor_shortfall"
CLOSEST_CALL = "closest_call"
PADDED_FROM_LARGEST_OBSERVED_TOTAL = "padded_from_largest_observed_total"

#: Padding is its own code and not a fourth ``largest_observed_total``. The
#: first criterion names *three* days; a fourth-ranked day is in the list
#: because the others left a seat empty, and saying so is the difference between
#: a criterion and an accident.
_PADDING_CRITERION = PADDED_FROM_LARGEST_OBSERVED_TOTAL

#: Which clause gives way when the criteria name more days than the list holds.
#: See the module docstring: the obligations first, the padding source last.
CRITERION_PRIORITY: tuple[str, ...] = (
    WORST_FLOOR_SHORTFALL,
    CLOSEST_CALL,
    LARGEST_IN_VINTAGE_FIDELITY,
    LARGEST_IN_PROVENANCE,
    LARGEST_FORECAST_ERROR,
    LARGEST_OBSERVED_TOTAL,
    PADDED_FROM_LARGEST_OBSERVED_TOTAL,
)

#: The order the clauses are *published* in, which is the order a day's reasons
#: are rendered in. Distinct from :data:`CRITERION_PRIORITY` on purpose: one is
#: what the sentence says, the other is what happens under contention, and
#: collapsing them would silently reorder the sentence.
CRITERION_ORDER: tuple[str, ...] = (
    LARGEST_OBSERVED_TOTAL,
    PADDED_FROM_LARGEST_OBSERVED_TOTAL,
    LARGEST_FORECAST_ERROR,
    LARGEST_IN_VINTAGE_FIDELITY,
    LARGEST_IN_PROVENANCE,
    WORST_FLOOR_SHORTFALL,
    CLOSEST_CALL,
)

#: The rule, in one sentence, as the screen renders it — `replay.md`'s own
#: words. Shipped from here rather than retyped in `apps/web` so that the rule
#: on the screen and the rule that ran are the same string: a shortlist whose
#: published criteria have drifted from its code is a curated list with extra
#: steps.
FEATURED_RULE_SENTENCE = (
    "The eight featured days are: the three days with the largest observed "
    "total_mwh; the day with the largest absolute forecast error on the day "
    "total; the day with the largest observed total in each VintageFidelity "
    "class; the day with the largest observed total in each provenance class; "
    "and — mandatorily — the day with the largest shortfall against its own "
    "promised floor. Duplicates collapse and the list is padded from the top "
    "of the first criterion. Ties break on date, ascending."
)


class FeaturedRuleError(ValueError):
    """The shortlist could not be built from what it was handed.

    Raised rather than returned short, because an empty or truncated shortlist
    on a screen is indistinguishable from a rule that found nothing interesting
    — and the one thing this list must never do is look chosen.
    """


@dataclass(frozen=True)
class FeaturedCandidate:
    """One replayable day, in the five numbers the rule reads.

    Every field is read off a :class:`~wattsteer_ml.replay.scoring.ReplayScores`
    produced by the same :func:`~wattsteer_ml.replay.scoring.score_replay` that
    answers `POST /v1/replay`, never recomputed here. That is what makes the
    floor margin on this list the *same* number the replay screen shows for that
    day: a second expression for "did it clear its floor" would eventually
    disagree with the first, and the disagreement would be invisible.
    """

    target_date: date
    #: ``served`` or ``fold_holdout`` — the day's provenance class.
    provenance: str
    vintage_fidelity: VintageFidelity
    #: ``Σ_t a[t]`` — the observed day total, the first criterion's quantity.
    observed_total_mwh: float
    #: ``Σ_t f50[t]`` as published at the gate, day-grain and read rather than
    #: summed from the hourly band.
    forecast_total_p50_mwh: float
    #: ``scored.observed.recovered − recovered_floor``. Negative is a day the
    #: product missed the floor it promised at D−1.
    floor_margin_mwh: float

    @property
    def forecast_error_mwh(self) -> float:
        """``|Σf50 − Σa|`` — absolute, because both directions are wrong.

        Signed error would make the criterion "the day we most under-forecast",
        which is a different and more flattering list: `replay.md`'s arithmetic
        section is explicit that an over-forecast day is the *safe* failure and
        an under-forecast day the embarrassing one, so a rule that ranked on the
        signed value would be choosing which kind of wrong to show.
        """
        return abs(self.forecast_total_p50_mwh - self.observed_total_mwh)

    @property
    def floor_met(self) -> bool:
        return self.floor_margin_mwh >= 0.0


@dataclass(frozen=True)
class FeaturedReason:
    """Why one day is on the list — one clause, and the number it won on."""

    criterion: str
    #: ``1``-based, within the criterion, where the criterion names several.
    rank: int
    #: The class this clause was evaluated inside, for the two class criteria.
    #: ``None`` for the clauses evaluated over the whole replayable set.
    group: str | None
    #: The quantity the clause ranked on, in the unit the criterion names.
    value: float

    def as_payload(self) -> dict[str, object]:
        return {
            "criterion": self.criterion,
            "rank": self.rank,
            "group": self.group,
            "value": self.value,
        }


@dataclass(frozen=True)
class FeaturedDay:
    """One entry of the shortlist, and every clause that put it there.

    A day can satisfy several clauses at once — the largest observed day is very
    often also the largest in its own provenance class — and all of them travel.
    Collapsing them to the first would hide that the list is smaller than its
    criteria, which is the fact the padding clause exists to handle.
    """

    target_date: date
    provenance: str
    vintage_fidelity: VintageFidelity
    observed_total_mwh: float
    forecast_error_mwh: float
    floor_margin_mwh: float
    floor_met: bool
    reasons: tuple[FeaturedReason, ...]

    def as_payload(self) -> dict[str, object]:
        return {
            "date": self.target_date.isoformat(),
            "provenance": self.provenance,
            "vintage_fidelity": self.vintage_fidelity,
            "observed_total_mwh": self.observed_total_mwh,
            "forecast_error_mwh": self.forecast_error_mwh,
            "floor_margin_mwh": self.floor_margin_mwh,
            "floor_met": self.floor_met,
            "reasons": [reason.as_payload() for reason in self.reasons],
        }


@dataclass(frozen=True)
class FeaturedDays:
    """The shortlist, with the rule that produced it attached to it.

    The rule travels *on the answer* rather than in a document beside it,
    because `replay.md` requires the rule to be rendered on the screen in one
    sentence and a screen that fetched the days from here and the sentence from
    a constant of its own would be free to disagree with itself.
    """

    rule: str
    size: int
    days: tuple[FeaturedDay, ...]
    #: The classes actually present among the replayable days. Published so a
    #: reader can check the coverage claim rather than take it — the acceptance
    #: criterion is "at least one day from **each populated** class", and
    #: nothing else on the response says which those are.
    populated_vintage_fidelities: tuple[str, ...]
    populated_provenances: tuple[str, ...]
    #: ``True`` when the mandatory clause found a day that actually missed its
    #: floor; ``False`` when the slot holds the closest call instead. The
    #: difference is the difference between "here is one we got wrong" and
    #: "here is the nearest we came to getting one wrong", and a screen that
    #: could not tell them apart would say the first while meaning the second.
    missed_floor: bool
    #: How many replayable days the rule was evaluated over. The denominator of
    #: every clause above, and the number that makes "eight out of 521" a
    #: statement rather than a mystery.
    evaluated_days: int

    def as_payload(self) -> dict[str, object]:
        return {
            "rule": self.rule,
            "size": self.size,
            "evaluated_days": self.evaluated_days,
            "missed_floor": self.missed_floor,
            "populated_vintage_fidelities": list(self.populated_vintage_fidelities),
            "populated_provenances": list(self.populated_provenances),
            "days": [day.as_payload() for day in self.days],
        }


def _by_total(candidate: FeaturedCandidate) -> tuple[float, date]:
    """Largest observed total first; ties on date, ascending."""
    return (-candidate.observed_total_mwh, candidate.target_date)


def _largest_by_total(candidates: Iterable[FeaturedCandidate]) -> FeaturedCandidate:
    return min(candidates, key=_by_total)


def _grouped(
    candidates: Sequence[FeaturedCandidate], key: str
) -> dict[str, list[FeaturedCandidate]]:
    groups: dict[str, list[FeaturedCandidate]] = {}
    for candidate in candidates:
        groups.setdefault(str(getattr(candidate, key)), []).append(candidate)
    return groups


def _clause_picks(
    candidates: Sequence[FeaturedCandidate],
) -> list[tuple[date, FeaturedReason]]:
    """Every clause of the rule, evaluated, in the order it is published.

    One pass per clause and no shared state between them: a clause is a
    ``min`` over the same list with its own key, so reading the code against the
    sentence is a line-by-line exercise rather than an inference about a loop.
    """
    picks: list[tuple[date, FeaturedReason]] = []

    ranked = sorted(candidates, key=_by_total)
    for rank, candidate in enumerate(ranked[:LARGEST_TOTAL_COUNT], start=1):
        picks.append(
            (
                candidate.target_date,
                FeaturedReason(
                    criterion=LARGEST_OBSERVED_TOTAL,
                    rank=rank,
                    group=None,
                    value=candidate.observed_total_mwh,
                ),
            )
        )

    worst_forecast = min(
        candidates, key=lambda one: (-one.forecast_error_mwh, one.target_date)
    )
    picks.append(
        (
            worst_forecast.target_date,
            FeaturedReason(
                criterion=LARGEST_FORECAST_ERROR,
                rank=1,
                group=None,
                value=worst_forecast.forecast_error_mwh,
            ),
        )
    )

    for criterion, key in (
        (LARGEST_IN_VINTAGE_FIDELITY, "vintage_fidelity"),
        (LARGEST_IN_PROVENANCE, "provenance"),
    ):
        for group, members in sorted(_grouped(candidates, key).items()):
            best = _largest_by_total(members)
            picks.append(
                (
                    best.target_date,
                    FeaturedReason(
                        criterion=criterion,
                        rank=1,
                        group=group,
                        value=best.observed_total_mwh,
                    ),
                )
            )

    # The mandatory clause, last in the sentence and first in the seat
    # allocation. `min(recovered − recovered_floor)`, over every replayable day
    # and with no filter of any kind in front of it: a rule that skipped days on
    # any ground would be a rule that could be taught to skip the bad ones.
    shortfall = min(candidates, key=lambda one: (one.floor_margin_mwh, one.target_date))
    picks.append(
        (
            shortfall.target_date,
            FeaturedReason(
                criterion=(
                    CLOSEST_CALL if shortfall.floor_met else WORST_FLOOR_SHORTFALL
                ),
                rank=1,
                group=None,
                value=shortfall.floor_margin_mwh,
            ),
        )
    )
    return picks


def _seats(picks: Sequence[tuple[date, FeaturedReason]], *, size: int) -> list[date]:
    """Which of the picked days get seats, when the clauses name more than fit.

    Ordered by :data:`CRITERION_PRIORITY` and then by the order the clause was
    published, so the outcome is a function of the criteria rather than of the
    dictionary iteration order of the day that ran it.
    """
    order = {criterion: index for index, criterion in enumerate(CRITERION_PRIORITY)}
    ranked = sorted(
        enumerate(picks),
        key=lambda pair: (order[pair[1][1].criterion], pair[0]),
    )
    seated: list[date] = []
    for _, (target_date, _reason) in ranked:
        if target_date not in seated and len(seated) < size:
            seated.append(target_date)
    return seated


def select_featured_days(
    candidates: Sequence[FeaturedCandidate], *, size: int = FEATURED_DAY_COUNT
) -> FeaturedDays:
    """The rule, run. Deterministic given the candidates, and total.

    Re-running it over the same candidates returns the same dates in the same
    order with the same reasons: every ordering in here breaks its ties on the
    date, ascending, and nothing consults a clock, a hash seed or a set's
    iteration order.

    Raises :class:`FeaturedRuleError` on an empty candidate set. There is no
    honest eight-day shortlist of nothing, and returning an empty list would put
    "no days are replayable yet" and "the rule found these eight" behind the
    same shape.
    """
    if not candidates:
        raise FeaturedRuleError(
            "the featured-days rule was evaluated over no replayable days; an "
            "empty shortlist and a shortlist of eight are different answers and "
            "must not share a shape"
        )
    if size < 1:
        raise FeaturedRuleError(f"a shortlist of {size} days is not a shortlist")

    picks = _clause_picks(candidates)
    seated = _seats(picks, size=size)

    # Padding, from the top of the first criterion — which is where the rule
    # says it comes from, and it is the only clause that can name more days on
    # demand. Its entries carry their own criterion code so that a padded day is
    # never read as one the rule singled out.
    ranked = sorted(candidates, key=_by_total)
    padding: dict[date, FeaturedReason] = {}
    for rank, candidate in enumerate(ranked, start=1):
        if len(seated) >= size:
            break
        if candidate.target_date in seated:
            continue
        seated.append(candidate.target_date)
        padding[candidate.target_date] = FeaturedReason(
            criterion=_PADDING_CRITERION,
            rank=rank,
            group=None,
            value=candidate.observed_total_mwh,
        )

    by_date: Mapping[date, FeaturedCandidate] = {
        candidate.target_date: candidate for candidate in candidates
    }
    published = {criterion: index for index, criterion in enumerate(CRITERION_ORDER)}
    chosen = set(seated)
    reasons: dict[date, list[FeaturedReason]] = {}
    for target_date, reason in picks:
        if target_date in chosen:
            reasons.setdefault(target_date, []).append(reason)
    for target_date, reason in padding.items():
        reasons.setdefault(target_date, []).append(reason)

    shortfall_reason = next(
        reason
        for _, reason in picks
        if reason.criterion in (WORST_FLOOR_SHORTFALL, CLOSEST_CALL)
    )
    days = tuple(
        FeaturedDay(
            target_date=target_date,
            provenance=by_date[target_date].provenance,
            vintage_fidelity=by_date[target_date].vintage_fidelity,
            observed_total_mwh=by_date[target_date].observed_total_mwh,
            forecast_error_mwh=by_date[target_date].forecast_error_mwh,
            floor_margin_mwh=by_date[target_date].floor_margin_mwh,
            floor_met=by_date[target_date].floor_met,
            reasons=tuple(
                sorted(
                    reasons[target_date],
                    key=lambda one: (published[one.criterion], one.rank, one.group or ""),
                )
            ),
        )
        # Ascending by date, which is the axis the Time Machine is addressed
        # along. Ranking the entries by size would make the first one read as
        # "the best day", which is the impression the whole rule exists to
        # avoid.
        for target_date in sorted(seated)
    )
    return FeaturedDays(
        rule=FEATURED_RULE_SENTENCE,
        size=len(days),
        days=days,
        populated_vintage_fidelities=tuple(
            sorted({candidate.vintage_fidelity for candidate in candidates})
        ),
        populated_provenances=tuple(
            sorted({candidate.provenance for candidate in candidates})
        ),
        missed_floor=shortfall_reason.criterion == WORST_FLOOR_SHORTFALL,
        evaluated_days=len(candidates),
    )


__all__ = [
    "CLOSEST_CALL",
    "CRITERION_ORDER",
    "CRITERION_PRIORITY",
    "FEATURED_DAY_COUNT",
    "FEATURED_RULE_SENTENCE",
    "LARGEST_FORECAST_ERROR",
    "LARGEST_IN_PROVENANCE",
    "LARGEST_IN_VINTAGE_FIDELITY",
    "LARGEST_OBSERVED_TOTAL",
    "LARGEST_TOTAL_COUNT",
    "PADDED_FROM_LARGEST_OBSERVED_TOTAL",
    "WORST_FLOOR_SHORTFALL",
    "FeaturedCandidate",
    "FeaturedDay",
    "FeaturedDays",
    "FeaturedReason",
    "FeaturedRuleError",
    "select_featured_days",
]
