"""Seam 8 — the rules cannot write.

`docs/specs/diagnosis.md`: *"Property test: for every rule, for randomly
generated payloads, the post-rule payload's ``p``, band, ``E[Y]``, every ``φ``,
every share and every rank-underlying value are byte-identical to the pre-rule
payload. Only ``rule_flags``, ``demoted`` and the narration-source decision may
differ."*

That property is asserted here three ways, because one of them is a statement
about *this* code and the other two are statements about any code that replaces
it:

1. **The payload comparison**, byte for byte, over randomly generated days, for
   every shipping rule and for a fixture ``demote`` rule.
2. **An AST walk over the rules module**, in the spirit of the member-level-φ
   prohibition one layer down: the module never names an attribution type, never
   assigns to an attribute, and holds no numeric literal that is not a bound of
   the quantity it compares. A later "faster" version that reached for a
   ``DayAttribution`` here would fail before it could reach a screen.
3. **A walk over the outcome's own type**: there is no field on
   :class:`~wattsteer_ml.diagnosis.rules.RuleOutcome` a number the screen shows
   could travel in, so the valve does not depend on the engine being careful.
"""

from __future__ import annotations

import ast
import json
from collections.abc import Mapping, Sequence
from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest

from attribution_fixtures import RowFunction, feature_names_of, synthetic_map
from wattsteer_ml.constants import Subsystem
from wattsteer_ml.diagnosis import rules as rules_module
from wattsteer_ml.diagnosis.day_attribution import DayAttribution, attribute_day
from wattsteer_ml.diagnosis.driver_groups import DRIVER_GROUP_CODES, GroupCode
from wattsteer_ml.diagnosis.publication import (
    RULE_ACTION_ORDER,
    AttributionPublicationError,
    AttributionRow,
    FiredRule,
    headline_readings,
)
from wattsteer_ml.diagnosis.rule_context import (
    FIELD_PROVENANCE,
    UNMODELLED_REASON,
    WEATHER_CENTROID_COVERAGE_FEATURE,
    WEATHER_RUN_AGE_FEATURE,
    ReasonMix,
    RuleContext,
    RuleContextError,
    build_rule_context,
    context_field_names,
    reason_mixes_from_payload,
)
from wattsteer_ml.diagnosis.rules import (
    REOPENING_TRIGGER,
    SHIPPING_RULE_CODES,
    SHIPPING_RULES,
    Rule,
    RuleError,
    RuleOutcome,
    apply_rules,
)
from wattsteer_ml.evaluation import HOURS_PER_DAY, RowKey
from wattsteer_ml.training.background import (
    BASE_FIT_SOURCE,
    BackgroundCell,
    CellKey,
    MatchedBackground,
)

#: Seven one-member groups and a ``data_conditions`` that carries the two
#: pipeline columns ``stale_inputs`` reads — the real map puts them there too.
FIXTURE_MAP = synthetic_map(
    (
        ("f0",),
        ("f1",),
        ("f2",),
        ("f3",),
        ("f4",),
        ("f5",),
        ("f6",),
        ("f7", WEATHER_RUN_AGE_FEATURE, WEATHER_CENTROID_COVERAGE_FEATURE),
    )
)
NAMES = feature_names_of(FIXTURE_MAP)
WIDTH = len(NAMES)
RUN_AGE_COLUMN = NAMES.index(WEATHER_RUN_AGE_FEATURE)
COVERAGE_COLUMN = NAMES.index(WEATHER_CENTROID_COVERAGE_FEATURE)

SUBSYSTEM: Subsystem = "NE"
TARGET_DATE = date(2026, 3, 4)

#: The artifact's published class edges. ``low = [0, e1)``, so ``e1`` is the
#: lowest **edge**; ``low[0]`` is the domain's bound and not a measured one.
RISK_BINS: Mapping[str, tuple[float, float]] = {
    "low": (0.0, 0.15),
    "elevated": (0.15, 0.5),
    "high": (0.5, 1.0),
}

RULES_SOURCE = Path(rules_module.__file__).read_text(encoding="utf-8")
RULES_TREE = ast.parse(RULES_SOURCE)


# --- Fixtures ------------------------------------------------------------------


def _background() -> MatchedBackground:
    matrix = np.zeros((8, WIDTH), dtype=np.float64)
    matrix[:, 0] = np.linspace(-1.0, 1.0, 8)
    matrix[:, 1] = np.linspace(1.0, -1.0, 8)
    matrix[:, 2] = np.linspace(-0.5, 0.5, 8)
    matrix[:, COVERAGE_COLUMN] = 1.0
    cells = {}
    for local_hour in range(HOURS_PER_DAY):
        keys = tuple(
            RowKey(
                target_date=date(2025, 1, 1) + timedelta(days=offset),
                local_hour=local_hour,
                subsystem=SUBSYSTEM,
            )
            for offset in range(matrix.shape[0])
        )
        cells[CellKey(subsystem=SUBSYSTEM, local_hour=local_hour)] = BackgroundCell(
            subsystem=SUBSYSTEM,
            local_hour=local_hour,
            keys=keys,
            matrix=matrix.copy(),
        )
    return MatchedBackground(
        feature_names=NAMES,
        rows_per_cell=matrix.shape[0],
        seed=7,
        source=BASE_FIT_SOURCE,
        cells=cells,
    )


