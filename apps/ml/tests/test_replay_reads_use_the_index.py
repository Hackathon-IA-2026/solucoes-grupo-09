"""The replay's two observed reads bound ``valid_time``, not an expression over it.

Source-level, because the property is in how the predicate is spelled and no
result can show it: both spellings select the same rows (the database suite
holds that), and only one can use an index. Measured on 20/09/2026 over 5.2
million rows: 10.5 s against 1.7 s, and at 10.5 s the gateway had already
answered ``OPTIMIZER_TIMEOUT`` for every day of the Time Machine.
"""

import re

from wattsteer_ml.replay.inputs import OBSERVED_DAY_SQL
from wattsteer_ml.replay.reads import OBSERVED_HOURS_SQL

#: A comparison whose left side is the civil date of ``valid_time``. Case- and
#: whitespace-insensitive, and the operator is anything but a closing paren or
#: an alias: `... ::date as target_date` is the projection, which is fine, and
#: everything else is a predicate the index cannot serve.
CIVIL_DATE_PREDICATE = re.compile(
    r"\(\s*valid_time\s+at\s+time\s+zone\s+'America/Sao_Paulo'\s*\)\s*::\s*date"
    r"\s*(?!\s*(?:as\b|,|\)))\S",
    re.IGNORECASE,
)


def test_the_window_is_a_range_over_valid_time() -> None:
    for sql in (OBSERVED_HOURS_SQL, OBSERVED_DAY_SQL):
        assert "valid_time >= (" in sql
        assert "valid_time < (" in sql
        assert CIVIL_DATE_PREDICATE.search(sql) is None


def test_the_guard_finds_the_shape_it_forbids() -> None:
    """Non-vacuous, and not defeated by the formatting of the same predicate.

    Copilot on #32: a guard that only matches one spelling passes the day the
    SQL is reformatted, which is the silence it exists to prevent.
    """
    forbidden = (
        "and (valid_time at time zone 'America/Sao_Paulo')::date = $2::date",
        "AND (valid_time AT TIME ZONE 'America/Sao_Paulo')::DATE BETWEEN $2 AND $3",
        "and (valid_time\n      at time zone 'America/Sao_Paulo')::date <= $3::date",
        "and (valid_time at time zone 'America/Sao_Paulo') :: date in ($2::date)",
    )
    for sql in forbidden:
        assert CIVIL_DATE_PREDICATE.search(sql) is not None, sql
    # The projection is not a predicate: every read selects the civil date.
    assert (
        CIVIL_DATE_PREDICATE.search(
            "select (valid_time at time zone 'America/Sao_Paulo')::date as target_date,"
        )
        is None
    )
