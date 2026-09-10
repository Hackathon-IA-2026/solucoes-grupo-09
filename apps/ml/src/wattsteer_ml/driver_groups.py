"""The eight driver groups, loaded from data and hashed.

`docs/specs/diagnosis.md`, "Feature grouping — eight players, one total
partition", is the authority for the eight codes; `diagnosis/driver_groups.yaml`
is the map itself and `docs/specs/feature-engineering.md` is the naming
authority for every feature name in it. This module groups names and never
invents one.

**The map is data, and this module refuses to be a second copy of it.** Nothing
below names a feature or a group. The eight codes appear once, as a closed
:data:`DRIVER_GROUP_CODES` union, because the wire contract is a closed enum and
a typo in the YAML must be a load failure rather than a ninth group.

**There is no fallback, and that is the whole design.** :meth:`group_of` raises
:class:`UngroupedFeatureError` for a name no group lists. `data_conditions` is
the residual *player* — its ``φ`` is a Shapley value like any other, so its row
carries a real contribution and a real sign — but it is not a destination
features fall into. A feature added upstream that nobody placed fails
:func:`assert_total_partition`, and the fix is a line in the YAML.

**Frozen against retrains.** ``driver_group_version`` and
``driver_group_hash`` are stamped on the model card by the forecaster's card
assembly, which reads them from :meth:`DriverGroupMap.card_fields` — through
:meth:`~wattsteer_ml.training.headline_check.HeadlineFeatureCheck.card_fields`,
so the card's partition and the partition the check ranked under are one value
and not two reads of a global. A retrain never touches the map, so a change to
the ranking's vocabulary is a product-visible event, and
:func:`card_partition_fault` is what makes it a *detectable* one.

**Why this module is top level and not in ``diagnosis/``.** Since forecaster 31
the map has two readers: the attribution, which plays the game over it, and the
artifact's card assembly, which stamps its identity. ``training/`` cannot import
any submodule of ``wattsteer_ml.diagnosis`` — importing one runs that package's
``__init__``, which reaches ``composed_target``, which imports
``wattsteer_ml.training`` back — so a map that lived in ``diagnosis/`` could not
be stamped on the card at all. It sits beside :mod:`wattsteer_ml.model_inputs`
for the same reason that module gives for itself: one file on disk, read once,
by whoever needs it. ``wattsteer_ml.diagnosis`` re-exports every name here, so
the attribution's spelling did not change.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Literal, cast

import yaml

import wattsteer_ml.model_inputs as model_inputs

#: The eight groups, in the spec's order. A closed union: these codes are the
#: Explain screen's driver-code enum, so a ninth is a wire-contract change and
#: not a YAML edit.
GroupCode = Literal[
    "renewable_resource",
    "demand_level",
    "net_surplus",
    "export_stress",
    "ramp_shape",
    "calendar_season",
    "recent_history",
    "data_conditions",
]

DRIVER_GROUP_CODES: tuple[GroupCode, ...] = (
    "renewable_resource",
    "demand_level",
    "net_surplus",
    "export_stress",
    "ramp_shape",
    "calendar_season",
    "recent_history",
    "data_conditions",
)

#: Unit codes for a headline feature's ``observed`` / ``typical`` pair.
#: ``api-surface.md`` writes the set as ``"mwh" | "mw" | "ratio" | "pct" | …``
#: and leaves it open; ``boolean`` is the reading behind the ``term`` variant of
#: ``DriverReading``, which the same document says `calendar_season` needs.
UnitCode = Literal["mwh", "mw", "ratio", "pct", "hours", "boolean"]

UNIT_CODES: tuple[UnitCode, ...] = ("mwh", "mw", "ratio", "pct", "hours", "boolean")

#: The map itself. Loaded at train time, never generated.
#:
#: **The loader moved and the data did not.** `docs/specs/diagnosis.md` names
#: this path — "`apps/ml/src/wattsteer_ml/diagnosis/driver_groups.yaml`, loaded
#: at train time, hashed" — and a claim in a spec is a claim this repo checks,
#: so forecaster 31 moved this module out of the `diagnosis` package and left
#: the YAML where the spec says it is. The grouping is still the diagnosis
#: lane's product decision; what moved is the code that reads it.
DRIVER_GROUPS_PATH = Path(__file__).parent / "diagnosis" / "driver_groups.yaml"

#: The generated model-input artifact, beside this module.
#:
#: **Not a second feature list.** It is `feature_set_model_inputs(set)`
#: serialised by `apps/api/src/features/model-inputs-artifact.ts`, and that
#: function derives its names from `pg_attribute` on the `feature_row` composite
#: type — the same catalogue `feature_hash` is taken over — and raises `22023`
#: rather than answering when the catalogue and the type disagree. Nobody types a
#: feature name into it.
#:
#: It replaces `ordered_features.yaml`, which was transcribed from the spec's
#: feature table by hand while no dictionary existed. That file did not fail by
#: drifting: it matched `feature_set_model_inputs` exactly, 77 names and 99,
#: while both were one name short of the spec's class-`K` table — so the
#: transcription had quietly become a copy of the implementation it was there to
#: check. A second list fails by agreeing with the wrong thing, and agreement is
#: silent.
#:
#: **Read by :mod:`wattsteer_ml.model_inputs`, not here.** That module keeps the
#: four columns this one throws away, one of which — ``available_at_gate_early``
#: — is what tells the two serving lanes apart
#: (:mod:`wattsteer_ml.admissibility`). Two readers of one file would be two
#: provenance checks that could disagree about whether the file is trustworthy,
#: so the read happens once and this module narrows the answer.
MODEL_INPUTS_PATH = model_inputs.MODEL_INPUTS_PATH
MODEL_INPUTS_GENERATOR = model_inputs.MODEL_INPUTS_GENERATOR
MODEL_INPUTS_SOURCE = model_inputs.MODEL_INPUTS_SOURCE


class DriverGroupMapError(ValueError):
    """The map on disk is not a map. Raised at load, never at serve time."""


class UngroupedFeatureError(DriverGroupMapError):
    """A feature no group lists.

    Never "it went to `data_conditions`". A feature the map does not name is a
    decision nobody has taken, and the caller is told exactly that.
    """

    def __init__(self, feature: str) -> None:
        super().__init__(
            f"{feature!r} is in the feature list and in no driver group. "
            "Add it to a group's `members` in driver_groups.yaml and bump "
            "`version` — there is no catch-all to fall into."
        )
        self.feature = feature


@dataclass(frozen=True)
class DriverGroup:
    """One of the eight players.

    ``headline_feature`` is the one feature whose value the screen may show
    beside the bar. A group has no single value, so naming the feature the pair
    came from is what stops a value pair being read as the whole group's
    reading.
    """

    code: GroupCode
    #: The translation key. Codes travel on the wire; the client translates.
    label_code: str
    #: One line of English, for the reviewer reading the YAML. Not user copy —
    #: the screen renders ``label_code``.
    mechanism: str
    headline_feature: str
    unit: UnitCode
    members: tuple[str, ...]


@dataclass(frozen=True)
class IdeaDriver:
    """One of the five drivers the product brief names by hand, and its group.

    Recorded so that "all five land somewhere" is a test rather than a claim.
    """

    brief_name: str
    group: GroupCode
    #: The member that carries the mechanism the brief describes.
    witness: str


@dataclass(frozen=True)
class DriverGroupMap:
    """The eight groups, their members, and the hash over the pairs.

    Constructing one validates it: disjointness, the closed code set, a headline
    that is a member of its own group, and the absence of any pattern syntax.
    An invalid map cannot exist as a value, so no caller has to re-check.
    """

    version: int
    groups: tuple[DriverGroup, ...]
    idea_drivers: tuple[IdeaDriver, ...]
    #: Derived, not supplied: ``feature → group code`` for every named member.
    feature_to_group: MappingProxyType[str, GroupCode] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        codes = tuple(group.code for group in self.groups)
        if sorted(codes) != sorted(DRIVER_GROUP_CODES):
            raise DriverGroupMapError(
                f"the map must declare all eight groups exactly once, got {codes!r}"
            )

        index: dict[str, GroupCode] = {}
        for group in self.groups:
            if not group.members:
                raise DriverGroupMapError(f"group {group.code!r} lists no members")
            for member in group.members:
                # No globs, no `*`, no "everything else". The only way into a
                # group is a literal name somebody typed.
                if not member or member != member.strip() or "*" in member:
                    raise DriverGroupMapError(
                        f"group {group.code!r} member {member!r} is not a literal "
                        "feature name; patterns are not supported, by design"
                    )
                if member in index:
                    raise DriverGroupMapError(
                        f"{member!r} is in both {index[member]!r} and "
                        f"{group.code!r}; the groups must be disjoint"
                    )
                index[member] = group.code
            if group.headline_feature not in group.members:
                raise DriverGroupMapError(
                    f"group {group.code!r} declares headline feature "
                    f"{group.headline_feature!r}, which is not one of its members"
                )

        for driver in self.idea_drivers:
            if index.get(driver.witness) != driver.group:
                raise DriverGroupMapError(
                    f"brief driver {driver.brief_name!r} claims group "
                    f"{driver.group!r} via {driver.witness!r}, which is not a "
                    "member of that group"
                )

        object.__setattr__(self, "feature_to_group", MappingProxyType(index))

    def group_of(self, feature: str) -> GroupCode:
        """The group a feature belongs to, or a failure.

        The failure is the point: see :class:`UngroupedFeatureError`.
        """
        try:
            return self.feature_to_group[feature]
        except KeyError:
            raise UngroupedFeatureError(feature) from None

    def group(self, code: GroupCode) -> DriverGroup:
        """The group with this code. The code set is closed, so this cannot miss."""
        for group in self.groups:
            if group.code == code:
                return group
        raise DriverGroupMapError(f"unknown group code {code!r}")

    @property
    def pair_lines(self) -> tuple[str, ...]:
        """The sorted ``feature → group`` pairs, one per line, as hashed.

        Serialised here rather than inline in :meth:`digest` so the test can
        assert on the thing that is hashed instead of on a hex string.
        """
        return tuple(
            f"{feature}\t{code}"
            for feature, code in sorted(self.feature_to_group.items())
        )

    @property
    def digest(self) -> str:
        """sha256 over the sorted pairs, hex.

        ``docs/specs/diagnosis.md`` defines the hash over the *pairs*, so it is
        blind to YAML formatting, key order and comments, and it moves for
        exactly the change that re-ranks the screen: a feature changing group,
        arriving, or leaving.
        """
        payload = "\n".join(self.pair_lines).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    @property
    def driver_group_hash(self) -> str:
        """The card and wire spelling of :attr:`digest`."""
        return f"sha256:{self.digest}"

    def card_fields(self) -> dict[str, str]:
        """The two identity fields the forecaster's card assembly stamps.

        The third field the diagnosis spec asks the card for —
        ``headline_feature_check`` — needs the fitted model and the newest
        fold's rows, so it is assembled by
        :mod:`wattsteer_ml.training.headline_check`, which calls this method for
        the two values here rather than re-deriving them: the card's partition
        and the partition the check ranked under are then one value by
        construction. It is a card *warning*, never an automatic relabel: a
        driver whose subtitle changes weekly is worse than one that is
        second-best.
        """
        return {
            "driver_group_version": str(self.version),
            "driver_group_hash": self.driver_group_hash,
        }


def assert_total_partition(
    feature_names: tuple[str, ...], group_map: DriverGroupMap
) -> None:
    """Every feature is in exactly one group, and every group member is a feature.

    Both directions matter and they fail differently:

    - a name in ``feature_names`` that no group lists is a feature somebody
      added upstream and nobody placed — the map needs a line;
    - a member no feature list carries is a line for a feature that was renamed
      or dropped, which would otherwise sit in the map forever, changing the
      hash and nothing else.

    Disjointness is not re-checked here: :class:`DriverGroupMap` cannot be
    constructed with a feature in two groups.
    """
    index = group_map.feature_to_group
    ungrouped = sorted(name for name in feature_names if name not in index)
    if ungrouped:
        raise DriverGroupMapError(
            "these features are in the feature list and in no driver group: "
            f"{', '.join(ungrouped)}. Add each to a group's `members` in "
            "driver_groups.yaml and bump `version`; there is no catch-all."
        )

    dangling = sorted(set(index) - set(feature_names))
    if dangling:
        raise DriverGroupMapError(
            "these driver-group members are in no feature list: "
            f"{', '.join(dangling)}. Remove each from driver_groups.yaml and "
            "bump `version`."
        )


def _read_yaml(path: Path) -> dict[str, object]:
    loaded: object = yaml.safe_load(path.read_text(encoding="utf-8"))
    return _as_mapping(loaded, str(path))


def _as_mapping(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise DriverGroupMapError(
            f"{where}: expected a mapping, got {type(value).__name__}"
        )
    for key in value:
        if not isinstance(key, str):
            raise DriverGroupMapError(f"{where}: expected string keys, got {key!r}")
    return cast(dict[str, object], value)


def _as_str(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise DriverGroupMapError(f"{where}: expected a string, got {value!r}")
    return value


def _as_int(value: object, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise DriverGroupMapError(f"{where}: expected an integer, got {value!r}")
    return value


def _as_str_tuple(value: object, where: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise DriverGroupMapError(f"{where}: expected a list, got {type(value).__name__}")
    return tuple(_as_str(item, where) for item in value)


def _as_group_code(value: object, where: str) -> GroupCode:
    code = _as_str(value, where)
    if code not in DRIVER_GROUP_CODES:
        raise DriverGroupMapError(
            f"{where}: {code!r} is not one of the eight group codes "
            f"{DRIVER_GROUP_CODES!r}"
        )
    # mypy narrows off the closed tuple above; no cast is needed and none is
    # allowed — a cast here would be the one place a ninth code could sneak in.
    return code


def _as_unit_code(value: object, where: str) -> UnitCode:
    unit = _as_str(value, where)
    if unit not in UNIT_CODES:
        raise DriverGroupMapError(f"{where}: {unit!r} is not a unit code {UNIT_CODES!r}")
    return unit


def _as_mapping_tuple(value: object, where: str) -> tuple[dict[str, object], ...]:
    if not isinstance(value, list):
        raise DriverGroupMapError(f"{where}: expected a list, got {type(value).__name__}")
    return tuple(_as_mapping(item, where) for item in value)


def _as_key(value: object, where: str) -> str:
    """A required key's value, with the key named in the failure."""
    if value is None:
        raise DriverGroupMapError(f"{where}: missing")
    return _as_str(value, where)