def _keys() -> tuple[RowKey, ...]:
    return tuple(
        RowKey(target_date=TARGET_DATE, local_hour=hour, subsystem=SUBSYSTEM)
        for hour in range(HOURS_PER_DAY)
    )


def _targets(seed: int = 0) -> npt.NDArray[np.float64]:
    """One day of feature rows. A healthy pipeline unless a test says otherwise."""
    generator = np.random.default_rng(seed)
    rows = generator.normal(size=(HOURS_PER_DAY, WIDTH))
    rows[:, RUN_AGE_COLUMN] = 0.0
    rows[:, COVERAGE_COLUMN] = 1.0
    return rows


def _game(seed: int = 0) -> RowFunction:
    weights = np.random.default_rng(seed + 1000).normal(size=WIDTH)
    return RowFunction(
        lambda row: float(np.dot(row, weights)) + 3.0 * float(row[0]) * float(row[1])
    )


def _day(seed: int = 0, targets: npt.NDArray[np.float64] | None = None) -> DayAttribution:
    return attribute_day(
        keys=_keys(),
        target_rows=_targets(seed) if targets is None else targets,
        background=_background(),
        expectation=_game(seed),
        group_map=FIXTURE_MAP,
        stderr_resamples=16,
        stderr_seed=4,
    )


def _row(
    day: DayAttribution,
    targets: npt.NDArray[np.float64],
    outcome: RuleOutcome | None = None,
) -> dict[str, Any]:
    """The published row for this day, with the rules' verdict on it.

    ``outcome=None`` means "run them and take what comes", **not** "skip them":
    an `AttributionRow` with no roll call is refused, which is the whole of
    api-surface 10's third box. `outcome.for_row()` is the one call that carries
    the flags, the demotions and the roll call together, so the before/after
    payload comparisons below cannot accidentally compare a row the rules never
    saw against one they did.
    """
    verdict = apply_rules(_context(day, targets)) if outcome is None else outcome
    row = AttributionRow(
        attribution=day,
        readings=headline_readings(
            day,
            keys=_keys(),
            target_rows=targets,
            background=_background(),
            group_map=FIXTURE_MAP,
        ),
        **verdict.for_row(),
    )
    return row.as_row()


def _context(
    day: DayAttribution, targets: npt.NDArray[np.float64], **overrides: Any
) -> RuleContext:
    context = build_rule_context(
        day,
        target_rows=targets,
        feature_names=NAMES,
        risk_bins=RISK_BINS,
        day_occurrence_probability=overrides.pop("day_occurrence_probability", 0.8),
        hours_p50_nonzero=overrides.pop("hours_p50_nonzero", 9),
        recent_reasons=overrides.pop("recent_reasons", None),
        group_map=FIXTURE_MAP,
    )
    return context if not overrides else replace(context, **overrides)


def _demote(*codes: GroupCode) -> Rule:
    """A fixture ``demote`` rule. No shipping rule demotes; the action does."""
    return Rule(
        code="fixture_demote",
        action="demote",
        fires=lambda context: {"because": "fixture"},
        demotes=lambda context: frozenset(codes),
    )


def _always(code: str, action: str) -> Rule:
    return Rule(
        code=code,
        action=action,  # type: ignore[arg-type]
        fires=lambda context: {"code": code},
    )


#: The permitted differences, and the whole of them.
#:
#: ``rules_evaluated`` is on the list for the reason ``rule_flags`` is: it is
#: part of the rules' own **record**, and not a figure about the model. The test
#: below deliberately evaluates one rule at a time against a payload built by
#: evaluating all four, so the roll call differs by construction — and a roll
#: call is not a number a rule could have changed. Nothing else may move.
PERMITTED_TOP_LEVEL = frozenset(
    {"rule_flags", "governing_rule_action", "rules_evaluated"}
)
PERMITTED_PER_DRIVER = frozenset({"demoted"})


def _frozen(payload: Mapping[str, Any]) -> str:
    """The payload with every permitted difference removed, canonicalised."""
    stripped = {
        key: value for key, value in payload.items() if key not in PERMITTED_TOP_LEVEL
    }
    for block in ("groups", "peak_hour_groups"):
        stripped[block] = [
            {key: value for key, value in one.items() if key not in PERMITTED_PER_DRIVER}
            for one in stripped[block]
        ]
    return json.dumps(stripped, sort_keys=True)


# --- The valve, asserted on the payload ----------------------------------------


