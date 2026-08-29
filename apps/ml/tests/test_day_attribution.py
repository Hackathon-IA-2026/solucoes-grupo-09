"""The day, the hours that disagree, and how big the noise is.

`docs/specs/diagnosis.md` seam 6. The day attribution has no ground truth either,
so what is asserted is the arithmetic that makes it a decomposition:

- ``Φ_j == Σ_t φ_{j,t}`` **exactly**, and ``Σ_j Φ_j ==
  day_expected_mwh − baseline_expected_mwh`` **exactly**, on a seeded fixture.
  Both are bit-equality rather than ``approx``: the fixture's coalition values
  are dyadic, so every hour's local-accuracy residual is exactly zero and the day
  inherits nothing to drift on. In production the day inherits the 24 hours'
  float residuals and publishes their sum, which the constructor holds to the
  same bound one hour is held to.
- **24 hours were consumed**, asserted — the day is a Brasília civil date and not
  a UTC one, which is the feature spec's DST canary one layer up.
- ``hour_disagreement ≥ 1`` always, and ``== 1`` exactly when every hour shares a
  sign.
- **Shares are over all eight groups**, so they sum to 1 and a day whose drivers
  cancel still produces a full bar chart. The display cut is applied to the
  share, so defining the share over the displayed rows would have been circular.
- ``attribution_stderr_mwh`` is a bootstrap over the background sample, with the
  resample count recorded and the seed reproducing it.

The last test is the acceptance gate's own: four subsystems, one civil day each,
through the real boosters and the real composition, with the wall clock recorded
rather than asserted. A threshold there would be a claim about this machine.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest

from attribution_fixtures import (
    FixtureComposition,
    RowFunction,
    feature_names_of,
    full_factorial,
    synthetic_map,
)
from feature_row_fixtures import feature_rows
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.diagnosis.attribution import (
    EXPLAINS_CODE,
    AttributionError,
    LocalAccuracyError,
    attribute_hour,
    resample_hour,
)
from wattsteer_ml.diagnosis.background import (
    BACKGROUND_ROWS_PER_CELL,
    BASE_FIT_SOURCE,
    BackgroundCell,
    CellKey,
    MatchedBackground,
    draw_matched_background,
)
from wattsteer_ml.diagnosis.composed_target import bundle_expectation
from wattsteer_ml.diagnosis.day_attribution import (
    ATTRIBUTION_TARGET_DAY,
    BOTH_DIRECTIONS_THRESHOLD,
    NOTABLE_ROW_CAP,
    NOTABLE_SHARE_FLOOR,
    STDERR_RESAMPLES,
    DayAttribution,
    DayAttributionError,
    DayGroupContribution,
    IncompleteDayError,
    attribute_day,
    day_rows,
)
from wattsteer_ml.diagnosis.driver_groups import DRIVER_GROUP_CODES
from wattsteer_ml.diagnosis.shapley import exact_shapley, shapley_operator
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training import FeatureBlock, TrainedFold

# --- One player per column, so a day's arithmetic can be written down ---------
#
# The real map is data and `test_driver_groups.py` owns it. What a day sum needs
# is a partition whose game is small enough to solve on paper, over names no
# feature list will ever carry.

FIXTURE_MAP = synthetic_map(tuple((f"f{index}",) for index in range(8)))
FIXTURE_NAMES = feature_names_of(FIXTURE_MAP)
WIDTH = len(FIXTURE_NAMES)
FIXTURE_SUBSYSTEM: Subsystem = "NE"
FIXTURE_DATE = date(2026, 3, 4)


def _factorial_background() -> npt.NDArray[np.float64]:
    """Eight rows, ``±1`` on the first three columns and zero on the rest.

    Every column's mean is zero and every product of distinct columns averages to
    zero, so a multilinear game's coalition values collapse to the monomials the
    coalition holds entirely — and, with integer coefficients and integer
    targets, they are all multiples of ``1/8``. Dyadic, so every ``v(S)`` and
    every ``φ`` is exact in binary and seam 6's "exactly" is bit-equality rather
    than a hope.
    """
    design = np.zeros((8, WIDTH), dtype=np.float64)
    design[:, :3] = full_factorial(3)
    return design


def _day_background(
    *, subsystem: Subsystem = FIXTURE_SUBSYSTEM, seed: int = 7
) -> MatchedBackground:
    """The same cell shape at all 24 local hours — a whole day's background."""
    matrix = _factorial_background()
    cells = {}
    for local_hour in range(HOURS_PER_DAY):
        keys = tuple(
            RowKey(
                target_date=date(2025, 1, 1) + timedelta(days=offset),
                local_hour=local_hour,
                subsystem=subsystem,
            )
            for offset in range(matrix.shape[0])
        )
        cell = BackgroundCell(
            subsystem=subsystem,
            local_hour=local_hour,
            keys=keys,
            matrix=matrix.copy(),
        )
        cells[CellKey(subsystem=subsystem, local_hour=local_hour)] = cell
    return MatchedBackground(
        feature_names=FIXTURE_NAMES,
        rows_per_cell=matrix.shape[0],
        seed=seed,
        source=BASE_FIT_SOURCE,
        cells=cells,
    )


