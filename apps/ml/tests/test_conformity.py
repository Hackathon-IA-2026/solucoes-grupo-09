"""NT DOP 0022 §5.1.2's ordem de corte: the check, and what makes it fail.

A compliance claim nobody can see fail is a claim nobody should believe, so
these are written from the failure in: the first two cases are the plan this
check exists to refuse.
"""

from __future__ import annotations

import pytest

from wattsteer_ml.optimizer.conformity import (
    ACTS_ON,
    CUT_ORDER,
    RULE,
    ConformityError,
    check,
)


def test_the_order_is_the_note_s_order() -> None:
    # Renewables last is the whole reason a WattSteer plan displaces nothing:
    # the energy it absorbs is the category ONS curtails after the other three.
    assert CUT_ORDER == (
        "hydro_without_spill",
        "thermal_outside_merit",
        "hydro_with_spill",
        "renewable",
    )
    assert ACTS_ON == "renewable"
    assert CUT_ORDER[-1] == ACTS_ON


def test_a_plan_inside_category_four_passes_and_says_how_much_it_checked() -> None:
    statement = check(absorbed_mwh=[0.0, 12.0, 30.0], curtailment_mwh=[0.0, 12.0, 44.0])
    assert statement.holds is True
    assert statement.hours_checked == 3
    assert statement.rule == RULE
    assert statement.as_dict()["order"] == list(CUT_ORDER)


def test_absorbing_more_than_was_curtailed_is_refused() -> None:
    # The hour has 10 MWh of renewable constrained-off and the schedule absorbs
    # 14. The extra 4 had to come from somewhere, and the only somewhere is a
    # category above IV — which is a claim about ONS's dispatch that this
    # product does not get to make.
    with pytest.raises(ConformityError) as raised:
        check(absorbed_mwh=[0.0, 14.0], curtailment_mwh=[0.0, 10.0])
    assert raised.value.hours == (1,)
    assert "category IV" in raised.value.detail


def test_absorbing_in_an_hour_with_no_curtailment_is_refused() -> None:
    with pytest.raises(ConformityError):
        check(absorbed_mwh=[5.0], curtailment_mwh=[0.0])


def test_solver_float_noise_is_not_a_violation() -> None:
    # One part in a billion of a 44 MWh hour. A violation that matters is orders
    # of magnitude larger; a tolerance tighter than the simplex's drift would
    # refuse correct plans, which is the other way to make the check useless.
    statement = check(absorbed_mwh=[44.0 + 4.4e-8], curtailment_mwh=[44.0])
    assert statement.holds is True


def test_a_schedule_and_a_profile_of_different_lengths_cannot_be_compared() -> None:
    with pytest.raises(ConformityError):
        check(absorbed_mwh=[1.0, 2.0], curtailment_mwh=[1.0])


def test_a_statement_over_no_hours_still_reports_zero() -> None:
    # Not an error — an empty horizon is buildable — but the count is published
    # so that "holds" over nothing cannot read as "holds over the day".
    assert check(absorbed_mwh=[], curtailment_mwh=[]).hours_checked == 0