@pytest.mark.parametrize("seed", range(12))
def test_no_rule_changes_a_number_or_drops_a_driver(seed: int) -> None:
    """Seam 8, for randomly generated payloads and every rule that can fire.

    The comparison is the *whole* payload minus the three things a rule is
    allowed to touch, rendered through ``json.dumps`` — so a ``Φ`` scaled by
    ``1 + 1e-16``, a re-ranked bar or a dropped group is a failure, not a
    tolerance question.
    """
    targets = _targets(seed)
    day = _day(seed, targets)
    before = _row(day, targets)

    every_rule = (
        *SHIPPING_RULES,
        _demote("net_surplus", "export_stress"),
    )
    for rule in every_rule:
        # A context tailored so this rule fires, whatever the random day did.
        context = _context(
            day,
            targets,
            day_occurrence_probability=0.01,
            hours_p50_nonzero=0,
            ranking_is_noise=True,
            weather_run_age_hours=12.0,
            recent_reasons=ReasonMix(
                settled_date=TARGET_DATE - timedelta(days=1),
                shares={UNMODELLED_REASON: 0.62, "ENE": 0.38},
            ),
        )
        outcome = apply_rules(context, [rule])
        assert outcome.flags, f"{rule.code} did not fire on a context built to fire it"
        after = _row(day, targets, outcome)

        assert _frozen(after) == _frozen(before)
        assert len(after["groups"]) == len(DRIVER_GROUP_CODES)
        assert len(after["peak_hour_groups"]) == len(DRIVER_GROUP_CODES)


def test_the_payload_comparison_would_notice_a_scaled_or_missing_driver() -> None:
    """The comparison above is not vacuous — it has something to fail against.

    A future "faster" rules engine that scaled a ``Φ`` down instead of leaving
    it alone, or that dropped a bar a ``withhold`` made pointless, has to get
    past this: the canonicalisation keeps full float precision and the driver
    lists keep their length.
    """
    targets = _targets(26)
    day = _day(26, targets)
    before = _row(day, targets)

    scaled = json.loads(json.dumps(before))
    scaled["groups"][0]["phi_mwh"] *= 1.0 + 1e-15
    assert _frozen(scaled) != _frozen(before)

    dropped = json.loads(json.dumps(before))
    dropped["groups"].pop()
    assert _frozen(dropped) != _frozen(before)

    reranked = json.loads(json.dumps(before))
    reranked["groups"][0]["rank"] = 9
    assert _frozen(reranked) != _frozen(before)


def test_the_attribution_the_rules_ran_against_is_the_one_published() -> None:
    """No copy, no rescale, no re-run — the same frozen object goes on the wire.

    The ticket-05 move: the value is frozen and the published row holds *it*, so
    a later version that re-derived the numbers "equivalently" rather than
    copying them has a test to answer to.
    """
    targets = _targets(27)
    day = _day(27, targets)
    outcome = apply_rules(_context(day, targets, ranking_is_noise=True))
    row = AttributionRow(
        attribution=day,
        readings=headline_readings(
            day,
            keys=_keys(),
            target_rows=targets,
            background=_background(),
            group_map=FIXTURE_MAP,
        ),
        **outcome.for_row(),
    )

    assert row.attribution is day
    with pytest.raises(FrozenInstanceError):
        day.contributions[0].phi_mwh = 0.0  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        day.day_expected_mwh = 0.0  # type: ignore[misc]


def test_only_the_flags_the_demotions_and_the_source_may_differ() -> None:
    """The other half of seam 8: the permitted differences are *reachable*.

    A test that only asserts equality would pass against a rules engine that did
    nothing at all, so this one asserts that each permitted field does move.
    """
    targets = _targets(3)
    day = _day(3, targets)
    demoted_code = day.contributions[0].code

    outcome = apply_rules(
        _context(day, targets, ranking_is_noise=True),
        [*SHIPPING_RULES, _demote(demoted_code)],
    )
    before = _row(day, targets)
    after = _row(day, targets, outcome)

    assert after["rule_flags"] != before["rule_flags"]
    assert after["governing_rule_action"] == "withhold"
    assert before["governing_rule_action"] is None
    assert outcome.narration_source == "template"
    assert [one["demoted"] for one in after["groups"]] != [
        one["demoted"] for one in before["groups"]
    ]
    # And the bar that was demoted kept everything that makes it a bar.
    demoted_row = next(one for one in after["groups"] if one["code"] == demoted_code)
    original = next(one for one in before["groups"] if one["code"] == demoted_code)
    assert demoted_row["demoted"] is True
    assert original["demoted"] is False
    for field in ("phi_mwh", "share", "direction", "rank", "hour_disagreement"):
        assert demoted_row[field] == original[field]


def test_a_demote_rule_moves_only_the_groups_it_names() -> None:
    targets = _targets(5)
    day = _day(5, targets)
    outcome = apply_rules(_context(day, targets), [_demote("ramp_shape")])

    assert outcome.demoted == frozenset({"ramp_shape"})
    assert outcome.governing_action == "demote"
    assert outcome.narration_source == "model"
    payload = _row(day, targets, outcome)
    assert [one["code"] for one in payload["groups"] if one["demoted"]] == ["ramp_shape"]