def _day_keys(
    *,
    subsystem: Subsystem = FIXTURE_SUBSYSTEM,
    target_date: date = FIXTURE_DATE,
) -> tuple[RowKey, ...]:
    return tuple(
        RowKey(target_date=target_date, local_hour=hour, subsystem=subsystem)
        for hour in range(HOURS_PER_DAY)
    )


def _integer_targets() -> npt.NDArray[np.float64]:
    """24 integer-valued rows, built so the day has something to say.

    Column 0 reverses across the day — positive in the afternoon, negative before
    dawn — which is exactly the "dominates at noon and reverses at dawn" the
    disagreement number exists to publish. Column 3 never changes sign, so its
    group's disagreement must come out at exactly ``1``. Column 1 cancels
    perfectly, so a zero ``Φ`` has a share to be zero *of*. Column 4 enters ``g``
    with a negative coefficient, so the day has a driver that lowers as well as
    drivers that raise.
    """
    rows = np.zeros((HOURS_PER_DAY, WIDTH), dtype=np.float64)
    for hour in range(HOURS_PER_DAY):
        rows[hour, 0] = 3.0 if hour >= 12 else -1.0
        rows[hour, 1] = 1.0 if hour % 2 == 0 else -1.0
        rows[hour, 2] = float(hour % 3)
        rows[hour, 3] = 2.0
        rows[hour, 4] = float(hour % 2)
    return rows


def _integer_game() -> RowFunction:
    """``g`` with integer coefficients — dyadic coalition values, exact ``φ``."""
    return RowFunction(
        lambda row: (
            4.0 * float(row[0])
            + 2.0 * float(row[1])
            + float(row[2]) * float(row[3])
            - float(row[4])
        )
    )


def _fixture_day(
    *,
    targets: npt.NDArray[np.float64] | None = None,
    game: Any = None,
    stderr_resamples: int = 32,
    stderr_seed: int = 4,
) -> DayAttribution:
    return attribute_day(
        keys=_day_keys(),
        target_rows=_integer_targets() if targets is None else targets,
        background=_day_background(),
        expectation=_integer_game() if game is None else game,
        group_map=FIXTURE_MAP,
        stderr_resamples=stderr_resamples,
        stderr_seed=stderr_seed,
    )


# --- The game, re-solved as the linear map it is ------------------------------


def test_the_operator_is_the_enumeration_written_as_a_matrix() -> None:
    """The bootstrap re-solves the game 200 times; it must be the same game.

    ``φ = M · v`` is the definition rearranged, so the two agree to the
    arithmetic. They are not required to agree to the bit — the published ``φ``
    is the :func:`math.fsum` one and always will be — and the operator exists
    only where a *spread* is wanted and 200 enumerations are not affordable.
    """
    generator = np.random.default_rng(19)
    for players in (2, 5, 8):
        operator = np.asarray(shapley_operator(players), dtype=np.float64)
        assert operator.shape == (players, 1 << players)
        for _ in range(4):
            values = generator.normal(size=1 << players) * 10.0
            by_matrix = operator @ values
            by_enumeration = exact_shapley(
                [float(one) for one in values], players=players
            )
            assert by_matrix == pytest.approx(by_enumeration, abs=1e-12)


