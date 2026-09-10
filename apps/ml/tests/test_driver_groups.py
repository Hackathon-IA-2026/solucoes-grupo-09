"""The group map is a total partition, and it fails when a feature appears.

`docs/specs/diagnosis.md` seam 4. Every test here asserts a property of the
*construction* rather than a value, except the two that pin the version and the
hash — and those exist precisely so that a change to the map cannot be silent.

The test that matters most is
:func:`test_a_feature_added_upstream_and_left_ungrouped_fails`. It is the reason
the map has no catch-all: a feature nobody placed must stop the build, so the
fix is a line in the YAML rather than a silent landing in `data_conditions`.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from pathlib import Path

import pytest
import yaml

from wattsteer_ml.driver_groups import (
    DRIVER_GROUP_CODES,
    DRIVER_GROUP_MAP,
    DRIVER_GROUPS_PATH,
    MODEL_INPUTS_GENERATOR,
    MODEL_INPUTS_PATH,
    MODEL_INPUTS_SOURCE,
    UNIT_CODES,
    DriverGroup,
    DriverGroupMap,
    DriverGroupMapError,
    IdeaDriver,
    UngroupedFeatureError,
    assert_total_partition,
    card_partition_fault,
    load_driver_group_map,
    load_model_inputs,
)

FEATURE_SETS = load_model_inputs()

#: Every name the map must cover: the union over both feature sets. Set B is set
#: A plus the DESSEM block, but the union is what has to be total — a model of
#: either set must be able to rank all eight groups.
ALL_FEATURES: tuple[str, ...] = tuple(
    dict.fromkeys(name for names in FEATURE_SETS.values() for name in names)
)

#: The map's identity, pinned. Editing `driver_groups.yaml` in a way that moves a
#: feature between groups, adds one or removes one changes this, and the diff
#: says so on the same line as the edit. Reformatting the YAML does not.
#:
#: A change here is a product-visible event: it re-ranks the Explain screen and
#: invalidates every cached narration.
EXPECTED_VERSION = 2
EXPECTED_HASH = "sha256:aab7c87c5cfa0cbd34718b0b8fb8bb3ef74fdec6c97d59655fd692962fb9d1eb"


def _map_with(
    groups: tuple[DriverGroup, ...] | None = None,
    idea_drivers: tuple[IdeaDriver, ...] | None = None,
) -> DriverGroupMap:
    """The real map with one part replaced — for the failure-mode tests.

    Constructed rather than written to a file, because the validation lives in
    :class:`DriverGroupMap` and not in the reader: a map assembled in memory has
    to be rejected exactly as one read off disk is.
    """
    return DriverGroupMap(
        version=DRIVER_GROUP_MAP.version,
        groups=DRIVER_GROUP_MAP.groups if groups is None else groups,
        idea_drivers=(
            DRIVER_GROUP_MAP.idea_drivers if idea_drivers is None else idea_drivers
        ),
    )


def _with_members(code: str, members: tuple[str, ...]) -> tuple[DriverGroup, ...]:
    """The eight groups with one group's membership swapped."""
    return tuple(
        dataclasses.replace(group, members=members) if group.code == code else group
        for group in DRIVER_GROUP_MAP.groups
    )


# --- the eight groups ---------------------------------------------------------


def test_there_are_exactly_eight_groups_and_they_are_the_specs_eight() -> None:
    assert tuple(group.code for group in DRIVER_GROUP_MAP.groups) == DRIVER_GROUP_CODES


def test_every_group_declares_a_label_code_a_headline_feature_and_a_unit() -> None:
    for group in DRIVER_GROUP_MAP.groups:
        assert group.label_code == f"driver.{group.code}"
        assert group.headline_feature in group.members
        assert group.unit in UNIT_CODES
        assert group.mechanism.strip()


def test_a_headline_feature_is_present_in_every_feature_set() -> None:
    """Otherwise a `dessem_free_v1` model puts a NULL on screen.

    This is why `export_stress` heads on the observed 24-hour utilisation mean
    rather than on `dessem_export_utilisation`, which exists only in set B.
    """
    for group in DRIVER_GROUP_MAP.groups:
        for set_name, names in FEATURE_SETS.items():
            assert group.headline_feature in names, (
                f"{group.code} heads on {group.headline_feature}, "
                f"which {set_name} does not carry"
            )