def test_a_rule_cannot_demote_a_group_that_does_not_exist() -> None:
    targets = _targets(6)
    day = _day(6, targets)
    invented = Rule(
        code="invents_a_bar",
        action="demote",
        fires=lambda context: {},
        demotes=lambda context: frozenset({"tariff_regime"}),  # type: ignore[arg-type]
    )
    with pytest.raises(RuleError, match="not a driver group"):
        apply_rules(_context(day, targets), [invented])
    # And the row refuses one too, so a demote set assembled by hand cannot put
    # a ninth bar's name on a publication either.
    with pytest.raises(AttributionPublicationError, match="never invent one"):
        AttributionRow(
            attribution=day,
            readings=headline_readings(
                day,
                keys=_keys(),
                target_rows=targets,
                background=_background(),
                group_map=FIXTURE_MAP,
            ),
            rule_flags=(),
            rules_evaluated=SHIPPING_RULE_CODES,
            demoted=frozenset({"tariff_regime"}),  # type: ignore[arg-type]
        )


# --- The valve, asserted structurally ------------------------------------------

#: Names that would mean this module had reached the published numbers. The
#: attribution types, the row that copies them, and the fields they carry.
FORBIDDEN_NAMES = frozenset(
    {
        "DayAttribution",
        "DayGroupContribution",
        "HourAttribution",
        "GroupContribution",
        "AttributionRow",
        "AttributionPublication",
        "DriverReading",
        "MatchedBackground",
        "attribute_day",
        "attribute_hour",
        "headline_readings",
        "phi_mwh",
        "hourly_phi_mwh",
        "contributions",
        "to_payload",
        "as_row",
    }
)

FORBIDDEN_MODULES = frozenset(
    {
        "wattsteer_ml.diagnosis.attribution",
        "wattsteer_ml.diagnosis.day_attribution",
        "wattsteer_ml.training.background",
        "wattsteer_ml.diagnosis.shapley",
    }
)


def test_the_rules_module_never_names_an_attribution() -> None:
    """The structural half: a rule cannot touch what it cannot name.

    The same move `docs/specs/diagnosis.md` seam 3 makes against member-level
    ``φ`` — an AST walk over production source, scoped to this module. It is what
    stops a later refactor from passing a ``DayAttribution`` into a predicate
    "just to read one number off it".
    """
    seen: set[str] = set()
    for node in ast.walk(RULES_TREE):
        if isinstance(node, ast.Name):
            seen.add(node.id)
        elif isinstance(node, ast.Attribute):
            seen.add(node.attr)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            assert node.module not in FORBIDDEN_MODULES, (
                f"the rules module imports {node.module}; a rule that can reach "
                "an attribution can change one"
            )
            for alias in node.names:
                seen.add(alias.name)
    assert not seen & FORBIDDEN_NAMES


def test_the_rules_module_writes_to_nothing() -> None:
    """No attribute assignment, no `setattr`, no frozen-dataclass escape hatch."""
    escapes = {"setattr", "__setattr__", "replace", "copy", "deepcopy", "put", "itemset"}
    for node in ast.walk(RULES_TREE):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                assert not isinstance(target, ast.Attribute | ast.Subscript), (
                    "the rules module assigns to an attribute or an element; the "
                    "one thing a rule may not do is write"
                )
        assert not isinstance(node, ast.AugAssign) or not isinstance(
            node.target, ast.Attribute | ast.Subscript
        )
        if isinstance(node, ast.Call):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else None
            if isinstance(node.func, ast.Name):
                name = node.func.id
            assert name not in escapes, f"the rules module calls {name}"


def test_the_rules_module_holds_no_invented_constant() -> None:
    """Every number in the file is a bound of the quantity it compares.

    ``0`` is "not stale at all" and ``1`` is "the whole centroid set". The one
    threshold in the spec's table — the ``2 ×`` on the standard error — is not
    here: it is decided beside the two numbers it compares and arrives as a
    fact. A rule admitted later with a measured threshold puts it where the
    measurement is, not here.
    """
    permitted = {0, 1}
    for node in ast.walk(RULES_TREE):
        if isinstance(node, ast.Constant) and isinstance(node.value, int | float):
            if isinstance(node.value, bool):
                continue
            assert node.value in permitted, (
                f"{node.value!r} appears in the rules module; a threshold nobody "
                "measured is exactly what this ticket defers"
            )


