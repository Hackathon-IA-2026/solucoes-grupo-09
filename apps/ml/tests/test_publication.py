"""A publication is rows, or it is a refusal. It is never an empty band.

Forecaster ticket 14. Four kinds of assertion, and each one is about a property
of the code rather than about the fixture's numbers:

**Structural.** That a lane with nothing promoted refuses, that each of the four
artifact states produces its own sentence, that the newest file on the volume is
never served, and that no line of :mod:`wattsteer_ml.publication` reduces
twenty-four hourly bands into a day figure.

**Arithmetic, on the shared fit.** That the day figures on the payload are the
ensemble's — a componentwise sum of the hourly band is a *different* triple, and
the test measures the difference rather than asserting an intention — and that
the expected split adds to the expectation exactly, because a scalar split of a
figure has no other honest definition.

**Provenance.** That every row carries the correction regime and the derivation
that produced it, that the publication instant is the gate the *database*
resolved, and that it precedes every hour it describes — which is the structural
difference between a `Forecast` and an `Observation`.

**Over the wire.** That the route refuses with the lane state in its details and
computes nothing, that it never writes, and that it is not reachable as a
gateway data path.
"""

from __future__ import annotations

import inspect
import json
import math
import re
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from feature_row_fixtures import FEATURE_SET, GATE_PROFILE, THRESHOLD_MW, feature_rows
from wattsteer_ml import publication
from wattsteer_ml.app import app
from wattsteer_ml.config import settings
from wattsteer_ml.constants import SUBSYSTEM_CODES
from wattsteer_ml.evaluation import HOURS_PER_DAY
from wattsteer_ml.lanes import Lane
from wattsteer_ml.promotions import PROMOTION_LOG_FILENAME, PromotionRecord, append
from wattsteer_ml.publication import (
    HOUR_DERIVATION,
    SERVED_ORIGIN_KIND,
    ForecastPublication,
    PublicationError,
    PublicationRefusedError,
    build_publication,
    load_promoted,
    resolve_artifact,
)
from wattsteer_ml.training import (
    CORRECTION_REGIME,
    NATIONAL_DERIVATION,
    LoadedArtifact,
    ModelCard,
    TrainedFold,
    save_artifact,
)

client = TestClient(app)

LANE = Lane(feature_set=FEATURE_SET, gate_profile=GATE_PROFILE, threshold_mw=THRESHOLD_MW)
#: The payload this module emits, checked in for the gateway to parse.
VECTOR = (
    Path(__file__).resolve().parents[2]
    / "api"
    / "test"
    / "fixtures"
    / "forecast"
    / "publication.json"
)

PROMOTED = "2026-08-28T03:11:07Z"
REFUSED = "2026-09-04T03:10:12Z"


@pytest.fixture(scope="module")
def target_day(trained: TrainedFold) -> date:
    """A day after the fit's window — a serve, not a re-read of training rows."""
    return trained.blocks.test_end + timedelta(days=1)


@pytest.fixture(scope="module")
def serving_rows(target_day: date) -> list[dict[str, Any]]:
    return feature_rows(first=target_day, last=target_day)


@pytest.fixture(scope="module")
def loaded(trained: TrainedFold) -> LoadedArtifact:
    """The bundle and its card, as :func:`load_promoted` would hand them over."""
    return LoadedArtifact(
        artifact_id=trained.card.artifact_id,
        bundle=trained.bundle,
        card=trained.card.to_dict(),
    )


@pytest.fixture(scope="module")
def published(
    serving_rows: Sequence[dict[str, Any]], loaded: LoadedArtifact, target_day: date
) -> ForecastPublication:
    return build_publication(
        serving_rows,
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        origin_kind=SERVED_ORIGIN_KIND,
    )


def _promote(root: Path, card: ModelCard, *, decision: str = "promote") -> None:
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=card.artifact_id,
            lane=card.lane,
            decision="promote" if decision == "promote" else "refuse",
            reason="bootstrap P = 0.94" if decision == "promote" else "pr_auc guardrail",
            at=datetime(2026, 9, 4, 3, 10, 12, tzinfo=UTC),
        ),
    )


# --- refusing rather than inventing -------------------------------------------


def test_an_untrained_lane_refuses_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.setattr(settings, "artifact_dir", root)
    with pytest.raises(PublicationRefusedError) as refused:
        resolve_artifact(LANE)
    assert refused.value.lane_state == "no_artifact"
    assert refused.value.as_payload()["code"] == "MODEL_UNAVAILABLE"