def test_a_bootstrap_cannot_be_run_on_an_hour_that_kept_no_block() -> None:
    """Silently returning zeros would publish "this ranking is certain"."""
    hour = attribute_hour(
        key=_day_keys()[14],
        target_row=_integer_targets()[14],
        background=_day_background(),
        expectation=_integer_game(),
        group_map=FIXTURE_MAP,
    )
    assert hour.coalition_rows is None
    with pytest.raises(AttributionError, match="kept no coalition block"):
        resample_hour(hour, resamples=8, generator=np.random.default_rng(1))


# --- Seam 6 — the day sum, exactly --------------------------------------------


def test_one_subsystem_and_one_date_yield_eight_signed_day_contributions() -> None:
    day = _fixture_day()
    assert day.target == ATTRIBUTION_TARGET_DAY == "expected_mwh_day"
    assert day.subsystem == FIXTURE_SUBSYSTEM
    assert day.target_date == FIXTURE_DATE
    assert len(day.contributions) == len(DRIVER_GROUP_CODES) == 8
    assert sorted(one.code for one in day.contributions) == sorted(DRIVER_GROUP_CODES)
    shares = [one.share for one in day.contributions]
    assert shares == sorted(shares, reverse=True), "ranked by |share|"
    assert any(one.phi_mwh > 0.0 for one in day.contributions)
    assert any(one.phi_mwh < 0.0 for one in day.contributions)
    for one in day.contributions:
        assert one.direction == ("lowers" if one.phi_mwh < 0.0 else "raises")


def test_the_day_value_is_exactly_the_hour_wise_sum() -> None:
    """``Φ_j == Σ_t φ_{j,t}``, bit for bit, against a seeded fixture."""
    day = _fixture_day()
    assert len(day.hours) == HOURS_PER_DAY
    for code in DRIVER_GROUP_CODES:
        hourly = tuple(hour.contribution(code).phi_mwh for hour in day.hours)
        assert day.contribution(code).hourly_phi_mwh == hourly
        assert day.contribution(code).phi_mwh == math.fsum(hourly)


def test_the_eight_day_contributions_sum_exactly_to_the_day_movement() -> None:
    """``Σ_j Φ_j == day_expected_mwh − baseline_expected_mwh``, exactly.

    Exact because the fixture is dyadic: every hour's own local-accuracy residual
    is zero, so the day has nothing to inherit. The constructor holds production
    to the arithmetic's own bound instead, and publishes what it inherited.
    """
    day = _fixture_day()
    assert max(abs(hour.local_accuracy_residual_mwh) for hour in day.hours) == 0.0
    assert day.local_accuracy_residual_mwh == 0.0
    assert day.total_attributed_mwh == day.day_expected_mwh - day.baseline_expected_mwh
    assert day.day_expected_mwh == math.fsum(hour.expected_mwh for hour in day.hours)
    assert day.baseline_expected_mwh == math.fsum(
        hour.baseline_expected_mwh for hour in day.hours
    )


def test_the_day_movement_holds_on_the_real_composition_too() -> None:
    """The same identity where the residual is float rather than zero.

    ``g`` here is :func:`wattsteer_ml.mixture.compose` over two linear scores, so
    the coalition values are not dyadic and the day inherits 24 hours' worth of
    float residual. The bound is the one the hour is held to, scaled by the day.
    """
    generator = np.random.default_rng(23)
    day = _fixture_day(
        targets=generator.normal(size=(HOURS_PER_DAY, WIDTH)) * 2.0,
        game=FixtureComposition(
            occurrence=lambda row: 1.0 / (1.0 + math.exp(-float(np.sum(row[:4])))),
            magnitude_weights=tuple(generator.normal(size=WIDTH) * 3.0),
            sub_threshold_mean_mwh=1.5,
        ),
    )
    movement = day.day_expected_mwh - day.baseline_expected_mwh
    assert day.total_attributed_mwh == pytest.approx(movement, abs=1e-9)
    assert day.local_accuracy_residual_mwh == pytest.approx(0.0, abs=1e-9)