def test_the_outcome_carries_no_number_the_screen_shows() -> None:
    """There is nowhere on a `RuleOutcome` for a `Φ`, a share or a rank to sit.

    Walked at runtime rather than read off the annotations, because the claim is
    about what a fired outcome actually holds: codes, actions, and the recorded
    inputs of whatever fired — which reach ``rule_flags`` and nothing else.
    """
    targets = _targets(8)
    day = _day(8, targets)
    outcome = apply_rules(
        _context(day, targets, ranking_is_noise=True, weather_run_age_hours=6.0),
        [*SHIPPING_RULES, _demote("demand_level")],
    )
    assert outcome.flags

    def numbers(value: Any) -> list[float]:
        if isinstance(value, bool):
            return []
        if isinstance(value, int | float):
            return [float(value)]
        if isinstance(value, str):
            return []
        if is_dataclass(value) and not isinstance(value, type):
            return [
                one
                for item in fields(value)
                for one in numbers(getattr(value, item.name))
            ]
        if isinstance(value, Mapping):
            return [one for item in value.values() for one in numbers(item)]
        if isinstance(value, Sequence | frozenset | set):
            return [one for item in value for one in numbers(item)]
        return []

    assert numbers(outcome.demoted) == []
    assert numbers(outcome.withheld_by) == []
    assert numbers(outcome.governing_action) == []
    for flag in outcome.flags:
        assert numbers(flag.code) == []
        assert numbers(flag.action) == []
    # Every number the outcome holds at all is a recorded *input*, and the only
    # place one lands is `rule_flags`.
    from_flags = [one for flag in outcome.flags for one in numbers(dict(flag.facts))]
    assert numbers(outcome) == from_flags


# --- Ordering, tracing and the narration decision -------------------------------


def test_two_rules_with_conflicting_actions_resolve_to_the_strictest() -> None:
    targets = _targets(9)
    day = _day(9, targets)
    context = _context(day, targets)

    pairs = (
        (("annotate", "withhold"), "withhold"),
        (("withhold", "annotate"), "withhold"),
        (("annotate", "demote"), "demote"),
        (("demote", "annotate"), "demote"),
        (("demote", "withhold"), "withhold"),
    )
    for actions, strictest in pairs:
        declared = [
            _demote("net_surplus") if action == "demote" else _always(f"r{index}", action)
            for index, action in enumerate(actions)
        ]
        # `_demote` always carries the same code; rename the second one.
        declared = [
            rule
            if rule.code != "fixture_demote"
            else Rule(
                code=f"d{index}",
                action="demote",
                fires=rule.fires,
                demotes=rule.demotes,
            )
            for index, rule in enumerate(declared)
        ]
        outcome = apply_rules(context, declared)
        assert outcome.governing_action == strictest
        assert len(outcome.flags) == len(actions)


def test_the_declared_order_is_the_evaluation_order_and_decides_nothing() -> None:
    targets = _targets(10)
    day = _day(10, targets)
    context = _context(day, targets, ranking_is_noise=True, weather_run_age_hours=3.0)

    forward = apply_rules(context, SHIPPING_RULES)
    backward = apply_rules(context, tuple(reversed(SHIPPING_RULES)))

    assert [one.code for one in backward.flags] == list(
        reversed([one.code for one in forward.flags])
    )
    assert forward.governing_action == backward.governing_action
    assert forward.demoted == backward.demoted
    assert sorted(forward.withheld_by) == sorted(backward.withheld_by)


def test_a_rule_declared_twice_is_refused() -> None:
    targets = _targets(11)
    day = _day(11, targets)
    twice = [_always("same", "annotate"), _always("same", "annotate")]
    with pytest.raises(RuleError, match="declared twice"):
        apply_rules(_context(day, targets), twice)


def test_a_rule_may_annotate_demote_or_withhold_and_nothing_else() -> None:
    assert RULE_ACTION_ORDER == ("annotate", "demote", "withhold")
    with pytest.raises(RuleError, match="may do nothing else"):
        _always("rewrites", "rewrite")
    with pytest.raises(RuleError, match="may do nothing else"):
        _always("recomputes", "recompute")
    # The action is a *field*, fixed at construction. Only a `demote` rule may
    # name a group, and it must.
    with pytest.raises(RuleError, match="only one that may name a group"):
        Rule(
            code="annotates_and_demotes",
            action="annotate",
            fires=lambda context: {},
            demotes=lambda context: frozenset({"net_surplus"}),
        )
    with pytest.raises(RuleError, match="only one that may name a group"):
        Rule(code="demotes_nothing", action="demote", fires=lambda context: {})


def test_a_fired_rule_always_appears_in_the_flags_with_its_inputs() -> None:
    """Every fired rule is traceable to the inputs that fired it."""
    targets = _targets(2)
    targets[4, RUN_AGE_COLUMN] = 12.0
    day = _day(2, targets)
    context = _context(
        day,
        targets,
        day_occurrence_probability=0.02,
        hours_p50_nonzero=0,
        ranking_is_noise=True,
        recent_reasons=ReasonMix(
            settled_date=date(2026, 3, 3), shares={UNMODELLED_REASON: 0.62, "ENE": 0.38}
        ),
    )
    outcome = apply_rules(context)

    assert [one.code for one in outcome.flags] == list(SHIPPING_RULE_CODES)
    facts = {one.code: dict(one.facts) for one in outcome.flags}
    assert facts["nothing_to_explain"] == {
        "day_occurrence_probability": 0.02,
        "lowest_risk_bin_edge": 0.15,
        "hours_p50_nonzero": 0,
    }
    assert facts["attribution_is_noise"] == {
        "sum_abs_attributed_mwh": day.sum_abs_attributed_mwh,
        "attribution_stderr_mwh": day.attribution_stderr_mwh,
    }
    assert facts["stale_inputs"]["weather_run_age_hours"] == 12.0
    assert facts["unmodelled_outage_regime"] == {
        "settled_date": "2026-03-03",
        "top_reason": "REL",
        "top_reason_share": 0.62,
    }
    # And the payload carries them verbatim, as `rule_flags`.
    payload = _row(day, targets, outcome)
    assert [one["code"] for one in payload["rule_flags"]] == list(SHIPPING_RULE_CODES)
    assert payload["governing_rule_action"] == "withhold"