def load_driver_group_map(path: Path = DRIVER_GROUPS_PATH) -> DriverGroupMap:
    """Read and validate the map. Every failure is a load failure."""
    document = _read_yaml(path)
    where = str(path)

    groups: list[DriverGroup] = []
    for raw in _as_mapping_tuple(document.get("groups"), f"{where}: groups"):
        code = _as_group_code(raw.get("code"), f"{where}: groups[].code")
        groups.append(
            DriverGroup(
                code=code,
                label_code=_as_key(raw.get("label_code"), f"{where}: {code}.label_code"),
                mechanism=_as_key(raw.get("mechanism"), f"{where}: {code}.mechanism"),
                headline_feature=_as_key(
                    raw.get("headline_feature"), f"{where}: {code}.headline_feature"
                ),
                unit=_as_unit_code(raw.get("unit"), f"{where}: {code}.unit"),
                members=_as_str_tuple(raw.get("members"), f"{where}: {code}.members"),
            )
        )

    drivers: list[IdeaDriver] = []
    for raw in _as_mapping_tuple(document.get("idea_drivers"), f"{where}: idea_drivers"):
        drivers.append(
            IdeaDriver(
                brief_name=_as_key(
                    raw.get("brief_name"), f"{where}: idea_drivers[].brief_name"
                ),
                group=_as_group_code(raw.get("group"), f"{where}: idea_drivers[].group"),
                witness=_as_key(raw.get("witness"), f"{where}: idea_drivers[].witness"),
            )
        )

    return DriverGroupMap(
        version=_as_int(document.get("version"), f"{where}: version"),
        groups=tuple(groups),
        idea_drivers=tuple(drivers),
    )


