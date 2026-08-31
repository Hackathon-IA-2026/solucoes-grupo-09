"""The out-of-fold forecasts are kept, and they cannot be served.

Replay ticket 01. The assertions divide into four, and none of them is about the
fixture's numbers:

**Kept.** A fold that was fitted and scored now yields a publication for every
held-out day of its test block, at (`subsystem`, `valid_time`) grain, with the
fold artifact's id as `run_label`.

**Counterfactual, and said so.** Every row carries
`origin_kind = 'backfilled_holdout'`, and `published_at` is
`gate_at(target_date, gate_profile)` — the same instant the *database* resolved
on the feature rows, compared here against the row's own `gate_at` rather than
against a gate this test recomputes.

**Unservable by construction rather than by intent.** There is no argument to
:func:`~wattsteer_ml.evaluation.holdout.fold_holdout_publications` that makes it
mint a `served` row, and the module contains no second composition that could
drift from the served one — asserted by reading the source, in the same spirit
as the gateway's "filtered in the query, not in a branch" test.

**Held out, asserted.** A day inside the base fit or inside the *calibration*
window the artifact's card records is refused rather than reconstructed. The
second is the subtler leak and is the one the spec names: the isotonic map and
both conformal scalars were fitted there.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
import math
from collections.abc import Sequence
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

from feature_row_fixtures import FEATURE_SET, GATE_PROFILE, THRESHOLD_MW
from wattsteer_ml.evaluation import HOURS_PER_DAY, FoldBlocks
from wattsteer_ml.evaluation import holdout as holdout_module
from wattsteer_ml.evaluation.holdout import (
    HoldoutBacktest,
    HoldoutLeakError,
    fold_holdout_publications,
)
from wattsteer_ml.publication import (
    BACKFILLED_HOLDOUT_ORIGIN_KIND,
    SERVED_ORIGIN_KIND,
    ForecastPublication,
    build_publication,
)
from wattsteer_ml.training import CORRECTION_REGIME, LoadedArtifact, TrainedFold

#: The payload this module emits, checked in for the gateway to parse.
VECTOR = (
    Path(__file__).resolve().parents[2]
    / "api"
    / "test"
    / "fixtures"
    / "forecast"
    / "holdout-backfill.json"
)


@pytest.fixture(scope="module")
def backtest(rows: Sequence[dict[str, Any]], trained: TrainedFold) -> HoldoutBacktest:
    """One fold's held-out days, from the suite's shared fit."""
    return fold_holdout_publications(rows, trained=trained)


@pytest.fixture(scope="module")
def loaded(trained: TrainedFold) -> LoadedArtifact:
    return LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=trained.bundle,
        card=trained.card.to_dict(),
    )


@pytest.fixture(scope="module")
def first_day_served(
    rows: Sequence[dict[str, Any]],
    trained: TrainedFold,
    loaded: LoadedArtifact,
    blocks: FoldBlocks,
) -> ForecastPublication:
    """The first held-out day, composed through the **serving** origin.

    The control for the two comparisons below: the *same* rows out of the
    suite's fixture, the same bundle and the same function — everything except
    the discriminator.
    """
    return build_publication(
        [row for row in rows if row["target_date"] == blocks.test_start],
        lane=trained.card.lane,
        loaded=loaded,
        target_date=blocks.test_start,
        origin_kind=SERVED_ORIGIN_KIND,
    )


# --- kept, rather than discarded ----------------------------------------------


def test_every_held_out_day_of_the_fold_is_accounted_for(
    backtest: HoldoutBacktest, blocks: FoldBlocks
) -> None:
    """The test block's days, all of them, and no day from anywhere else."""
    covered = sorted([*backtest.target_dates, *backtest.incomplete_days])
    assert covered == _days(blocks)
    assert backtest.target_dates, "the fold held days out and none was reconstructed"
    for day in backtest.target_dates:
        assert blocks.test_start <= day <= blocks.test_end


def test_the_rows_are_at_subsystem_valid_time_grain(
    backtest: HoldoutBacktest,
) -> None:
    """The grain the ticket names, and one row per key rather than a bag."""
    keys = [
        (hour.subsystem, hour.valid_time)
        for one in backtest.publications
        for hour in one.hours
    ]
    assert len(keys) == len(set(keys))
    assert backtest.hours == len(keys)
    for one in backtest.publications:
        assert len(one.hours) == len(one.subsystems) * HOURS_PER_DAY
        assert len(one.days) == len(one.subsystems)


def test_the_run_label_is_the_fold_artifact(
    backtest: HoldoutBacktest, trained: TrainedFold
) -> None:
    """The artifact that did *not* see these days is the one the rows name."""
    assert backtest.artifact_id == trained.card.artifact_id
    assert backtest.fold_id == trained.card.fold.id
    for one in backtest.publications:
        assert one.artifact_id == trained.card.artifact_id
        origin = one.as_payload()["forecast_origin"]
        assert origin["run_label"] == trained.card.artifact_id
        assert origin["producer"] == "wattsteer"