def test_a_fact_the_narration_could_not_state_is_refused() -> None:
    targets = _targets(13)
    day = _day(13, targets)
    smuggler = Rule(
        code="smuggles_an_object",
        action="annotate",
        fires=lambda context: {"attribution": object()},  # type: ignore[dict-item]
    )
    with pytest.raises(RuleError, match="JSON scalar"):
        apply_rules(_context(day, targets), [smuggler])


def test_a_withhold_rule_names_itself_and_sends_the_template() -> None:
    """`withhold` acts on the narration and returns the drivers untouched."""
    targets = _targets(14)
    day = _day(14, targets)
    outcome = apply_rules(_context(day, targets, ranking_is_noise=True))

    assert outcome.withheld_by == ("attribution_is_noise",)
    assert outcome.narration_source == "template"
    payload = _row(day, targets, outcome)
    assert len(payload["groups"]) == len(DRIVER_GROUP_CODES)
    assert _frozen(payload) == _frozen(_row(day, targets))


def test_nothing_fired_is_an_absence_and_not_a_fourth_action() -> None:
    targets = _targets(15)
    day = _day(15, targets)
    outcome = apply_rules(_context(day, targets, ranking_is_noise=False))

    assert outcome.flags == ()
    assert outcome.governing_action is None
    assert outcome.withheld_by == ()
    assert outcome.narration_source == "model"


# --- The four that ship ---------------------------------------------------------


def _fires(code: str, context: RuleContext) -> FiredRule | None:
    rule = next(one for one in SHIPPING_RULES if one.code == code)
    outcome = apply_rules(context, [rule])
    return outcome.flags[0] if outcome.flags else None


def test_nothing_to_explain_needs_both_halves() -> None:
    targets = _targets(16)
    day = _day(16, targets)

    quiet = _context(day, targets, day_occurrence_probability=0.05, hours_p50_nonzero=0)
    assert _fires("nothing_to_explain", quiet) is not None
    # Below the edge, but the magnitude model still puts energy on the day.
    assert (
        _fires(
            "nothing_to_explain",
            _context(day, targets, day_occurrence_probability=0.05, hours_p50_nonzero=1),
        )
        is None
    )
    # At the edge is not below it.
    assert (
        _fires(
            "nothing_to_explain",
            _context(day, targets, day_occurrence_probability=0.15, hours_p50_nonzero=0),
        )
        is None
    )


def test_attribution_is_noise_reads_the_published_standard_error() -> None:
    targets = _targets(17)
    day = _day(17, targets)

    assert _fires("attribution_is_noise", _context(day, targets, ranking_is_noise=True))
    assert (
        _fires("attribution_is_noise", _context(day, targets, ranking_is_noise=False))
        is None
    )
    # And the predicate is the attribution's own, not a second one that agrees.
    assert (
        _context(day, targets).ranking_is_noise
        == day.ranking_is_noise
        == (day.sum_abs_attributed_mwh <= 2.0 * day.attribution_stderr_mwh)
    )


def test_stale_inputs_fires_on_each_of_its_three_degradations() -> None:
    healthy = _targets(18)
    day = _day(18, healthy)
    assert _fires("stale_inputs", _context(day, healthy)) is None

    stale = healthy.copy()
    stale[7, RUN_AGE_COLUMN] = 6.0
    assert _fires("stale_inputs", _context(day, stale)) is not None

    partial = healthy.copy()
    partial[3, COVERAGE_COLUMN] = 0.4
    flag = _fires("stale_inputs", _context(day, partial))
    assert flag is not None
    assert flag.facts["weather_centroid_coverage"] == 0.4

    missing = healthy.copy()
    top_group = day.notable()[0].code
    missing[:, NAMES.index(FIXTURE_MAP.group(top_group).headline_feature)] = np.nan
    flag = _fires("stale_inputs", _context(day, missing))
    assert flag is not None
    assert flag.facts["null_headline_features"] == (
        FIXTURE_MAP.group(top_group).headline_feature,
    )


def test_stale_inputs_ignores_a_null_headline_below_the_fold() -> None:
    """ "Any *displayed* group's headline feature" — the display cut is shared."""
    targets = _targets(19)
    day = _day(19, targets)
    notable = {one.code for one in day.notable()}
    below = next(code for code in DRIVER_GROUP_CODES if code not in notable)

    hidden = targets.copy()
    hidden[:, NAMES.index(FIXTURE_MAP.group(below).headline_feature)] = np.nan
    assert _fires("stale_inputs", _context(day, hidden)) is None