def test_a_day_whose_contributions_do_not_add_up_cannot_be_constructed() -> None:
    """Local accuracy is checked at construction, not by the tests alone."""
    day = _fixture_day()
    with pytest.raises(LocalAccuracyError):
        DayAttribution(
            subsystem=day.subsystem,
            target_date=day.target_date,
            target=day.target,
            contributions=day.contributions,
            baseline_expected_mwh=day.baseline_expected_mwh,
            day_expected_mwh=day.day_expected_mwh + 500.0,
            local_accuracy_residual_mwh=0.0,
            hours_attributed=HOURS_PER_DAY,
            peak_hour_local=day.peak_hour_local,
            peak_hour=day.peak_hour,
            attribution_stderr_mwh=day.attribution_stderr_mwh,
            baseline_stderr_mwh=day.baseline_stderr_mwh,
            stderr_resamples=day.stderr_resamples,
            stderr_seed=day.stderr_seed,
            background_rows=day.background_rows,
            background_seed=day.background_seed,
            background_source=day.background_source,
            coalitions=day.coalitions,
            elapsed_seconds=day.elapsed_seconds,
            driver_group_version=day.driver_group_version,
            driver_group_hash=day.driver_group_hash,
        )


# --- 24 hours, and the civil day they belong to -------------------------------


def test_twenty_four_hours_are_consumed_and_recorded() -> None:
    day = _fixture_day()
    assert day.hours_attributed == HOURS_PER_DAY == 24
    assert [hour.key.local_hour for hour in day.hours] == list(range(24))
    assert day.to_payload()["hours_attributed"] == 24


@pytest.mark.parametrize("hours", [23, 25])
def test_a_day_that_is_not_twenty_four_hours_is_refused(hours: int) -> None:
    """The DST canary. A short day is a smaller number that looks like a small day."""
    keys = _day_keys()[: min(hours, HOURS_PER_DAY)]
    if hours > HOURS_PER_DAY:
        keys = (*keys, keys[-1])
    with pytest.raises(IncompleteDayError):
        attribute_day(
            keys=keys,
            target_rows=_integer_targets()[: len(keys)],
            background=_day_background(),
            expectation=_integer_game(),
            group_map=FIXTURE_MAP,
            stderr_resamples=4,
        )


def test_a_day_that_repeats_an_hour_is_refused() -> None:
    """23 keys and a duplicate is still 24 rows, and still not a day."""
    keys = list(_day_keys())
    keys[5] = keys[6]
    with pytest.raises(IncompleteDayError, match="each exactly once"):
        attribute_day(
            keys=keys,
            target_rows=_integer_targets(),
            background=_day_background(),
            expectation=_integer_game(),
            group_map=FIXTURE_MAP,
            stderr_resamples=4,
        )


def test_two_civil_dates_are_not_one_day() -> None:
    keys = list(_day_keys())
    keys[3] = RowKey(
        target_date=FIXTURE_DATE + timedelta(days=1),
        local_hour=3,
        subsystem=FIXTURE_SUBSYSTEM,
    )
    with pytest.raises(DayAttributionError, match="one \\(subsystem, target_date\\)"):
        attribute_day(
            keys=keys,
            target_rows=_integer_targets(),
            background=_day_background(),
            expectation=_integer_game(),
            group_map=FIXTURE_MAP,
            stderr_resamples=4,
        )


def test_the_day_is_selected_by_the_brasilia_civil_date() -> None:
    """``day_rows`` picks 24 rows out of a block by the key's own civil date."""
    generator = np.random.default_rng(5)
    keys: list[RowKey] = []
    for offset in (-1, 0, 1):
        for subsystem in ("NE", "N"):
            for hour in range(HOURS_PER_DAY):
                keys.append(
                    RowKey(
                        target_date=FIXTURE_DATE + timedelta(days=offset),
                        local_hour=hour,
                        subsystem=subsystem,
                    )
                )
    matrix = generator.normal(size=(len(keys), WIDTH))
    chosen, rows = day_rows(keys, matrix, subsystem="NE", target_date=FIXTURE_DATE)
    assert [key.local_hour for key in chosen] == list(range(24))
    assert {key.subsystem for key in chosen} == {"NE"}
    assert {key.target_date for key in chosen} == {FIXTURE_DATE}
    assert rows.shape == (24, WIDTH)
    for position, key in enumerate(chosen):
        assert np.array_equal(rows[position], matrix[keys.index(key)])


