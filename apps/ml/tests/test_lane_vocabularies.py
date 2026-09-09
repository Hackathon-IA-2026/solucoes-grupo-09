"""Two `lane_state` vocabularies, kept two and kept in step.

`/v1/model/card` answers `unresolvable` about a lane that `artifacts.inspect()`
calls `promoted`, and neither is wrong: one is an **error envelope** saying why
a request found nothing, the other an **inspection** saying what condition a
lane is in. The reading that makes them a contradiction is the reading that
takes them for one vocabulary, and both definitions now say so — the risk is
that they drift apart again, silently, in two languages.

So this suite pins three things:

1. :data:`~wattsteer_ml.artifacts.EnvelopeLaneState` has exactly the members
   `packages/core`'s `LANE_STATES` has, read out of `errors.ts` itself rather
   than restated here. A fourth member on either side is a spec change, and
   this is what makes it one instead of a drift.
2. :data:`~wattsteer_ml.artifacts.LaneCondition` is those three **plus**
   `promoted`, and nothing else — the fourth is the whole difference.
3. :attr:`~wattsteer_ml.artifacts.LaneView.absence_state` is the only crossing
   between them, and it refuses to invent an envelope word for a lane that has
   something to serve. That refusal is the invariant `LANE_STATES` states in
   prose, executable.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

import pytest

from wattsteer_ml.artifacts import EnvelopeLaneState, LaneCondition, LaneView
from wattsteer_ml.lanes import Lane

# apps/ml/tests/… → repo root → packages/core/src/errors.ts
ERRORS_TS = (
    Path(__file__).resolve().parents[3] / "packages" / "core" / "src" / "errors.ts"
)

LANE = Lane(feature_set="dessem_free_v1", gate_profile="gate_late", threshold_mw=5)


def lane_states_from_typescript() -> tuple[str, ...]:
    """`LANE_STATES`' members, off the declaration in `errors.ts`.

    The source and not a mirrored fixture: this vocabulary is spec-authoritative
    on the TypeScript side, and a fixture here would be a third copy to keep in
    step. Matching the declaration means a rename of the export fails this test
    too, which is correct — the name is half of what this ticket fixed.
    """
    match = re.search(
        r"export const LANE_STATES = \[(.*?)\] as const;",
        ERRORS_TS.read_text(encoding="utf-8"),
        re.DOTALL,
    )
    assert match is not None, f"no `export const LANE_STATES` in {ERRORS_TS}"
    return tuple(re.findall(r'"([^"]+)"', match.group(1)))


def test_the_envelope_vocabulary_matches_packages_core() -> None:
    assert get_args(EnvelopeLaneState) == lane_states_from_typescript()


def test_the_envelope_vocabulary_excludes_promoted() -> None:
    """Not an accident of which states happen to be reachable.

    A lane with a promoted artifact has something to serve and never produces
    this envelope, so the word is absent from the vocabulary rather than merely
    unused within it.
    """
    assert "promoted" not in get_args(EnvelopeLaneState)


def test_the_condition_vocabulary_is_the_envelope_plus_promoted() -> None:
    """One extra member, and it is the one the two endpoints disagree over."""
    assert set(get_args(LaneCondition)) == {
        *get_args(EnvelopeLaneState),
        "promoted",
    }


def test_a_promoted_lane_has_a_condition_and_no_envelope_word() -> None:
    """The crossing raises rather than reaching for `unresolvable`.

    Reaching for it would put "the volume cannot say what this lane serves" on
    the wire about a lane that has just said so, which is the one claim the
    promotion log exists to keep off it.
    """
    served = "2026-09-04T03:10:12Z"
    view = LaneView(lane=LANE, artifacts=(served,), promoted=served)
    assert view.state == "promoted"
    with pytest.raises(ValueError, match="not one of the three states"):
        _ = view.absence_state


@pytest.mark.parametrize(
    ("view", "expected"),
    [
        (LaneView(lane=LANE, artifacts=(), promoted=None), "no_artifact"),
        (
            LaneView(lane=LANE, artifacts=("2026-09-04T03:10:12Z",), promoted=None),
            "present_unpromoted",
        ),
        (
            LaneView(
                lane=LANE, artifacts=(), promoted=None, fault="the log is truncated"
            ),
            "unresolvable",
        ),
    ],
)
def test_every_other_condition_crosses_unchanged(view: LaneView, expected: str) -> None:
    """The three that *are* absences keep their spelling across the boundary.

    A re-wording on the way into an envelope is where two vocabularies start,
    and this codebase already has the two it means to have.
    """
    assert view.state == expected
    assert view.absence_state == expected