def test_unmodelled_outage_regime_fires_only_when_REL_leads() -> None:  # noqa: N802
    targets = _targets(20)
    day = _day(20, targets)
    settled = date(2026, 3, 3)

    leads = ReasonMix(settled_date=settled, shares={"REL": 0.62, "ENE": 0.38})
    assert _fires(
        "unmodelled_outage_regime", _context(day, targets, recent_reasons=leads)
    )

    trails = ReasonMix(settled_date=settled, shares={"REL": 0.2, "ENE": 0.8})
    assert (
        _fires("unmodelled_outage_regime", _context(day, targets, recent_reasons=trails))
        is None
    )
    # An absence is not a firing.
    assert (
        _fires("unmodelled_outage_regime", _context(day, targets, recent_reasons=None))
        is None
    )
    # Nor is a tie: two reasons sharing the largest share means no reason
    # accounts for the largest share of the day.
    tied = ReasonMix(settled_date=settled, shares={"REL": 0.5, "ENE": 0.5})
    assert (
        _fires("unmodelled_outage_regime", _context(day, targets, recent_reasons=tied))
        is None
    )


# --- `recent_reasons` comes off the wire, from a real read ---------------------
#
# `.scratch/api-surface/issues/10-forecast-publication.md`'s fourth box.
# Diagnosis 07 shipped `unmodelled_outage_regime`, its predicate and its facts,
# complete and tested against a *supplied* `ReasonMix` — and left the read
# unbuilt, so the rule could not fire in production. `apps/api`'s
# `src/diagnosis/reason-mix.ts` is the read; `reason_mixes_from_payload` is this
# side of the wire; these are the tests that the two meet.


def test_the_rule_fires_from_a_reason_mix_read_off_the_wire() -> None:
    """End to end on this side: the payload shape the gateway sends fires it.

    The document below is `reasonMixPayload`'s output verbatim — a settled date
    and shares, no MWh — for a day the read found `REL` leading on. The rule
    firing from *that* rather than from a hand-built `ReasonMix` is the whole
    point of the box: what was missing was never the rule.
    """
    targets = _targets(21)
    day = _day(21, targets)
    wire = {
        "NE": {"settled_date": "2026-03-02", "shares": {"REL": 0.62, "ENE": 0.38}},
        "S": {"settled_date": "2026-03-02", "shares": {"CNF": 0.9, "REL": 0.1}},
    }

    mixes = reason_mixes_from_payload(wire)
    assert set(mixes) == {"NE", "S"}
    assert mixes["NE"].settled_date == date(2026, 3, 2)
    assert mixes["NE"].top_reason == UNMODELLED_REASON

    fired = _fires(
        "unmodelled_outage_regime", _context(day, targets, recent_reasons=mixes["NE"])
    )
    assert fired is not None
    assert fired.facts == {
        "settled_date": "2026-03-02",
        "top_reason": "REL",
        "top_reason_share": 0.62,
    }
    # And the subsystem whose day was led by a different reason does not fire,
    # so the map is read per subsystem rather than as one national answer.
    assert (
        _fires(
            "unmodelled_outage_regime",
            _context(day, targets, recent_reasons=mixes["S"]),
        )
        is None
    )


def test_a_subsystem_with_no_settled_day_is_absent_rather_than_zeroed() -> None:
    """An absence stays an absence all the way to the predicate."""
    targets = _targets(22)
    day = _day(22, targets)
    # What the gateway sends when no subsystem had a qualifying settled day:
    # an empty block, never four mixes of zeros.
    assert reason_mixes_from_payload({}) == {}
    assert reason_mixes_from_payload(None) == {}
    # And the rule does not fire on it, which is the difference that matters:
    # "nothing was restricted" and "we cannot see that day yet" would otherwise
    # be the same input to a rule that annotates the screen.
    assert (
        _fires(
            "unmodelled_outage_regime",
            _context(
                day, targets, recent_reasons=reason_mixes_from_payload({}).get("NE")
            ),
        )
        is None
    )


def test_a_malformed_reason_block_is_refused_rather_than_dropped() -> None:
    """A dropped block looks exactly like an absent day, so it is refused.

    Each case is a way the gateway could get this wrong, and each has to fail
    loudly: a silently dropped mix is a rule that quietly stops firing, which is
    the state this box was closing in the first place.
    """
    with pytest.raises(RuleContextError, match="not a mapping"):
        reason_mixes_from_payload([{"settled_date": "2026-03-02"}])
    with pytest.raises(RuleContextError, match="not a subsystem"):
        reason_mixes_from_payload({"SIN": {"settled_date": "2026-03-02", "shares": {}}})
    with pytest.raises(RuleContextError, match="no settled_date"):
        reason_mixes_from_payload({"NE": {"shares": {"REL": 1.0}}})
    with pytest.raises(RuleContextError, match="no shares"):
        reason_mixes_from_payload({"NE": {"settled_date": "2026-03-02"}})
    with pytest.raises(RuleContextError, match="settled_date is"):
        reason_mixes_from_payload({"NE": {"settled_date": "the 2nd", "shares": {}}})
    # And the reason vocabulary stays `ReasonMix`'s to police, so the two
    # cannot come to disagree about it.
    with pytest.raises(RuleContextError, match="not a ReasonCode"):
        reason_mixes_from_payload(
            {"NE": {"settled_date": "2026-03-02", "shares": {"RELAX": 1.0}}}
        )