# --- counterfactual, and said so ----------------------------------------------


def test_every_row_is_a_backfilled_holdout_and_never_a_record(
    backtest: HoldoutBacktest,
) -> None:
    for one in backtest.publications:
        assert one.origin_kind == BACKFILLED_HOLDOUT_ORIGIN_KIND
        assert one.as_payload()["forecast_origin"]["origin_kind"] == (
            "backfilled_holdout"
        )
    assert backtest.as_payload()["origin_kind"] == "backfilled_holdout"
    assert SERVED_ORIGIN_KIND not in {
        one.as_payload()["forecast_origin"]["origin_kind"]
        for one in backtest.publications
    }


def test_published_at_is_the_gate_the_database_resolved_exactly(
    backtest: HoldoutBacktest, rows: Sequence[dict[str, Any]]
) -> None:
    """`published_at == gate_at(target_date, gate_profile)`, to the instant.

    Compared against the ``gate_at`` the feature rows carry — which is the SQL
    function's own answer — and not against a gate recomputed here. A test that
    recomputed it would be asserting that two implementations agree, which is
    the thing this codebase spends a module docstring refusing to have.
    """
    gates = {row["target_date"]: row["gate_at"] for row in rows}
    for one in backtest.publications:
        assert one.published_at == gates[one.target_date]
        # And it is still a forecast: the counterfactual instant precedes every
        # hour it describes, which is what separates it from an observation.
        for hour in one.hours:
            assert one.published_at < hour.valid_time


def test_a_holdout_row_records_its_regime_the_way_a_served_row_does(
    backtest: HoldoutBacktest, first_day_served: ForecastPublication
) -> None:
    """Forecaster ticket 21 is open; a row written today says which rule it is.

    The point is not that the string is present — it is that it arrives by the
    *same* mechanism on both paths, so a change to the regime cannot reach one
    and miss the other.
    """
    for one in (first_day_served, backtest.publications[0]):
        payload = one.as_payload()
        assert payload["correction_regime"] == CORRECTION_REGIME
        for row in payload["hours"]:
            assert row["correction_regime"] == CORRECTION_REGIME
        for row in payload["days"]:
            assert row["correction_regime"] == CORRECTION_REGIME
    assert backtest.as_payload()["correction_regime"] == CORRECTION_REGIME


def test_the_band_is_the_served_composition_and_not_a_second_one(
    backtest: HoldoutBacktest, first_day_served: ForecastPublication
) -> None:
    """A replayed band must be the band the product would have shown.

    The same rows composed through the *serving* origin produce identical
    numbers: the two publications differ in their discriminator and in nothing
    else. That is the property that makes a replay a replay rather than a second
    model's opinion of the same day.
    """
    holdout = backtest.publications[0]
    assert holdout.target_date == first_day_served.target_date
    assert [hour.as_row() for hour in holdout.hours] == [
        hour.as_row() for hour in first_day_served.hours
    ]
    assert [day.as_row() for day in holdout.days] == [
        day.as_row() for day in first_day_served.days
    ]
    assert holdout.published_at == first_day_served.published_at
    # Only the origin differs, and the payload says which way round.
    assert (
        holdout.as_payload()["forecast_origin"]
        != (first_day_served.as_payload()["forecast_origin"])
    )


def test_the_day_band_is_the_ensembles_and_never_the_sum_of_the_hours(
    backtest: HoldoutBacktest,
) -> None:
    """`replay.md` forbids reconstructing a day total by summing quantiles."""
    for one in backtest.publications:
        by_subsystem: dict[str, list[Any]] = {}
        for hour in one.hours:
            by_subsystem.setdefault(hour.subsystem, []).append(hour)
        for day in one.days:
            row = day.as_row()
            assert row["derivation"] == "path_ensemble"
            summed = math.fsum(hour.p90_mwh for hour in by_subsystem[day.subsystem])
            assert row["day_total"]["p90"] != summed


# --- unservable by construction -----------------------------------------------


def test_nothing_in_the_module_can_mint_a_served_row() -> None:
    """The discriminator is a constant in the call, not an argument to it.

    A structural assertion, in the spirit of the gateway's "filtered in the
    query, not in a branch": a signature that *accepted* an origin kind would
    make unservability a property of every future call site instead of a
    property of this module.
    """
    signature = inspect.signature(fold_holdout_publications)
    assert "origin_kind" not in signature.parameters
    source = inspect.getsource(holdout_module)
    assert "BACKFILLED_HOLDOUT_ORIGIN_KIND" in source
    assert "SERVED_ORIGIN_KIND" not in source
    # And no second composition: the band comes from `build_publication`, which
    # is the function the serving path calls.
    assert source.count("build_publication(") == 1
    assert "compose(" not in source
    assert "forecast_rows(" not in source