def test_data_conditions_is_a_declared_membership_and_not_a_destination() -> None:
    """A player, not a leftover.

    Its members are the three the spec names, each written down. Nothing arrives
    by falling through, because there is nothing to fall through to.
    """
    group = DRIVER_GROUP_MAP.group("data_conditions")
    assert set(group.members) == {
        "weather_run_age_hours",
        "weather_centroid_coverage",
        "subsystem",
    }


def test_the_two_neutralised_features_are_members_and_have_no_phi_of_their_own() -> None:
    """`calendar_local_hour` and `subsystem` are in the map for totality.

    The game is group-first: the players are the eight groups and neither member
    has a `φ`. The property that they cannot move the answer is asserted on the
    background sampler — every background row shares its target's subsystem and
    local hour — which is diagnosis seam 5, in ticket 01. All this test can say
    is that they are grouped, and that the map exposes no per-member value that a
    later test could be tempted to assert zero on.
    """
    assert DRIVER_GROUP_MAP.group_of("calendar_local_hour") == "calendar_season"
    assert DRIVER_GROUP_MAP.group_of("subsystem") == "data_conditions"
    assert not hasattr(DriverGroup, "phi")
    assert not hasattr(DRIVER_GROUP_MAP, "member_phi")


# --- total and disjoint -------------------------------------------------------


def test_every_feature_in_the_ordered_list_matches_exactly_one_rule() -> None:
    for name in ALL_FEATURES:
        assert DRIVER_GROUP_MAP.group_of(name) in DRIVER_GROUP_CODES


def test_no_feature_name_matches_two_rules() -> None:
    """Disjointness, counted rather than trusted."""
    members = [member for group in DRIVER_GROUP_MAP.groups for member in group.members]
    assert len(members) == len(set(members))
    assert len(members) == len(ALL_FEATURES)


def test_the_map_and_the_ordered_feature_list_cover_each_other() -> None:
    assert_total_partition(ALL_FEATURES, DRIVER_GROUP_MAP)


def test_a_feature_added_upstream_and_left_ungrouped_fails() -> None:
    """The acceptance criterion, stated directly.

    A plausible upstream addition — another hub height — that the map does not
    name. There is no catch-all, so it does not land in `data_conditions`: it
    fails, and the message says to add a line to the YAML.
    """
    added = (*ALL_FEATURES, "weather_wind_speed_80m")
    with pytest.raises(DriverGroupMapError, match="in no driver group"):
        assert_total_partition(added, DRIVER_GROUP_MAP)


def test_group_of_refuses_an_unknown_name_rather_than_absorbing_it() -> None:
    with pytest.raises(UngroupedFeatureError) as raised:
        DRIVER_GROUP_MAP.group_of("weather_wind_speed_80m")
    assert raised.value.feature == "weather_wind_speed_80m"
    assert "catch-all" in str(raised.value)


def test_a_member_no_feature_list_carries_fails_too() -> None:
    """The other direction: a line for a feature that was renamed or dropped."""
    without_one = tuple(name for name in ALL_FEATURES if name != "weather_cloud_cover")
    with pytest.raises(DriverGroupMapError, match="in no feature list"):
        assert_total_partition(without_one, DRIVER_GROUP_MAP)


def test_the_map_file_contains_no_pattern_syntax() -> None:
    """The spec's Members column writes globs; the data file may not.

    A glob is what would let an upstream addition land silently, so the loader
    rejects one and this test reads the file to say the same thing about the
    shipped map.
    """
    for group in DRIVER_GROUP_MAP.groups:
        for member in group.members:
            assert "*" not in member
            assert member == member.strip()


def test_the_loader_rejects_a_pattern_member() -> None:
    renewable = DRIVER_GROUP_MAP.group("renewable_resource")
    with pytest.raises(DriverGroupMapError, match="patterns are not supported"):
        _map_with(
            groups=_with_members(
                "renewable_resource", (*renewable.members, "weather_wind_*")
            )
        )


def test_the_loader_rejects_a_feature_in_two_groups() -> None:
    renewable = DRIVER_GROUP_MAP.group("renewable_resource")
    with pytest.raises(DriverGroupMapError, match="must be disjoint"):
        _map_with(
            groups=_with_members(
                "renewable_resource", (*renewable.members, "programmed_load_mwh")
            )
        )


def test_the_loader_rejects_a_headline_that_is_not_a_member() -> None:
    swapped = tuple(
        dataclasses.replace(group, headline_feature="programmed_load_mwh")
        if group.code == "renewable_resource"
        else group
        for group in DRIVER_GROUP_MAP.groups
    )
    with pytest.raises(DriverGroupMapError, match="not one of its members"):
        _map_with(groups=swapped)