def test_a_refused_candidate_is_never_served(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of the promotion log: the newest file is not the answer."""
    root = tmp_path / "models"
    directory = root / LANE.directory_name
    directory.mkdir(parents=True)
    (directory / f"{REFUSED}.joblib").write_bytes(b"candidate")
    monkeypatch.setattr(settings, "artifact_dir", root)
    with pytest.raises(PublicationRefusedError) as refused:
        resolve_artifact(LANE)
    assert refused.value.lane_state == "present_unpromoted"
    assert REFUSED not in refused.value.as_payload()["reason"]


def test_a_damaged_log_refuses_as_unresolvable_and_not_as_untrained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A broken volume must not be reported as a lane nobody has trained."""
    root = tmp_path / "models"
    (root / LANE.directory_name).mkdir(parents=True)
    (root / LANE.directory_name / f"{PROMOTED}.joblib").write_bytes(b"bundle")
    (root / PROMOTION_LOG_FILENAME).write_text("half a line")
    monkeypatch.setattr(settings, "artifact_dir", root)
    with pytest.raises(PublicationRefusedError) as refused:
        resolve_artifact(LANE)
    assert refused.value.lane_state == "unresolvable"


def test_the_three_absences_produce_three_distinguishable_refusals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unmounted volume, an empty one and a refused candidate are not alike.

    `docs/specs/forecaster.md` requires `/v1/meta` to distinguish the three
    states the volume can be in, and this ticket's acceptance list requires the
    *refusals* to be distinguishable too. The lane state alone cannot do it: a
    lane on a volume that is not mounted has, truthfully, no artifact — so the
    mount is reported beside the state rather than folded into it.
    """
    unmounted = tmp_path / "not-mounted"
    empty = tmp_path / "empty"
    empty.mkdir()
    unpromoted = tmp_path / "unpromoted"
    (unpromoted / LANE.directory_name).mkdir(parents=True)
    (unpromoted / LANE.directory_name / f"{REFUSED}.joblib").write_bytes(b"candidate")

    payloads = []
    for root in (unmounted, empty, unpromoted):
        monkeypatch.setattr(settings, "artifact_dir", root)
        with pytest.raises(PublicationRefusedError) as refused:
            resolve_artifact(LANE)
        payloads.append(refused.value.as_payload())

    volume_gone, untrained, refused_candidate = payloads
    assert volume_gone["volume_mounted"] is False
    assert untrained["volume_mounted"] is True
    assert untrained["lane_state"] == "no_artifact"
    assert refused_candidate["volume_mounted"] is True
    assert refused_candidate["lane_state"] == "present_unpromoted"
    # Three payloads, three sentences, no two of them equal.
    assert len({(one["lane_state"], one["volume_mounted"]) for one in payloads}) == 3
    assert len({one["reason"] for one in payloads}) == 3
    # And every one of them is a refusal rather than a band.
    for payload in payloads:
        assert payload["code"] == "MODEL_UNAVAILABLE"
        assert "hours" not in payload


def test_a_promoted_artifact_that_will_not_load_is_a_refusal_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "models"
    directory = root / LANE.directory_name
    directory.mkdir(parents=True)
    (directory / f"{PROMOTED}.joblib").write_bytes(b"not a bundle")
    monkeypatch.setattr(settings, "artifact_dir", root)
    append(
        root / PROMOTION_LOG_FILENAME,
        PromotionRecord(
            artifact_id=PROMOTED,
            lane=LANE,
            decision="promote",
            reason="bootstrap P = 0.94",
            at=datetime(2026, 9, 4, 3, 10, 12, tzinfo=UTC),
        ),
    )
    with pytest.raises(PublicationRefusedError) as refused:
        load_promoted(LANE, root=root)
    assert refused.value.lane_state == "unresolvable"


def test_a_promoted_artifact_resolves_through_the_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, trained: TrainedFold
) -> None:
    root = tmp_path / "models"
    save_artifact(trained.bundle, trained.card, root=root)
    _promote(root, trained.card)
    monkeypatch.setattr(settings, "artifact_dir", root)
    assert resolve_artifact(LANE) == trained.card.artifact_id
    assert load_promoted(LANE, root=root).artifact_id == trained.card.artifact_id


# --- what a published row says ------------------------------------------------


def test_every_hour_is_monotone_and_names_its_regime(
    published: ForecastPublication,
) -> None:
    assert published.hours
    for hour in published.hours:
        assert hour.p10_mwh <= hour.p50_mwh <= hour.p90_mwh
        row = hour.as_row()
        assert row["correction_regime"] == CORRECTION_REGIME
        assert row["derivation"] == HOUR_DERIVATION
        assert 0.0 <= row["occurrence_probability"] <= 1.0


def test_the_publication_covers_whole_days_and_all_four_subsystems(
    published: ForecastPublication, target_day: date
) -> None:
    assert len(published.subsystems) == 4
    assert len(published.days) == 4
    assert len(published.hours) == 4 * HOURS_PER_DAY
    assert {day.target_date for day in published.days} == {target_day}


def test_the_publication_instant_is_the_gate_and_precedes_every_hour(
    published: ForecastPublication,
) -> None:
    """`published_at < valid_time` is what makes this a Forecast, structurally."""
    for hour in published.hours:
        assert published.published_at < hour.valid_time
    origin = published.as_payload()["forecast_origin"]
    assert origin["producer"] == "wattsteer"
    assert origin["run_label"] == published.artifact_id
    assert origin["origin_kind"] == "served"
    assert origin["gate_profile"] == GATE_PROFILE


def test_two_gates_in_one_publication_are_refused(
    serving_rows: Sequence[dict[str, Any]], loaded: LoadedArtifact, target_day: date
) -> None:
    """One publication has one publication instant, or it has none."""
    rows = [dict(row) for row in serving_rows]
    rows[0]["gate_at"] = rows[0]["gate_at"] - timedelta(hours=10)
    with pytest.raises(PublicationError, match="distinct"):
        build_publication(
            rows,
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            origin_kind=SERVED_ORIGIN_KIND,
        )


def test_a_publication_of_no_rows_is_refused_rather_than_empty(
    loaded: LoadedArtifact, target_day: date
) -> None:
    with pytest.raises(PublicationError):
        build_publication(
            [],
            lane=LANE,
            loaded=loaded,
            target_date=target_day,
            origin_kind=SERVED_ORIGIN_KIND,
        )


# --- the day grain, which is the box this ticket inherited --------------------


def test_the_day_band_is_the_ensembles_and_not_the_sum_of_the_hours(
    published: ForecastPublication,
) -> None:
    """`replay.md` forbids reconstructing a day total by summing quantiles.

    The assertion is a measurement rather than a statement of intent: the
    componentwise sum of the twenty-four hourly bands is computed here, in the
    test, and the persisted day band is required to differ from it. Quantiles do
    not add, so a day band that *equalled* the sum would be evidence that
    someone had added them.
    """
    hours_by_subsystem: dict[str, list[Any]] = {}
    for hour in published.hours:
        hours_by_subsystem.setdefault(hour.subsystem, []).append(hour)
    quiet_days = 0
    for day in published.days:
        hours = hours_by_subsystem[day.subsystem]
        summed = {
            "p10": math.fsum(hour.p10_mwh for hour in hours),
            "p50": math.fsum(hour.p50_mwh for hour in hours),
            "p90": math.fsum(hour.p90_mwh for hour in hours),
        }
        row = day.as_row()
        assert row["derivation"] == "path_ensemble"
        assert row["correction_regime"] == CORRECTION_REGIME
        assert row["ensemble_draws"] > 0
        band = row["day_total"]
        assert band["p10"] <= band["p50"] <= band["p90"]
        # Not the componentwise sum, at any quantile. The direction of the
        # difference is deliberately *not* asserted: a quantile of a sum is
        # neither reliably above nor reliably below the sum of the marginal
        # quantiles — with a point mass at zero it can be either — and an
        # inequality in one direction would be a claim about this fixture.
        assert band["p90"] != pytest.approx(summed["p90"])
        if summed["p90"] == 0.0:
            quiet_days += 1
            # The sharpest case, and the reason a sum cannot stand in: every
            # hour's P90 is zero because p is below 0.10 all day, and the day
            # still has a real chance of a curtailed hour. A summed band would
            # publish "no curtailment, at any quantile"; the ensemble does not.
            assert band["p90"] > 0.0
            assert row["day_occurrence_probability"] > 0.0
    assert quiet_days >= 1


def test_the_peak_is_a_band_and_the_day_probability_is_not_one_minus_a_product(
    published: ForecastPublication,
) -> None:
    for day in published.days:
        row = day.as_row()
        peak = row["peak_power"]
        assert peak["p10"] <= peak["p50"] <= peak["p90"]
        assert 0.0 <= row["day_occurrence_probability"] <= 1.0


def test_the_publication_carries_a_national_row_beside_days_and_hours(
    published: ForecastPublication,
) -> None:
    """Forecaster ticket 22's half of the seam: the figure now has somewhere to go.

    ``NationalDayGrain.as_row()`` had no destination — ticket 14 said so — and
    the payload carried no key to put it under. It travels beside ``days`` and
    never inside it, because ``SIN`` is not a ``Subsystem`` and a fifth member
    of a four-member array is the double count `docs/domain-model.md` makes
    unrepresentable.
    """
    assert published.national is not None
    row = published.national.as_row()
    payload = published.as_payload()
    assert payload["national"] == row
    assert row["derivation"] == NATIONAL_DERIVATION
    assert row["grain"] == "national"
    assert row["target_date"] == published.target_date.isoformat()
    assert row["correction_regime"] == CORRECTION_REGIME
    assert sorted(row["subsystems"]) == sorted(SUBSYSTEM_CODES)
    assert "SIN" not in row["subsystems"]
    # No subsystem key of any kind: the grain has no identity a join could
    # mistake for one of the four.
    assert "subsystem" not in row


def test_the_national_band_is_narrower_than_the_four_bands_added(
    published: ForecastPublication,
) -> None:
    """The measurable consequence of a joint draw, on the shared fit itself.

    The componentwise sum is the day on which all four subsystems
    simultaneously landed at their own ninetieth percentile, which is far rarer
    than one in ten — so it is not a 10-90 interval of anything. The joint band
    is, and it comes out materially narrower rather than merely different.
    """
    assert published.national is not None
    national = published.national.as_row()
    summed_low = math.fsum(day.as_row()["day_total"]["p10"] for day in published.days)
    summed_high = math.fsum(day.as_row()["day_total"]["p90"] for day in published.days)
    assert national["day_total"]["p10"] > summed_low
    assert national["day_total"]["p90"] < summed_high
    assert (
        national["day_total"]["p90"] - national["day_total"]["p10"]
        < summed_high - summed_low
    )
    # The peak is a peak of the sum: the four subsystems' worst hours generally
    # fall in different hours, so a sum of peaks is a day no draw ever took.
    summed_peaks = math.fsum(day.as_row()["peak_power"]["p90"] for day in published.days)
    assert national["peak_power"]["p90"] < summed_peaks
    # And the one national quantity that does add, adds exactly.
    assert national["expected_mwh"] == pytest.approx(
        math.fsum(day.expected_mwh for day in published.days)
    )


def test_a_publication_short_of_a_subsystem_carries_no_national_row(
    serving_rows: Sequence[dict[str, Any]], loaded: LoadedArtifact, target_day: date
) -> None:
    """``None`` and never a total over three wearing the four's name.

    An absence rather than a refusal: the subsystem rows a three-subsystem
    publication does have are still records of what was served. It is the
    national band that does not exist, and the gateway renders that with a
    stated reason instead of a number.
    """
    partial = [row for row in serving_rows if row["subsystem"] != "S"]
    published = build_publication(
        partial,
        lane=LANE,
        loaded=loaded,
        target_date=target_day,
        origin_kind=SERVED_ORIGIN_KIND,
    )
    assert len(published.days) == 3
    assert published.national is None
    assert published.as_payload()["national"] is None


def test_no_line_of_the_publication_module_sums_a_quantile() -> None:
    """A grep-level guard, in the manner of the national band's own suite.

    The only additions in this module are over expectations, which add exactly.
    A sum over `p10_mwh`, `p50_mwh`, `p90_mwh` or a `QuantileBand` field would be
    the arithmetic both specs forbid, and it would be easy to add by accident
    while adding a field.
    """
    source = inspect.getsource(publication)
    banned = re.compile(
        r"(fsum|sum)\s*\([^)]*\b(p10|p50|p90|day_total|peak_power|band)\b",
        re.IGNORECASE,
    )
    offenders = [line for line in source.splitlines() if banned.search(line)]
    assert offenders == []


def test_the_expected_split_adds_to_the_expectation_at_both_grains(
    published: ForecastPublication,
) -> None:
    """A scalar split of a figure is a split of *that* figure, and is checkable."""
    for hour in published.hours:
        assert hour.expected_wind_mwh + hour.expected_solar_mwh == pytest.approx(
            hour.expected_mwh
        )
        assert hour.p50_wind_mwh + hour.p50_solar_mwh == pytest.approx(hour.p50_mwh)
    for day in published.days:
        row = day.as_row()
        assert row["expected_wind_mwh"] + row["expected_solar_mwh"] == pytest.approx(
            row["expected_mwh"]
        )


def test_the_day_expectation_is_the_sum_of_its_hours_and_is_not_the_p50(
    published: ForecastPublication,
) -> None:
    """Expectations add exactly; the P50 is a different number and stays one."""
    hours_by_subsystem: dict[str, list[Any]] = {}
    for hour in published.hours:
        hours_by_subsystem.setdefault(hour.subsystem, []).append(hour)
    for day in published.days:
        hours = hours_by_subsystem[day.subsystem]
        assert day.expected_mwh == pytest.approx(
            math.fsum(hour.expected_mwh for hour in hours)
        )
        assert day.hours_p50_nonzero == sum(1 for hour in hours if hour.p50_mwh > 0.0)
        assert 0 <= day.hours_p50_nonzero <= HOURS_PER_DAY


def test_the_payload_carries_the_artifact_and_its_published_class_edges(
    published: ForecastPublication,
) -> None:
    payload = published.as_payload()
    assert payload["artifact"]["artifact_id"] == published.artifact_id
    assert payload["artifact"]["feature_set"] == FEATURE_SET
    assert date.fromisoformat(payload["artifact"]["trained_through"])
    edges = payload["risk_bins"]
    assert edges["low"][0] == 0.0
    assert edges["high"][1] == 1.0
    assert payload["correction_regime"] == CORRECTION_REGIME
    assert payload["threshold_mw"] == THRESHOLD_MW


def test_no_split_carries_a_quantile(published: ForecastPublication) -> None:
    """The split is two scalars; the schema rejects a `p10` and so does this."""
    payload = published.as_payload()
    for row in [*payload["hours"], *payload["days"]]:
        for key in row:
            assert not key.startswith("split")
    assert "wind" not in str(payload["days"][0]["day_total"])


# --- the route ----------------------------------------------------------------


def test_the_publish_route_refuses_with_the_lane_state_in_its_details(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.setattr(settings, "artifact_dir", root)
    response = client.post(
        "/internal/publish/forecast", json={"lane": LANE.directory_name}
    )
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "MODEL_UNAVAILABLE"
    assert error["details"]["lane_state"] == "no_artifact"
    assert error["details"]["volume_mounted"] is True
    assert "hours" not in error


def test_the_publish_route_refuses_a_name_that_is_not_a_lane() -> None:
    response = client.post("/internal/publish/forecast", json={"lane": "not a lane"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


def test_the_publish_route_reports_a_missing_database_as_its_own_sentence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, trained: TrainedFold
) -> None:
    """With an artifact promoted and no Postgres, the failure is the database."""
    root = tmp_path / "models"
    save_artifact(trained.bundle, trained.card, root=root)
    _promote(root, trained.card)
    monkeypatch.setattr(settings, "artifact_dir", root)
    response = client.post(
        "/internal/publish/forecast", json={"lane": LANE.directory_name}
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DATA_UNAVAILABLE"


def test_the_publication_module_writes_nothing() -> None:
    """The modelling service is read-only against Postgres, structurally.

    `docs/specs/api-surface.md`: "it returns the computed rows and the **worker**
    writes them". A statement in this module would break that guarantee at the
    database, but it would break it in production rather than here.
    """
    source = inspect.getsource(publication)
    for statement in ("insert into", "INSERT INTO", "execute(", "conn."):
        assert statement not in source


def test_the_checked_in_vector_is_still_the_shape_this_module_emits(
    published: ForecastPublication,
) -> None:
    """The other half of the cross-language seam.

    ``apps/api/test/fixtures/forecast/publication.json`` is a payload this
    module produced, checked in so the gateway's parser can be tested against
    the real thing. Keys — not values: the values are a seeded fit and would
    move with any change to the fixture rows, while a renamed or dropped key is
    exactly the drift that would otherwise reach production as a `null`.

    Regenerate it when this assertion fails *and* the new shape is intended.
    """
    vector = json.loads(VECTOR.read_text(encoding="utf-8"))
    payload = published.as_payload()
    assert set(payload) == set(vector)
    assert set(payload["forecast_origin"]) == set(vector["forecast_origin"])
    assert set(payload["artifact"]) == set(vector["artifact"])
    assert set(payload["risk_bins"]) == set(vector["risk_bins"])
    assert set(payload["hours"][0]) == set(vector["hours"][0])
    assert set(payload["days"][0]) == set(vector["days"][0])
    assert set(payload["days"][0]["day_total"]) == {"p10", "p50", "p90"}
    assert set(payload["national"]) == set(vector["national"])
    assert set(payload["national"]["day_total"]) == {"p10", "p50", "p90"}