def test_a_block_missing_an_hour_stops_at_selection() -> None:
    keys = [key for key in _day_keys() if key.local_hour != 2]
    matrix = np.zeros((len(keys), WIDTH), dtype=np.float64)
    with pytest.raises(IncompleteDayError):
        day_rows(keys, matrix, subsystem=FIXTURE_SUBSYSTEM, target_date=FIXTURE_DATE)


# --- The disagreement the sum would otherwise hide ----------------------------


def test_hour_disagreement_is_at_least_one_and_exactly_one_on_one_sign() -> None:
    day = _fixture_day()
    for one in day.contributions:
        assert one.hour_disagreement >= 1.0
        signs = {math.copysign(1.0, value) for value in one.hourly_phi_mwh if value}
        if len(signs) <= 1:
            assert one.hour_disagreement == 1.0
            assert not one.acts_in_both_directions
        else:
            assert one.hour_disagreement > 1.0


def test_a_driver_that_reverses_across_the_day_is_flagged() -> None:
    """Column 0 is ``+3`` after noon and ``−1`` before it — the noon/dawn case."""
    day = _fixture_day()
    reversing = day.contribution(DRIVER_GROUP_CODES[0])
    assert min(reversing.hourly_phi_mwh) < 0.0 < max(reversing.hourly_phi_mwh)
    assert reversing.hour_disagreement > 1.0
    steady = day.contribution(DRIVER_GROUP_CODES[3])
    assert min(steady.hourly_phi_mwh) >= 0.0
    assert steady.hour_disagreement == 1.0


def test_the_flag_is_a_named_threshold_and_not_a_buried_literal() -> None:
    assert BOTH_DIRECTIONS_THRESHOLD == 2.0
    hourly = (3.0, -2.0) + (0.0,) * 22
    both = DayGroupContribution(
        code=DRIVER_GROUP_CODES[0],
        label_code="driver.x",
        phi_mwh=1.0,
        share=0.5,
        direction="raises",
        hour_disagreement=5.0,
        hourly_phi_mwh=hourly,
    )
    assert both.acts_in_both_directions
    assert both.to_payload()["hour_disagreement"] == 5.0


def test_a_disagreement_below_one_is_not_a_quantity_that_exists() -> None:
    """``Σ|φ_t| ≥ |Σ φ_t|`` is a triangle inequality, so below 1 is a bug."""
    with pytest.raises(DayAttributionError, match="triangle inequality"):
        DayGroupContribution(
            code=DRIVER_GROUP_CODES[0],
            label_code="driver.x",
            phi_mwh=1.0,
            share=0.5,
            direction="raises",
            hour_disagreement=0.5,
            hourly_phi_mwh=(0.0,) * HOURS_PER_DAY,
        )


def test_a_group_that_did_nothing_pulled_the_same_way_in_every_hour() -> None:
    """All 24 hours exactly zero is vacuously one-signed, and reports ``1.0``."""
    zeros = np.zeros((HOURS_PER_DAY, WIDTH), dtype=np.float64)
    day = _fixture_day(targets=zeros, stderr_resamples=8)
    for one in day.contributions:
        assert one.hour_disagreement >= 1.0
    idle = day.contribution(DRIVER_GROUP_CODES[7])
    assert idle.phi_mwh == 0.0
    assert idle.hour_disagreement == 1.0


# --- Shares, over all eight groups --------------------------------------------


def test_shares_sum_to_one_and_are_shares_of_attributed_movement() -> None:
    day = _fixture_day()
    assert math.fsum(one.share for one in day.contributions) == pytest.approx(
        1.0, abs=1e-12
    )
    denominator = day.sum_abs_attributed_mwh
    for one in day.contributions:
        assert one.share == pytest.approx(abs(one.phi_mwh) / denominator, abs=1e-15)
    # Not a share of the day's curtailment, and not of "the attributed
    # magnitude": the denominator is Σ_k |Φ_k| and nothing else.
    assert denominator != pytest.approx(day.day_expected_mwh)


def test_a_day_whose_drivers_cancel_still_produces_a_full_bar_chart() -> None:
    """The whole reason the share is over ``Σ|Φ|`` rather than over the movement."""
    day = _fixture_day()
    cancelling = day.contribution(DRIVER_GROUP_CODES[1])
    assert abs(cancelling.phi_mwh) < 1e-9
    assert math.fsum(one.share for one in day.contributions) == pytest.approx(1.0)
    assert all(one.share >= 0.0 for one in day.contributions)