def load_model_inputs(
    path: Path = MODEL_INPUTS_PATH,
) -> dict[str, tuple[str, ...]]:
    """The ordered model inputs of each feature set, from the generated artifact.

    The names :func:`assert_total_partition` is run against. They arrive in the
    composite type's own attribute order, which is the order ``feature_hash`` is
    taken in; the totality check is set-shaped and does not depend on it, but
    reordering here would make the artifact and the hash describe two different
    things, so nothing reorders it.

    **The provenance is checked, not assumed.** An artifact that does not name
    the generator and the SQL function it came from is refused, because the one
    property that makes this file different from the hand-transcribed list it
    replaces is that no human typed a feature name into it — and a file claiming
    nothing about itself is exactly what a hand-edited one would look like. The
    refusal is a load failure, like every other failure in this module.

    **The read itself is :func:`wattsteer_ml.model_inputs.load_model_inputs`**,
    which keeps every column the artifact carries; this narrows its answer to
    the names, which is all the partition check needs. Its failures are
    re-raised as :class:`DriverGroupMapError` so that a caller loading the map
    catches one exception type for one file on disk.
    """
    try:
        return model_inputs.load_model_inputs(path).names_by_set()
    except model_inputs.ModelInputsError as error:
        raise DriverGroupMapError(str(error)) from error