def test_the_loader_rejects_a_ninth_group() -> None:
    with pytest.raises(DriverGroupMapError, match="all eight groups"):
        _map_with(groups=DRIVER_GROUP_MAP.groups[:7])


def test_the_loader_rejects_a_code_outside_the_closed_set(tmp_path: Path) -> None:
    document = yaml.safe_load(DRIVER_GROUPS_PATH.read_text(encoding="utf-8"))
    document["groups"][0]["code"] = "renewable_resources"
    path = tmp_path / "driver_groups.yaml"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    with pytest.raises(DriverGroupMapError, match="not one of the eight group codes"):
        load_driver_group_map(path)


# --- the hash, and what moves it ----------------------------------------------


def test_the_version_and_the_hash_are_what_the_card_will_carry() -> None:
    """Change the map, change this. That is the whole freeze.

    If this test fails and you meant it, bump `version` in the YAML and update
    both constants — and know that every cached narration is now invalid.
    """
    assert DRIVER_GROUP_MAP.version == EXPECTED_VERSION
    assert DRIVER_GROUP_MAP.driver_group_hash == EXPECTED_HASH


def test_the_card_fields_are_the_two_the_forecaster_stamps() -> None:
    assert DRIVER_GROUP_MAP.card_fields() == {
        "driver_group_version": str(EXPECTED_VERSION),
        "driver_group_hash": EXPECTED_HASH,
    }


def test_the_hash_is_over_the_sorted_feature_to_group_pairs() -> None:
    lines = DRIVER_GROUP_MAP.pair_lines
    assert list(lines) == sorted(lines)
    assert len(lines) == len(ALL_FEATURES)
    assert "subsystem\tdata_conditions" in lines


def test_the_hash_moves_when_a_feature_changes_group() -> None:
    surplus = DRIVER_GROUP_MAP.group("net_surplus")
    demand = DRIVER_GROUP_MAP.group("demand_level")
    moved = tuple(
        dataclasses.replace(
            group,
            members=tuple(m for m in surplus.members if m != "dessem_hydro_mwh"),
        )
        if group.code == "net_surplus"
        else dataclasses.replace(group, members=(*demand.members, "dessem_hydro_mwh"))
        if group.code == "demand_level"
        else group
        for group in DRIVER_GROUP_MAP.groups
    )
    assert _map_with(groups=moved).digest != DRIVER_GROUP_MAP.digest


def test_the_hash_moves_when_a_feature_arrives() -> None:
    conditions = DRIVER_GROUP_MAP.group("data_conditions")
    arrived = _with_members(
        "data_conditions", (*conditions.members, "weather_wind_speed_80m")
    )
    assert _map_with(groups=arrived).digest != DRIVER_GROUP_MAP.digest


def test_the_hash_does_not_move_when_the_yaml_is_only_reformatted(tmp_path: Path) -> None:
    """It is a hash of the decision, not of the file's bytes.

    Re-serialising the document reorders keys, drops every comment and rewrites
    the quoting. None of that is a change to the grouping, so none of it may
    invalidate a narration cache.
    """
    document = yaml.safe_load(DRIVER_GROUPS_PATH.read_text(encoding="utf-8"))
    for group in document["groups"]:
        group["members"] = sorted(group["members"], reverse=True)
    path = tmp_path / "reformatted.yaml"
    path.write_text(yaml.safe_dump(document, sort_keys=True), encoding="utf-8")
    assert load_driver_group_map(path).digest == DRIVER_GROUP_MAP.digest


# --- the five drivers the brief names -----------------------------------------


def test_the_five_named_drivers_each_land_in_a_group_and_it_is_recorded() -> None:
    """`docs/specs/diagnosis.md`: high wind → 1, low residual load → 3,
    high NE export → 4, solar ramp → 5, Sunday → 6."""
    landed = {driver.brief_name: driver.group for driver in DRIVER_GROUP_MAP.idea_drivers}
    assert landed == {
        "high wind": "renewable_resource",
        "low residual load": "net_surplus",
        "high NE export": "export_stress",
        "solar ramp": "ramp_shape",
        "Sunday": "calendar_season",
    }


def test_each_named_drivers_witness_really_is_in_the_group_it_claims() -> None:
    for driver in DRIVER_GROUP_MAP.idea_drivers:
        assert DRIVER_GROUP_MAP.group_of(driver.witness) == driver.group