def test_a_day_with_no_movement_at_all_takes_no_shares_of_it() -> None:
    zeros = np.zeros((HOURS_PER_DAY, WIDTH), dtype=np.float64)
    day = _fixture_day(targets=zeros, stderr_resamples=8)
    assert day.sum_abs_attributed_mwh == 0.0
    assert all(one.share == 0.0 for one in day.contributions)


def test_the_selection_predicate_is_shared_and_the_merge_is_not() -> None:
    """The server picks the notable groups; the client merges the rest."""
    day = _fixture_day()
    notable = day.notable()
    assert len(notable) <= NOTABLE_ROW_CAP
    assert all(one.share >= NOTABLE_SHARE_FLOOR for one in notable)
    assert list(notable) == [
        one
        for one in day.contributions[:NOTABLE_ROW_CAP]
        if one.share >= NOTABLE_SHARE_FLOOR
    ]
    # All eight still go on the wire, whatever the cut leaves out, and nothing
    # here has merged a group into another or produced a "mixed" direction.
    assert len(day.to_payload()["groups"]) == 8
    assert all(
        group["direction"] in {"raises", "lowers"} for group in day.to_payload()["groups"]
    )
    assert "other" not in {group["code"] for group in day.to_payload()["groups"]}


def test_the_top_two_share_is_precomputed_so_the_renderer_never_adds() -> None:
    day = _fixture_day()
    assert day.top_two_share == pytest.approx(
        day.contributions[0].share + day.contributions[1].share, abs=1e-15
    )
    assert day.to_payload()["top_two_share"] == day.top_two_share


# --- The peak hour, beside the day and never instead of it --------------------


def test_the_peak_hour_and_its_local_hour_are_returned_beside_the_day() -> None:
    day = _fixture_day()
    peak = max(hour.expected_mwh for hour in day.hours)
    assert day.peak_hour.expected_mwh == peak
    assert day.peak_hour_local == day.peak_hour.key.local_hour
    assert len(day.peak_hour.contributions) == 8
    payload = day.to_payload()
    assert payload["peak_hour_local"] == day.peak_hour_local
    assert [group["code"] for group in payload["peak_hour_groups"]] == [
        one.code for one in day.peak_hour.contributions
    ]
    # Beside, never instead: the headline ranking is the day's.
    assert [group["code"] for group in payload["groups"]] == [
        one.code for one in day.contributions
    ]


def test_the_peak_hour_ranking_may_differ_from_the_day_ranking() -> None:
    """Which is the reason the spec returns both rather than one."""
    day = _fixture_day()
    assert day.peak_hour.contributions[0].code in set(DRIVER_GROUP_CODES)
    assert day.peak_hour.target == "expected_mwh_hour"
    assert day.target == "expected_mwh_day"


# --- The ranking's own error --------------------------------------------------


def test_the_standard_error_is_a_bootstrap_with_its_count_recorded() -> None:
    day = _fixture_day(stderr_resamples=64, stderr_seed=11)
    assert day.stderr_resamples == 64
    assert day.stderr_seed == 11
    assert day.attribution_stderr_mwh > 0.0
    assert day.baseline_stderr_mwh >= 0.0
    payload = day.to_payload()
    assert payload["stderr_mwh"] == day.attribution_stderr_mwh
    assert payload["stderr_resamples"] == 64
    assert day.timing_fields()["stderr_resamples"] == 64


def test_the_spec_ships_two_hundred_resamples() -> None:
    assert STDERR_RESAMPLES == 200


def test_the_same_seed_reproduces_the_error_and_a_different_one_does_not() -> None:
    """Reproducible from the artifact and the day, which is why the seed is stored."""
    first = _fixture_day(stderr_resamples=64, stderr_seed=11)
    again = _fixture_day(stderr_resamples=64, stderr_seed=11)
    other = _fixture_day(stderr_resamples=64, stderr_seed=12)
    assert first.attribution_stderr_mwh == again.attribution_stderr_mwh
    assert first.attribution_stderr_mwh != other.attribution_stderr_mwh
    # The published ranking does not move with the bootstrap's seed — only its
    # error bar does.
    assert [one.phi_mwh for one in first.contributions] == [
        one.phi_mwh for one in other.contributions
    ]


