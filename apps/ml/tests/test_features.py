"""The ownership boundary, asserted on this side of it.

`docs/specs/feature-engineering.md` §"SQL or Python" draws one line: the feature
function is SQL, and the Python service "performs no windowed or joined
computation of its own — no window, no join, no time offset". A boundary nobody
checks is a convention, and conventions decay by exactly one convenient pandas
call at a time, so it is checked here the same way
`test_canonical_contract.py` checks that this service holds no HTTP client:
against the module's own text.

None of this needs a database. What needs one is the gate itself, and that is
`apps/api/test/database-features.test.ts`, where the two seams live.
"""

from __future__ import annotations

import inspect
from datetime import UTC, date, datetime, timedelta

import pytest

from wattsteer_ml import features
from wattsteer_ml.features import (
    FEATURE_ROWS_SQL,
    FeatureRowsQuery,
    read_feature_rows,
    read_serving_rows,
    serving_target_date,
)

SOURCE = inspect.getsource(features)


def test_the_module_issues_exactly_one_statement() -> None:
    """One SQL string, and the serving path shares it with the training path.

    Two statements would be two places the gate could be resolved, which is the
    whole failure this spine exists to make unwriteable.
    """
    assert SOURCE.count("select ") == 1
    assert FEATURE_ROWS_SQL in SOURCE


@pytest.mark.parametrize(
    "forbidden",
    [" join ", " over (", "partition by", "row_number", "lag(", "lead(", "rolling"],
)
def test_the_statement_computes_nothing(forbidden: str) -> None:
    """No window, no join, no time offset — in the SQL this module sends.

    Not a style rule. `ROWS BETWEEN 168 PRECEDING AND 1 PRECEDING` versus
    `... AND CURRENT ROW` is a one-token difference that decides whether a
    feature is honest, and there must be exactly one place where that token can
    be written.
    """
    assert forbidden not in FEATURE_ROWS_SQL.lower()


def test_the_call_takes_no_instant() -> None:
    """There is no `as_of` here because `feature_rows` has no parameter for one.

    The gate is derived per row from the target date inside the function, so a
    caller has nothing to choose and no way to choose it. That is the difference
    between skew avoided and skew made inexpressible.
    """
    fields = set(FeatureRowsQuery.__dataclass_fields__)
    assert fields == {
        "target_from",
        "target_to",
        "gate_profile",
        "feature_set",
        "threshold_mw",
    }
    for name in fields:
        assert "as_of" not in name
        assert "published_at" not in name

    serving = set(inspect.signature(read_serving_rows).parameters)
    assert serving == {
        "conn",
        "target_date",
        "gate_profile",
        "feature_set",
        "threshold_mw",
    }


def test_this_module_never_writes_a_read_axis() -> None:
    """The axes belong to the function, which writes all four itself.

    A caller that set `wattsteer.published_at_or_before` on its way in would be
    choosing a cut-off the gate had already decided — and it would be silently
    overwritten, which is worse than being refused.
    """
    assert "apply_axes(" not in SOURCE
    assert "set_config" not in SOURCE
    assert "wattsteer." not in FEATURE_ROWS_SQL


def test_serving_delegates_rather_than_implements() -> None:
    """The serving call is the training call over a one-day range.

    Asserted structurally, because "identical" is cheap to claim and this is
    what makes it true: `read_serving_rows` has no query of its own to drift.
    """
    body = inspect.getsource(read_serving_rows)
    assert "read_feature_rows(" in body
    assert "fetch(" not in body
    assert "target_from=target_date" in body
    assert "target_to=target_date" in body
    assert "fetch(" in inspect.getsource(read_feature_rows)


def test_tomorrow_is_tomorrow_in_brasilia_not_in_utc() -> None:
    """Between 21:00 and 24:00 BRT the two calendars disagree.

    That window sits inside `gate_late`'s working evening, so a UTC reading
    would serve the wrong day for three hours every night — a whole day of
    forecast produced against the wrong target.
    """
    # 2026-08-30T01:30Z is still 2026-08-29 22:30 in Brasília.
    late_evening = datetime(2026, 8, 30, 1, 30, tzinfo=UTC)
    assert serving_target_date(late_evening) == date(2026, 8, 30)
    # Reading the same instant in UTC would have asked for the 31st.
    assert (late_evening + timedelta(days=1)).date() == date(2026, 8, 31)

    midday = datetime(2026, 8, 29, 15, 0, tzinfo=UTC)
    assert serving_target_date(midday) == date(2026, 8, 30)