def test_the_shipping_rules_read_only_context_fields() -> None:
    """ "Every quantity in its predicate is an ingested column or an artifact field."

    Read off the AST: each predicate's attribute accesses on its ``context``
    argument must all be declared fields, and every declared field must have a
    stated provenance. A predicate that reached for something else would have to
    add a field, and adding one without a provenance fails here.
    """
    declared = set(context_field_names())
    assert declared == set(FIELD_PROVENANCE)
    assert not declared - set(FIELD_PROVENANCE)

    read: set[str] = set()
    for node in ast.walk(RULES_TREE):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "context"
        ):
            read.add(node.attr)
    assert read, "no predicate reads the context at all"
    assert read <= declared, f"a predicate reads {sorted(read - declared)}"


def test_the_reopening_trigger_is_recorded_in_the_module() -> None:
    """ "Bounded deferral, not a shrug" — and the next session reads the code."""
    for phrase in (
        "three point-in-time folds",
        "driver-stability report",
        "20 days",
        "ingested column or an artifact field",
        "annotate or demote",
        "separate review",
    ):
        assert phrase in REOPENING_TRIGGER
    assert (
        REOPENING_TRIGGER in rules_module.__doc__ or "REOPENING_TRIGGER" in RULES_SOURCE
    )


# --- The projection the rules see -----------------------------------------------


def test_the_context_reports_the_days_worst_hour() -> None:
    targets = _targets(21)
    targets[5, RUN_AGE_COLUMN] = 11.0
    targets[9, COVERAGE_COLUMN] = 0.6
    day = _day(21, targets)
    context = _context(day, targets)

    assert context.weather_run_age_hours == 11.0
    assert context.weather_centroid_coverage == 0.6


def test_a_column_that_is_NULL_all_day_is_an_absence_not_a_zero() -> None:  # noqa: N802
    healthy = _targets(22)
    day = _day(22, healthy)
    targets = healthy.copy()
    targets[:, RUN_AGE_COLUMN] = np.nan
    context = _context(day, targets)

    assert context.weather_run_age_hours is None
    # It still degrades the day — through the headline-feature half, if the
    # column is a notable group's headline — but never as a run age of zero.
    assert context.weather_centroid_coverage == 1.0


def test_a_context_needs_a_whole_day_under_the_contract_it_names() -> None:
    targets = _targets(23)
    day = _day(23, targets)

    with pytest.raises(RuleContextError, match="Brasília civil day"):
        build_rule_context(
            day,
            target_rows=targets[:23],
            feature_names=NAMES,
            risk_bins=RISK_BINS,
            day_occurrence_probability=0.5,
            hours_p50_nonzero=3,
            group_map=FIXTURE_MAP,
        )
    with pytest.raises(RuleContextError, match="columns wide"):
        build_rule_context(
            day,
            target_rows=targets,
            feature_names=NAMES[:-1],
            risk_bins=RISK_BINS,
            day_occurrence_probability=0.5,
            hours_p50_nonzero=3,
            group_map=FIXTURE_MAP,
        )
    with pytest.raises(RuleContextError, match="no lowest"):
        build_rule_context(
            day,
            target_rows=targets,
            feature_names=NAMES,
            risk_bins={},
            day_occurrence_probability=0.5,
            hours_p50_nonzero=3,
            group_map=FIXTURE_MAP,
        )


def test_a_missing_pipeline_column_is_loud_rather_than_a_rule_that_never_fires() -> None:
    """A contract without `weather_run_age_hours` breaks `stale_inputs` silently."""
    without = tuple(name for name in NAMES if name != WEATHER_RUN_AGE_FEATURE)
    targets = _targets(24)
    day = _day(24, targets)
    columns = [NAMES.index(name) for name in without]

    with pytest.raises(RuleContextError, match=WEATHER_RUN_AGE_FEATURE):
        build_rule_context(
            day,
            target_rows=targets[:, columns],
            feature_names=without,
            risk_bins=RISK_BINS,
            day_occurrence_probability=0.5,
            hours_p50_nonzero=3,
            group_map=FIXTURE_MAP,
        )


def test_the_context_holds_no_reference_back_to_the_attribution() -> None:
    """The valve's first half: a rule has nothing to write to.

    Walked over the context's own values — if any of them *is* the attribution,
    a contribution or the background, a predicate could reach a published
    number through it whatever the AST walk says about names.
    """
    targets = _targets(25)
    day = _day(25, targets)
    context = _context(day, targets)

    forbidden = (DayAttribution, MatchedBackground, np.ndarray)
    for name in context_field_names():
        value = getattr(context, name)
        assert not isinstance(value, forbidden), f"{name} carries {type(value)}"
    assert day not in vars(context).values()