def test_a_background_every_row_of_which_is_identical_has_no_sampling_error() -> None:
    """A bootstrap of a constant is a constant, so the error bar is exactly zero."""
    matrix = np.tile(np.arange(WIDTH, dtype=np.float64), (8, 1))
    cells = {}
    for hour in range(HOURS_PER_DAY):
        keys = tuple(
            RowKey(
                target_date=date(2025, 1, 1) + timedelta(days=offset),
                local_hour=hour,
                subsystem=FIXTURE_SUBSYSTEM,
            )
            for offset in range(matrix.shape[0])
        )
        cells[CellKey(subsystem=FIXTURE_SUBSYSTEM, local_hour=hour)] = BackgroundCell(
            subsystem=FIXTURE_SUBSYSTEM,
            local_hour=hour,
            keys=keys,
            matrix=matrix.copy(),
        )
    background = MatchedBackground(
        feature_names=FIXTURE_NAMES,
        rows_per_cell=matrix.shape[0],
        seed=3,
        source=BASE_FIT_SOURCE,
        cells=cells,
    )
    day = attribute_day(
        keys=_day_keys(),
        target_rows=_integer_targets(),
        background=background,
        expectation=_integer_game(),
        group_map=FIXTURE_MAP,
        stderr_resamples=32,
        stderr_seed=2,
    )
    assert day.attribution_stderr_mwh == pytest.approx(0.0, abs=1e-12)
    assert day.baseline_stderr_mwh == pytest.approx(0.0, abs=1e-12)
    assert not day.ranking_is_noise


def test_a_ranking_smaller_than_its_own_error_says_so() -> None:
    """The predicate ``attribution_is_noise`` evaluates, computed beside its inputs."""
    day = _fixture_day()
    assert day.ranking_is_noise == (
        day.sum_abs_attributed_mwh <= 2.0 * day.attribution_stderr_mwh
    )


@pytest.mark.parametrize("resamples", [0, 1])
def test_a_day_without_a_bootstrap_is_refused(resamples: int) -> None:
    """One replicate has no spread, and a NaN error bar compares false everywhere."""
    with pytest.raises(DayAttributionError, match="not optional"):
        _fixture_day(stderr_resamples=resamples)


# --- The payload --------------------------------------------------------------


def test_the_payload_says_what_it_explains_and_carries_no_band() -> None:
    day = _fixture_day()
    payload = day.to_payload()
    assert payload["target"] == "expected_mwh_day"
    assert payload["explains"] == EXPLAINS_CODE
    assert "band" not in payload
    assert "p10" not in payload and "p90" not in payload
    assert payload["target_date"] == FIXTURE_DATE.isoformat()
    assert payload["subsystem"] == FIXTURE_SUBSYSTEM
    assert payload["driver_group_hash"] == FIXTURE_MAP.driver_group_hash
    assert payload["total_attributed_mwh"] == pytest.approx(
        payload["day_expected_mwh"] - payload["baseline_expected_mwh"], abs=1e-9
    )
    assert set(payload["groups"][0]) == {
        "code",
        "label_code",
        "phi_mwh",
        "share",
        "direction",
        "hour_disagreement",
    }


def test_the_day_does_not_carry_twenty_four_coalition_blocks() -> None:
    """Each hour's block is dropped as soon as the bootstrap has resampled it."""
    day = _fixture_day()
    assert all(hour.coalition_rows is None for hour in day.hours)
    assert day.peak_hour.coalition_rows is None


# --- The acceptance gate: four subsystems, one civil day each ------------------


def _bundle_group_map(feature_names: Sequence[str]) -> Any:
    """An eight-group map over the columns the fixture contract actually has.

    The same construction `test_grouped_shapley.py` uses and for the same reason:
    the feature builder has landed a fraction of the feature table, so the real
    map's eight groups do not all have a column in it, and ``group_columns``
    refuses a player who cannot move. Which column sits in which group does not
    change what the enumeration costs, which is what this file measures.
    """
    buckets: list[list[str]] = [[] for _ in DRIVER_GROUP_CODES]
    for index, name in enumerate(feature_names):
        buckets[index % len(DRIVER_GROUP_CODES)].append(name)
    return synthetic_map(tuple(tuple(bucket) for bucket in buckets))


