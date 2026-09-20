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

#: A comparison whose left side is the civil date of ``valid_time``.
CIVIL_DATE_PREDICATE = re.compile(
    r"\(valid_time at time zone 'America/Sao_Paulo'\)::date\s*(=|between|>=|<=|<|>)"
)


def test_the_window_is_a_range_over_valid_time() -> None:
    for sql in (OBSERVED_HOURS_SQL, OBSERVED_DAY_SQL):
        assert "valid_time >= (" in sql
        assert "valid_time < (" in sql
        assert CIVIL_DATE_PREDICATE.search(sql) is None


def test_the_guard_finds_the_shape_it_forbids() -> None:
    old = "and (valid_time at time zone 'America/Sao_Paulo')::date = $2::date"
    assert CIVIL_DATE_PREDICATE.search(old) is not None