def test_the_loader_rejects_a_named_driver_whose_witness_is_elsewhere() -> None:
    with pytest.raises(DriverGroupMapError, match="not a member of that group"):
        _map_with(
            idea_drivers=(
                IdeaDriver(
                    brief_name="high wind",
                    group="demand_level",
                    witness="weather_expected_wind_mwh",
                ),
            )
        )


# --- the generated model-input artifact ---------------------------------------


def test_set_b_is_set_a_plus_the_dessem_block() -> None:
    """`feature-engineering.md`: the augmented set's extras are exactly `dessem_*`."""
    set_a = set(FEATURE_SETS["dessem_free_v1"])
    set_b = set(FEATURE_SETS["dessem_augmented_v1"])
    assert set_a < set_b
    assert all(name.startswith("dessem_") for name in set_b - set_a)
    assert not any(name.startswith("dessem_") for name in set_a)


def test_neither_feature_set_repeats_a_name() -> None:
    for names in FEATURE_SETS.values():
        assert len(names) == len(set(names))


def test_no_label_is_in_the_feature_list() -> None:
    """`y_*` are labels. A label in the feature vector is the leak this whole
    programme exists to prevent, and it would also be grouped as a driver."""
    assert not [name for name in ALL_FEATURES if name.startswith("y_")]


def test_the_artifact_says_it_was_generated_and_by_what() -> None:
    """The one property that separates it from the list it replaced.

    `ordered_features.yaml` was a hand transcription, and it failed by *agreeing*
    with `feature_set_model_inputs()` — 77 names and 99 — while both were one
    name short of the spec's class-`K` table. Nothing noticed, because a second
    list only speaks when it disagrees. This file cannot make that mistake for
    the same reason it cannot make any other one: nobody types a feature name
    into it. That is a claim about provenance, so the provenance is asserted.
    """
    document = json.loads(MODEL_INPUTS_PATH.read_text(encoding="utf-8"))
    assert document["generated_by"] == MODEL_INPUTS_GENERATOR
    assert document["source"] == MODEL_INPUTS_SOURCE
    assert "Do not edit by hand" in document["do_not_edit"]
    # The attribute count `feature_hash` moves with, carried so that a stale
    # artifact is legible as one rather than merely wrong.
    assert document["feature_row_attributes"] == 112