def test_the_four_subsystems_complete_inside_the_publication_budget(
    trained: TrainedFold, record_property: Any
) -> None:
    """Four day attributions through the real boosters, with the wall clock recorded.

    Everything real except the grouping: the bundle's six boosters, its isotonic
    map, its conformal correction, its ``μ_sub`` table and
    :func:`wattsteer_ml.mixture.compose`, reached through
    :func:`wattsteer_ml.training.expected_mwh_for_block` so the explained
    quantity is the served one.

    The budget is recorded rather than asserted. A threshold here would be a
    claim about this machine; the number is what lets the publication budget be
    argued about at all — one lane publication is these four days.
    """
    bundle = trained.bundle
    group_map = _bundle_group_map(bundle.contract.feature_names)

    # The conftest fold's base-fit window is thirty days, which is thirty rows
    # per cell — a quarter of the sample the spec ships. The recorded wall clock
    # has to be the real one, so the window is widened to the 160 days a 128-row
    # cell needs. Nothing else about the instances changes.
    base_fit = FeatureBlock.of(
        feature_rows(
            first=trained.blocks.base_fit_end - timedelta(days=159),
            last=trained.blocks.base_fit_end,
        ),
        bundle.contract,
        threshold_mw=bundle.threshold_mw,
    )
    background = draw_matched_background(
        base_fit, seed=20_260_829, rows_per_cell=BACKGROUND_ROWS_PER_CELL
    )

    target_date = trained.blocks.test_start
    target_block = FeatureBlock.of(
        feature_rows(first=target_date, last=target_date),
        bundle.contract,
        threshold_mw=bundle.threshold_mw,
    )

    days: list[DayAttribution] = []
    for subsystem in SUBSYSTEM_CODES:
        keys, rows = day_rows(
            target_block.keys,
            target_block.matrix,
            subsystem=subsystem,
            target_date=target_date,
        )
        days.append(
            attribute_day(
                keys=keys,
                target_rows=rows,
                background=background,
                expectation=bundle_expectation(bundle),
                group_map=group_map,
                stderr_seed=20_260_829,
            )
        )

    for day in days:
        assert day.hours_attributed == 24
        assert day.coalitions == 256
        assert day.background_rows == BACKGROUND_ROWS_PER_CELL == 128
        assert len(day.contributions) == 8
        assert day.day_expected_mwh >= 0.0
        assert day.baseline_expected_mwh >= 0.0
        assert math.fsum(one.share for one in day.contributions) == pytest.approx(1.0)
        assert all(one.hour_disagreement >= 1.0 for one in day.contributions)
        assert day.attribution_stderr_mwh >= 0.0
        assert day.stderr_resamples == STDERR_RESAMPLES == 200
        assert 0 <= day.peak_hour_local < 24
        assert day.total_attributed_mwh == pytest.approx(
            day.day_expected_mwh - day.baseline_expected_mwh,
            abs=1e-9 * max(1.0, day.day_expected_mwh),
        )

    lane_seconds = math.fsum(day.elapsed_seconds for day in days)
    hour_seconds = math.fsum(hour.elapsed_seconds for day in days for hour in day.hours)
    evaluations = sum(day.timing_fields()["row_evaluations"] for day in days)
    instances = len(days) * HOURS_PER_DAY
    record_property("diagnosis_day_lane_seconds", lane_seconds)
    record_property("diagnosis_day_enumeration_seconds", hour_seconds)
    record_property("diagnosis_day_row_evaluations", evaluations)
    print(
        f"\nday attribution: {len(days)} subsystems × {HOURS_PER_DAY} hours = "
        f"{instances} instances, {evaluations} row evaluations, "
        f"{lane_seconds:.1f} s for the lane "
        f"({lane_seconds / instances:.2f} s per instance) — of which "
        f"{hour_seconds:.1f} s is the enumeration and "
        f"{lane_seconds - hour_seconds:.1f} s the "
        f"{STDERR_RESAMPLES}-resample bootstrap"
    )
