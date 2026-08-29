"""The eight driver groups, loaded from data and hashed.

`docs/specs/diagnosis.md`, "Feature grouping — eight players, one total
partition", is the authority for the eight codes; `driver_groups.yaml` beside
this module is the map itself and `docs/specs/feature-engineering.md` is the
naming authority for every feature name in it. This module groups names and
never invents one.

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
assembly, which reads them from :meth:`DriverGroupMap.card_fields`. A retrain
never touches the map, so a change to the ranking's vocabulary is a
product-visible event.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Literal, cast

import yaml

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

#: The map, beside this module. Loaded at train time, never generated.
DRIVER_GROUPS_PATH = Path(__file__).with_name("driver_groups.yaml")

#: The ordered feature list the totality test runs against until the feature
#: builder's artifact carries one. See the file's own header.
ORDERED_FEATURES_PATH = Path(__file__).with_name("ordered_features.yaml")


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
        """The two model-card fields the forecaster's card assembly stamps.

        The third field the diagnosis spec asks the card for —
        ``headline_feature_check``, whether each declared headline was the
        largest mean-``|φ|`` member on the newest fold — needs per-member
        ``|φ|`` and belongs to the ticket that computes ``φ``. It is a card
        *warning*, never an automatic relabel: a driver whose subtitle changes
        weekly is worse than one that is second-best.
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


def load_ordered_features(
    path: Path = ORDERED_FEATURES_PATH,
) -> dict[str, tuple[str, ...]]:
    """The ordered feature list of each feature set, in the spec's order.

    A set is either a list of names or ``{extends: <set>, adds: [...]}``, which
    is how ``dessem_augmented_v1`` says "set A plus the DESSEM block" without
    transcribing seventy-seven names a second time.
    """
    document = _read_yaml(path)
    where = str(path)
    raw_sets = _as_mapping(document.get("sets"), f"{where}: sets")

    resolved: dict[str, tuple[str, ...]] = {}
    for name, raw in raw_sets.items():
        if isinstance(raw, list):
            resolved[name] = _as_str_tuple(raw, f"{where}: {name}")
            continue
        extension = _as_mapping(raw, f"{where}: {name}")
        base = _as_str(extension.get("extends"), f"{where}: {name}.extends")
        if base not in resolved:
            raise DriverGroupMapError(
                f"{where}: {name} extends {base!r}, which is not defined above it"
            )
        resolved[name] = resolved[base] + _as_str_tuple(
            extension.get("adds"), f"{where}: {name}.adds"
        )
    return resolved


#: The map, loaded once. Training, attribution and the card all read this.
DRIVER_GROUP_MAP = load_driver_group_map()