def test_the_envelope_and_every_row_make_the_same_claim(
    backtest: HoldoutBacktest,
) -> None:
    """What the gateway's backfill writer refuses on, checked on this side too."""
    payload = backtest.as_payload()
    assert payload["fold_id"] == backtest.fold_id
    assert payload["artifact_id"] == backtest.artifact_id
    assert payload["lane"] == backtest.lane.directory_name
    assert payload["lane"].startswith(FEATURE_SET)
    for one in payload["publications"]:
        assert one["forecast_origin"]["origin_kind"] == payload["origin_kind"]
        assert one["forecast_origin"]["run_label"] == payload["artifact_id"]
        assert one["forecast_origin"]["gate_profile"] == GATE_PROFILE
        assert one["threshold_mw"] == THRESHOLD_MW


def test_the_checked_in_vector_is_still_the_shape_this_module_emits(
    backtest: HoldoutBacktest,
) -> None:
    """The other half of the cross-language seam.

    ``apps/api/test/fixtures/forecast/holdout-backfill.json`` is a payload this
    module produced, checked in so the gateway's backfill parser can be tested
    against the real thing — trimmed to one held-out day, because the keys are
    what the seam is about and a fold's whole test block is a megabyte of
    numbers nobody reads. Keys, not values: a renamed or dropped key is exactly
    the drift that would otherwise reach production as a `null`.

    Regenerate it when this assertion fails *and* the new shape is intended.
    """
    vector = json.loads(VECTOR.read_text(encoding="utf-8"))
    payload = backtest.as_payload()
    assert set(payload) == set(vector)
    assert payload["origin_kind"] == vector["origin_kind"] == "backfilled_holdout"
    assert set(payload["publications"][0]) == set(vector["publications"][0])
    assert set(payload["publications"][0]["forecast_origin"]) == set(
        vector["publications"][0]["forecast_origin"]
    )
    assert set(payload["publications"][0]["hours"][0]) == set(
        vector["publications"][0]["hours"][0]
    )
    assert set(payload["publications"][0]["days"][0]) == set(
        vector["publications"][0]["days"][0]
    )


# --- held out, asserted rather than trusted -----------------------------------


def test_a_day_inside_the_cards_base_fit_is_refused(
    rows: Sequence[dict[str, Any]], trained: TrainedFold, blocks: FoldBlocks
) -> None:
    """The run says held out and the artifact's card says fitted. The card wins.

    Constructed by moving the *card's* windows forward so the run's test block
    lands inside the base fit the artifact records. That is the only way a leak
    is representable — `FoldBlocks` refuses to be built with overlapping windows
    — and it is the shape the spec's read-time assertion is aimed at: the
    question "did this model see this day" is answered by the model's card.
    """
    with pytest.raises(HoldoutLeakError, match="base-fit"):
        fold_holdout_publications(
            rows,
            trained=_card_claiming(
                trained,
                dataclasses.replace(
                    blocks,
                    base_fit_end=blocks.test_end,
                    calibration_start=blocks.test_end + _ONE_DAY,
                    calibration_end=blocks.test_end + _ONE_DAY,
                    test_start=blocks.test_end + 2 * _ONE_DAY,
                    test_end=blocks.test_end + 2 * _ONE_DAY,
                ),
            ),
        )


def test_a_day_inside_the_cards_calibration_window_is_refused(
    rows: Sequence[dict[str, Any]], trained: TrainedFold, blocks: FoldBlocks
) -> None:
    """The subtler leak, and the one the spec names explicitly."""
    with pytest.raises(HoldoutLeakError, match="calibration"):
        fold_holdout_publications(
            rows,
            trained=_card_claiming(
                trained,
                dataclasses.replace(
                    blocks,
                    calibration_end=blocks.test_end,
                    test_start=blocks.test_end + _ONE_DAY,
                    test_end=blocks.test_end + _ONE_DAY,
                ),
            ),
        )


def test_a_fold_that_held_nothing_out_refuses(
    rows: Sequence[dict[str, Any]], trained: TrainedFold, blocks: FoldBlocks
) -> None:
    """No test rows is not an empty backtest; it is a fold with no holdout."""
    only_training = [row for row in rows if row["target_date"] < blocks.test_start]
    with pytest.raises(HoldoutLeakError, match="held nothing out"):
        fold_holdout_publications(only_training, trained=trained)


# --- helpers ------------------------------------------------------------------

_ONE_DAY = timedelta(days=1)


def _days(blocks: FoldBlocks) -> list[date]:
    """Every civil day of the test block, inclusive."""
    return [blocks.test_start + offset * _ONE_DAY for offset in range(blocks.test_days)]


def _card_claiming(trained: TrainedFold, blocks: FoldBlocks) -> TrainedFold:
    """The same fit, with a card that records different windows.

    The run's blocks are untouched, so the rows partition exactly as they did;
    only the artifact's own statement about what it was fitted on moves.
    """
    return dataclasses.replace(
        trained, card=dataclasses.replace(trained.card, blocks=blocks)
    )
