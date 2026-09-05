"""The featured days are a query, and one of them is a day WattSteer got wrong.

Replay ticket 07, and `docs/specs/replay.md` seam 8. The assertions divide into
four, and the middle two are the ticket:

**It is a query.** The same candidates in a different order produce the same
eight dates with the same reasons, every clause is a ``min`` with the date as
its tiebreak, and nothing consults a clock or a set's iteration order. A rule
that could not be re-run to the same answer would be a curated list with a
plausible story.

**It cannot become a highlight reel.** The mandatory clause —
``min(scored.observed.recovered − recovered_floor)`` — runs over every
replayable day with no filter in front of it, so the day whose observed recovery
fell furthest below the floor WattSteer promised at D−1 is on the demo screen by
rule. The load-bearing test is the synthetic one: a day that badly missed its
floor and is *unremarkable by every other criterion* is featured anyway.

**A day nobody missed a floor on is labelled, not laundered.** With every margin
positive the slot still names a day — the thinnest margin — and it carries
`closest_call` rather than `worst_floor_shortfall`, because "the nearest we came
to breaking a promise" and "a promise we broke" are different sentences.

**Coverage, collapse, padding and ties**, which are the mechanical half of the
published sentence and the half a future change is most likely to break
silently.

The scoring is not re-exercised here: a candidate is five numbers read off a
:class:`~wattsteer_ml.replay.scoring.ReplayScores` that
:mod:`wattsteer_ml.replay.shortlist` produced with the endpoint's own
:func:`~wattsteer_ml.replay.scoring.score_replay`, and
``test_database_featured_days.py`` is where that end of it meets Postgres.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.constants import BRL_PER_MWH, REFERENCE_FLEET
from wattsteer_ml.replay.featured import (
    CLOSEST_CALL,
    FEATURED_DAY_COUNT,
    FEATURED_RULE_SENTENCE,
    LARGEST_FORECAST_ERROR,
    LARGEST_IN_PROVENANCE,
    LARGEST_IN_VINTAGE_FIDELITY,
    LARGEST_OBSERVED_TOTAL,
    LARGEST_TOTAL_COUNT,
    PADDED_FROM_LARGEST_OBSERVED_TOTAL,
    WORST_FLOOR_SHORTFALL,
    FeaturedCandidate,
    FeaturedDays,
    FeaturedRuleError,
    select_featured_days,
)
from wattsteer_ml.replay.shortlist import (
    PENDING,
    READY,
    STALE,
    pending_payload,
    reference_fleet_hash,
    reference_fleet_scenario,
)

#: An arbitrary anchor inside F3's test period. Only the ordering matters to
#: any assertion below, never the calendar date itself.
ANCHOR = date(2025, 11, 1)
SUBSYSTEM = "NE"


def day(offset: int) -> date:
    return ANCHOR + timedelta(days=offset)


def candidate(
    offset: int,
    *,
    total: float,
    forecast_total: float | None = None,
    margin: float = 10.0,
    provenance: str = "fold_holdout",
    fidelity: VintageFidelity = "revision_optimistic",
) -> FeaturedCandidate:
    """One replayable day, in the five numbers the rule reads.

    ``forecast_total`` defaults to the observed total, which makes the day's
    absolute forecast error exactly zero — so a test that does not care about
    the second clause cannot accidentally win it.
    """
    return FeaturedCandidate(
        target_date=day(offset),
        provenance=provenance,
        vintage_fidelity=fidelity,
        observed_total_mwh=total,
        forecast_total_p50_mwh=total if forecast_total is None else forecast_total,
        floor_margin_mwh=margin,
    )


def criteria(featured: FeaturedDays, target_date: date) -> set[str]:
    return {
        reason.criterion
        for entry in featured.days
        if entry.target_date == target_date
        for reason in entry.reasons
    }


def dates(featured: FeaturedDays) -> list[date]:
    return [entry.target_date for entry in featured.days]


#: Ten unremarkable days of descending size, none of which missed its floor.
#: The bed every test below lies a fact on top of.
BACKGROUND = tuple(
    candidate(offset, total=1000.0 - offset * 10, margin=100.0 - offset)
    for offset in range(10)
)


# --- it is a query ------------------------------------------------------------


def test_the_rule_is_deterministic_and_re_running_it_changes_nothing() -> None:
    """`replay.md` seam 8's first clause, as a property of two orderings.

    The candidates arrive from a scan over dates in production; the rule must
    not care. Reversing them is the cheapest way to catch a clause that leaned
    on input order — which `max` over a list silently does, and `min` with an
    explicit key does not.
    """
    forwards = select_featured_days(BACKGROUND)
    backwards = select_featured_days(tuple(reversed(BACKGROUND)))
    assert forwards.as_payload() == backwards.as_payload()
    assert select_featured_days(BACKGROUND).as_payload() == forwards.as_payload()


def test_ties_break_on_date_ascending() -> None:
    """Two identical days is a coin the rule is not allowed to flip."""
    tied = (
        candidate(5, total=500.0),
        candidate(1, total=500.0),
        candidate(9, total=500.0),
        candidate(3, total=10.0, margin=-1.0),
    )
    featured = select_featured_days(tied, size=2)
    # The floor day takes its reserved seat; the remaining one goes to the
    # earliest of the three tied days rather than to whichever was listed first.
    assert dates(featured) == [day(1), day(3)]


def test_the_absolute_forecast_error_does_not_choose_a_direction() -> None:
    """`|Σf50 − Σa|`, because both directions are wrong in different ways.

    A signed criterion would make this clause "the day we most under-forecast",
    which is a different and more flattering list: the over-forecast day is the
    safe failure and the under-forecast day the embarrassing one, so ranking on
    the sign would be choosing which kind of wrong to put on screen.
    """
    over = candidate(20, total=100.0, forecast_total=700.0)
    under = candidate(21, total=700.0, forecast_total=400.0)
    assert over.forecast_error_mwh == 600.0
    assert under.forecast_error_mwh == 300.0
    featured = select_featured_days((*BACKGROUND, over, under))
    assert LARGEST_FORECAST_ERROR in criteria(featured, over.target_date)


def test_an_empty_candidate_set_raises_rather_than_publishing_an_empty_list() -> None:
    """ "Nothing is replayable yet" and "the rule found these" are two answers."""
    with pytest.raises(FeaturedRuleError):
        select_featured_days(())


# --- it cannot become a highlight reel ----------------------------------------


def test_a_day_that_badly_missed_its_floor_is_featured_however_dull_it_is() -> None:
    """The load-bearing test of the ticket, on a synthetic dataset.

    The bad day is the *smallest* day in the set, its forecast was perfect, and
    it shares its provenance and its fidelity with nine larger days — so every
    clause except the mandatory one excludes it. It is on the list, it carries
    `worst_floor_shortfall`, and the shortlist says so at the top level.
    """
    disaster = candidate(30, total=1.0, margin=-480.0)
    featured = select_featured_days((*BACKGROUND, disaster))

    assert disaster.target_date in dates(featured)
    assert criteria(featured, disaster.target_date) == {WORST_FLOOR_SHORTFALL}
    assert featured.missed_floor is True
    entry = next(one for one in featured.days if one.target_date == day(30))
    assert entry.floor_met is False
    assert entry.floor_margin_mwh == -480.0


def test_the_mandatory_clause_is_present_and_non_empty_on_every_shortlist() -> None:
    """Seam 8: "it contains the worst-floor-shortfall day", asserted as a shape.

    Over a set where nobody missed, a set where one day did, and a set of one:
    exactly one entry of every shortlist carries the mandatory clause under one
    of its two labels, and it is never absent.
    """
    for candidates in (
        BACKGROUND,
        (*BACKGROUND, candidate(30, total=1.0, margin=-480.0)),
        (candidate(0, total=5.0),),
    ):
        featured = select_featured_days(candidates)
        mandatory = [
            entry
            for entry in featured.days
            for reason in entry.reasons
            if reason.criterion in (WORST_FLOOR_SHORTFALL, CLOSEST_CALL)
        ]
        assert len(mandatory) == 1
        assert mandatory[0].floor_margin_mwh == min(
            one.floor_margin_mwh for one in candidates
        )


def test_with_no_day_missing_its_floor_the_slot_is_the_closest_call() -> None:
    """The smallest margin, labelled as what it is rather than as a failure."""
    featured = select_featured_days(BACKGROUND)
    assert featured.missed_floor is False
    closest = next(
        entry
        for entry in featured.days
        if CLOSEST_CALL in {reason.criterion for reason in entry.reasons}
    )
    # `BACKGROUND` margins run 100 down to 91; the ninth day is the thinnest.
    assert closest.target_date == day(9)
    assert closest.floor_met is True
    assert WORST_FLOOR_SHORTFALL not in criteria(featured, closest.target_date)


def test_the_rule_travels_on_the_answer_in_one_sentence() -> None:
    """`replay.md`: the rule is rendered on the screen in one sentence.

    From the same constant that ran, so a screen cannot publish a rule the code
    has stopped following. It is one sentence-set and it names every clause.
    """
    featured = select_featured_days(BACKGROUND)
    assert featured.rule == FEATURED_RULE_SENTENCE
    assert featured.as_payload()["rule"] == FEATURED_RULE_SENTENCE
    for clause in ("total_mwh", "forecast error", "VintageFidelity", "provenance"):
        assert clause in FEATURED_RULE_SENTENCE
    assert "promised floor" in FEATURED_RULE_SENTENCE


# --- coverage, collapse, padding ----------------------------------------------


def test_every_populated_class_puts_a_day_on_the_list() -> None:
    """One day per populated `VintageFidelity` and per populated provenance.

    The two `served` / `point_in_time` days here are small — post-go-live is the
    short end of the window — so nothing but their own clauses would seat them.
    """
    served = (
        candidate(
            40, total=30.0, provenance="served", fidelity="point_in_time", margin=50.0
        ),
        candidate(
            41, total=20.0, provenance="served", fidelity="point_in_time", margin=60.0
        ),
    )
    featured = select_featured_days((*BACKGROUND, *served))

    assert featured.populated_provenances == ("fold_holdout", "served")
    assert featured.populated_vintage_fidelities == (
        "point_in_time",
        "revision_optimistic",
    )
    for value in featured.populated_provenances:
        assert value in {entry.provenance for entry in featured.days}
    for value in featured.populated_vintage_fidelities:
        assert value in {entry.vintage_fidelity for entry in featured.days}
    # And the largest of the two small ones is the one that got the seat.
    assert LARGEST_IN_PROVENANCE in criteria(featured, day(40))
    assert LARGEST_IN_VINTAGE_FIDELITY in criteria(featured, day(40))
    assert day(41) not in dates(featured)


def test_duplicates_collapse_into_one_entry_carrying_every_clause() -> None:
    """The biggest day is usually also the biggest in its own two classes."""
    featured = select_featured_days(BACKGROUND)
    assert len(dates(featured)) == len(set(dates(featured)))
    assert criteria(featured, day(0)) == {
        LARGEST_OBSERVED_TOTAL,
        LARGEST_IN_VINTAGE_FIDELITY,
        LARGEST_IN_PROVENANCE,
        LARGEST_FORECAST_ERROR,
    }


def test_the_list_is_padded_from_the_top_of_the_first_criterion() -> None:
    """Eight seats, five clauses, and the filler says that it is filler.

    A padded day carries `padded_from_largest_observed_total` and not a fourth
    `largest_observed_total`: the first criterion names *three* days, and a
    fourth-ranked one is on the list because the other clauses left a seat
    empty. Calling that a criterion would be calling an accident a rule.
    """
    featured = select_featured_days(BACKGROUND)
    assert len(featured.days) == FEATURED_DAY_COUNT
    assert featured.evaluated_days == len(BACKGROUND)

    ranked = [entry.target_date for entry in featured.days]
    padded = [
        entry.target_date
        for entry in featured.days
        if PADDED_FROM_LARGEST_OBSERVED_TOTAL
        in {reason.criterion for reason in entry.reasons}
    ]
    # Ranks 1–3 are the first criterion's own; padding starts at rank 4 and
    # walks down the same ordering.
    assert padded == [day(3), day(4), day(5), day(6)]
    assert all(one in ranked for one in (day(0), day(1), day(2)))
    for entry in featured.days:
        for reason in entry.reasons:
            if reason.criterion == LARGEST_OBSERVED_TOTAL:
                assert reason.rank <= LARGEST_TOTAL_COUNT


def test_a_shorter_replayable_set_yields_a_shorter_list_and_never_a_repeat() -> None:
    """Three replayable days is a shortlist of three, not eight with padding."""
    featured = select_featured_days(BACKGROUND[:3])
    assert len(featured.days) == 3
    assert len(set(dates(featured))) == 3


def test_the_obligations_survive_when_the_clauses_name_more_days_than_fit() -> None:
    """The one case the published sentence does not decide, decided here.

    Nine distinct days can win the clauses and the list holds eight. What gives
    way is the tail of the criterion the list is *padded from* anyway; every
    populated class, the forecast-error day and the floor day keep their seats.
    """
    candidates = (
        candidate(0, total=900.0, margin=50.0),
        candidate(1, total=800.0, margin=51.0),
        candidate(2, total=700.0, margin=52.0),
        candidate(3, total=10.0, forecast_total=9000.0, margin=53.0),
        candidate(
            4, total=600.0, provenance="served", fidelity="point_in_time", margin=54.0
        ),
        candidate(
            5,
            total=500.0,
            provenance="served",
            fidelity="revision_optimistic",
            margin=55.0,
        ),
        candidate(
            6,
            total=400.0,
            provenance="fold_holdout",
            fidelity="point_in_time",
            margin=56.0,
        ),
        candidate(7, total=5.0, margin=-900.0),
    )
    featured = select_featured_days(candidates)
    assert len(featured.days) == FEATURED_DAY_COUNT

    seated = set(dates(featured))
    assert day(7) in seated, "the mandatory floor clause lost its seat"
    assert day(3) in seated, "the forecast-error clause lost its seat"
    for value in featured.populated_provenances:
        assert value in {entry.provenance for entry in featured.days}
    for value in featured.populated_vintage_fidelities:
        assert value in {entry.vintage_fidelity for entry in featured.days}


def test_the_days_are_published_in_date_order() -> None:
    """The Time Machine is addressed along a calendar, so the list is too.

    Ranking the entries by size would make the first one read as "the best day",
    which is the impression the whole rule exists to avoid.
    """
    featured = select_featured_days(BACKGROUND)
    assert dates(featured) == sorted(dates(featured))


# --- the fleet it is computed against, and the absence before it has run ------


def test_the_shortlist_is_computed_against_the_published_reference_fleet() -> None:
    """`replay.md` story 35, and this ticket's own blocker.

    The list is not reproducible if the fleet it was measured against is
    restated per surface, so the scenario is assembled from
    `REFERENCE_FLEET` — both assets — and from the published `BRL_PER_MWH`.
    """
    wire = reference_fleet_scenario(SUBSYSTEM, day(0))
    assert wire["subsystem"] == SUBSYSTEM
    assert wire["target_date"] == day(0).isoformat()
    assert wire["economic_assumptions"] == {"brl_per_mwh": BRL_PER_MWH}
    by_type = {asset["asset_type"]: asset for asset in wire["assets"]}
    assert set(by_type) == {"battery", "shiftable_load"}
    assert by_type["battery"]["max_power_mw"] == REFERENCE_FLEET.battery.max_power_mw
    assert (
        by_type["battery"]["energy_capacity_mwh"]
        == REFERENCE_FLEET.battery.energy_capacity_mwh
    )
    assert (
        by_type["shiftable_load"]["max_shift_mw"]
        == REFERENCE_FLEET.shiftable_load.max_shift_mw
    )
    assert reference_fleet_hash().startswith("sha256:")


def test_the_featured_block_states_its_absence_rather_than_faking_a_list() -> None:
    """Before the nightly job has run on this instance, the days are `pending`.

    The rule and the size still travel, because they are the part of the
    contract that is true either way: a client can render the sentence and say
    the list is being recomputed. Eight empty slots would read as "the rule
    found nothing interesting", which is a claim nobody made.
    """
    payload = pending_payload("not yet")
    assert payload["state"] == PENDING
    assert payload["days"] == []
    assert payload["rule"] == FEATURED_RULE_SENTENCE
    assert payload["size"] == FEATURED_DAY_COUNT
    assert payload["computation_id"] is None
    assert PENDING not in (READY, STALE)