#: The map, loaded once. Training, attribution and the card all read this.
DRIVER_GROUP_MAP = load_driver_group_map()


#: The card group the three fields live in. Named here because both the writer
#: (:meth:`~wattsteer_ml.training.headline_check.HeadlineFeatureCheck.card_fields`,
#: through the card's assembly) and the reader (:func:`card_partition_fault`)
#: have to agree about it, and a string typed twice is a group that can be
#: renamed on one side only.
CARD_DRIVERS_GROUP = "drivers"


def card_partition_fault(
    card: Mapping[str, object], group_map: DriverGroupMap = DRIVER_GROUP_MAP
) -> str | None:
    """Why this card's driver-group partition is not the running code's, or ``None``.

    **The point of stamping the partition at all.** An attribution computed
    under one partition is not comparable with one computed under another — the
    eight players are different players — so an artifact whose card names a
    different map from the one this process holds cannot have an attribution
    published against it without the rows claiming a partition the artifact
    never saw. `docs/specs/diagnosis.md` makes the map "frozen against
    retrains"; this function is what makes a thaw visible.

    Three faults, each named on both sides:

    - the card carries no ``drivers`` group at all — an artifact written before
      forecaster 31, which cannot say what it was trained beside;
    - the hashes differ — a member moved group, arrived or left;
    - the versions differ while the hashes agree, or the reverse, which means
      somebody edited one of the two by hand.

    Returned rather than raised so the caller decides the severity. It is not a
    load failure: a YAML edit would otherwise brick every artifact on the volume
    and stop the forecast as well as the explanation, and the spec's own
    consequence for a map edit is an invalidated narration cache and not a
    withdrawn model. :func:`~wattsteer_ml.diagnosis.publish.\
build_diagnosis_publication` is where it *is* fatal, because that is the one
    place the difference would be written down as fact.
    """
    group = card.get(CARD_DRIVERS_GROUP)
    if not isinstance(group, Mapping):
        return (
            f"the card carries no {CARD_DRIVERS_GROUP!r} group, so it does not "
            "say which driver-group partition produced it; the running code "
            f"holds version {group_map.version} / {group_map.driver_group_hash}"
        )
    expected = group_map.card_fields()
    differences = sorted(
        f"{name}: the card says {group.get(name)!r} and the running code {value!r}"
        for name, value in expected.items()
        if group.get(name) != value
    )
    if not differences:
        return None
    return "; ".join(differences)