def test_the_loader_refuses_an_artifact_that_does_not_name_its_generator(
    tmp_path: Path,
) -> None:
    """A hand-written file is exactly what an unprovenanced one looks like."""
    path = tmp_path / "model_inputs.json"
    path.write_text(
        json.dumps(
            {
                "generated_by": "somebody's editor",
                "source": "the spec's feature table",
                "do_not_edit": "",
                "feature_row_attributes": 112,
                "sets": {"dessem_free_v1": [{"column_name": "subsystem"}]},
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(DriverGroupMapError, match="features:snapshot"):
        load_model_inputs(path)


def test_a_name_in_the_type_and_absent_from_the_group_map_still_fails() -> None:
    """The failure the second list stopped being able to produce.

    The names now come from `feature_row`'s attributes rather than from a
    transcription of the spec, so this is the real shape of the event: a ticket
    appends an attribute, the artifact is regenerated, and the map has no line
    for it. It must stop the build — which is what `ordered_features.yaml` could
    not do about `observed_constrained_off_same_hour_exceedance_7d`, because the
    transcription had the same hole the type did.
    """
    appended = (*ALL_FEATURES, "observed_constrained_off_p95_7d")
    with pytest.raises(DriverGroupMapError, match="observed_constrained_off_p95_7d"):
        assert_total_partition(appended, DRIVER_GROUP_MAP)


def test_the_exceedance_column_the_spec_always_had_is_now_in_both() -> None:
    """The column ticket 05 owed, pinned in the artifact and in the map.

    Not a restatement of totality: totality would pass if this name were absent
    from *both*, which is precisely the state that survived two tickets. This
    test is the one that fails if it disappears from either.
    """
    exceedance = "observed_constrained_off_same_hour_exceedance_7d"
    assert exceedance in FEATURE_SETS["dessem_free_v1"]
    assert exceedance in FEATURE_SETS["dessem_augmented_v1"]
    assert DRIVER_GROUP_MAP.group_of(exceedance) == "recent_history"
    # And it is not the column it is easily confused with, which is still here
    # and is a different feature: all 168 hours, not the seven observations of
    # one local hour.
    assert (
        "observed_constrained_off_hours_above_threshold_7d"
        in FEATURE_SETS["dessem_free_v1"]
    )


# --- the hash cannot be produced by an empty parse ----------------------------


def test_an_empty_document_is_not_a_map_with_an_empty_hash(tmp_path: Path) -> None:
    """The failure mode this repo keeps shipping: a guard whose input is nothing.

    A hash over zero pairs is a perfectly well-formed sha256 — it is the digest
    of the empty string — and a card carrying it would look exactly like a card
    carrying a real partition. So the emptiness has to be refused *before* the
    hash exists, and it is refused in three shapes: a file that parses to
    nothing, a document with no `groups` key, and a document whose `groups` list
    is empty. None of them may produce a `DriverGroupMap`.
    """
    for body in ("", "{}\n", "version: 2\ngroups: []\nidea_drivers: []\n"):
        path = tmp_path / "empty.yaml"
        path.write_text(body, encoding="utf-8")
        with pytest.raises(DriverGroupMapError):
            load_driver_group_map(path)

    # And the value the refusals are protecting against, spelled out, so that
    # "an empty map's digest is harmless" cannot be assumed later.
    assert DRIVER_GROUP_MAP.digest != hashlib.sha256(b"").hexdigest()
    assert DRIVER_GROUP_MAP.pair_lines


def test_the_hash_is_over_the_pairs_and_not_over_the_files_bytes() -> None:
    """Stated as an inequality, so the two can never be conflated by accident."""
    file_digest = hashlib.sha256(DRIVER_GROUPS_PATH.read_bytes()).hexdigest()
    assert DRIVER_GROUP_MAP.digest != file_digest
    assert (
        hashlib.sha256("\n".join(DRIVER_GROUP_MAP.pair_lines).encode("utf-8")).hexdigest()
        == DRIVER_GROUP_MAP.digest
    )


# --- a card whose partition is not this process's -----------------------------


def test_a_card_that_carries_the_running_partition_has_no_fault() -> None:
    assert card_partition_fault({"drivers": DRIVER_GROUP_MAP.card_fields()}) is None


def test_a_card_with_no_drivers_group_cannot_say_what_produced_it() -> None:
    """An artifact written before forecaster 31. Named, not assumed comparable."""
    fault = card_partition_fault({"identity": {}})
    assert fault is not None
    assert "drivers" in fault
    assert DRIVER_GROUP_MAP.driver_group_hash in fault


def test_a_card_whose_hash_disagrees_is_named_on_both_sides() -> None:
    """The defect the whole field exists to make visible.

    The hash is doctored rather than the map, because the direction that
    actually happens is an artifact aging past a YAML edit.
    """
    stale = dict(DRIVER_GROUP_MAP.card_fields())
    stale["driver_group_hash"] = "sha256:" + "0" * 64
    fault = card_partition_fault({"drivers": stale})
    assert fault is not None
    assert "0" * 64 in fault
    assert DRIVER_GROUP_MAP.driver_group_hash in fault


def test_a_card_whose_version_disagrees_is_a_fault_of_its_own() -> None:
    """Somebody edited one of the two by hand; the hash alone would not say so."""
    stale = dict(DRIVER_GROUP_MAP.card_fields())
    stale["driver_group_version"] = str(DRIVER_GROUP_MAP.version + 1)
    fault = card_partition_fault({"drivers": stale})
    assert fault is not None
    assert "driver_group_version" in fault
    assert "driver_group_hash" not in fault


def test_the_fault_is_detected_against_a_real_map_edit_and_not_only_a_typo() -> None:
    """The control for the three tests above: move a feature, keep the card.

    A card written under today's map, read by a process holding a map with one
    feature moved between two groups. Nothing is hand-written on either side —
    the card's hash comes from `card_fields()` and the running map's from the
    edit — so this is the fault as it would actually arrive.
    """
    card = {"drivers": DRIVER_GROUP_MAP.card_fields()}
    surplus = DRIVER_GROUP_MAP.group("net_surplus")
    demand = DRIVER_GROUP_MAP.group("demand_level")
    moved = _map_with(
        groups=tuple(
            dataclasses.replace(
                group,
                members=tuple(m for m in surplus.members if m != "dessem_hydro_mwh"),
            )
            if group.code == "net_surplus"
            else dataclasses.replace(group, members=(*demand.members, "dessem_hydro_mwh"))
            if group.code == "demand_level"
            else group
            for group in DRIVER_GROUP_MAP.groups
        )
    )
    assert card_partition_fault(card, moved) is not None
    # And the same card against the same map unedited, which is what makes the
    # assertion above about the edit rather than about the comparison.
    assert card_partition_fault(card, DRIVER_GROUP_MAP) is None
