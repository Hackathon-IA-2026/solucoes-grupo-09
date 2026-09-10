"""Domain rules — a one-way valve, and four rules that go through it.

`docs/specs/diagnosis.md`, "Domain rules — the arbitration mechanism now, most
of the content later", and seam 8. The mechanism is built here and most of its
content is deferred on purpose: a mechanism designed after the rules exist is
designed to fit them.

## The valve

**A rule may ``annotate``, ``demote`` or ``withhold``. No rule may change a
number and no rule may create or delete a driver.** That is the whole design.
An attribution a rule could overwrite would no longer be the model's, and every
property the rest of the system establishes about the model — the reliability
curve, the coverage report, the shuffled-label control — would stop describing
what is on the screen. A rule's power is over *what gets said*, never over
*what is true of the model*.

The valve is structural rather than intended, in three places that have to be
broken together for a rule to reach a number:

1. **A rule is never handed one.** Its only argument is a
   :class:`~wattsteer_ml.diagnosis.rule_context.RuleContext` — a frozen
   projection of scalars, codes and a date, holding no reference to the
   attribution they were read off. Nothing this module can see is the object
   the payload copies its numbers from.
2. **A rule cannot say a number.** Its return type is *the facts that fired
   it*, and the engine — not the rule — decides the action, from the action the
   rule **declared** when it was constructed. :class:`RuleOutcome` carries
   flags, group **codes** and a narration source, and there is no field on it a
   ``Φ``, a share, a rank or a probability could travel in.
3. **This module never names an attribution type**, which
   ``tests/test_domain_rules.py`` asserts by walking this file's AST — the same
   move the member-level-``φ`` prohibition is enforced with one layer down. A
   later "small refactor" that reaches for a ``DayAttribution`` here fails a
   test before it can reach a screen.

**``withhold`` acts on the narration, never on the attribution.** A withheld
day publishes its drivers untouched, names the rules that withheld it, and
renders the deterministic template in place of the model's paragraph. The
language model is not called at all — asserted on the client not being invoked,
never on its output being discarded.

**When a rule and the attribution disagree, both are published and neither
wins.** A rule asserts a fact about the *grid*; a ``Φ`` asserts a fact about the
*model*. They are not the same kind of claim, so "resolving" them would mean
silently converting one into the other.

**Ordering, so two rules cannot both claim the last word.** Rules evaluate in
declared order, every fired rule is recorded with the inputs that fired it, and
the strictest action any fired rule took governs:
``withhold`` > ``demote`` > ``annotate``.

## The four that ship

None of them needs a constant that does not already exist as data, which is why
these four and not others:

============================ ========== ===============================================
``code``                     action     fires when
============================ ========== ===============================================
``nothing_to_explain``       withhold   the day's occurrence probability is below the
                                        lowest ``risk_bins`` edge **and** no hour's P50
                                        is non-zero
``attribution_is_noise``     withhold   ``Σ_j |Φ_j| ≤ 2 × attribution_stderr_mwh`` — the
                                        ranking is smaller than its own error
``stale_inputs``             annotate   the weather run age is above zero, or centroid
                                        coverage is below full, or a displayed group's
                                        headline feature was NULL at serve time
``unmodelled_outage_regime`` annotate   on the most recent settled day for this
                                        subsystem, ``REL`` accounts for the largest
                                        share of constrained-off MWh
============================ ========== ===============================================

``unmodelled_outage_regime`` is the sharpest honest rule available today, and it
exists because `docs/specs/forecaster.md` already ruled the reason-code model
out on the ground that **no ingested dataset carries transmission
availability**. When yesterday's curtailment was mostly external unavailability,
the model is explaining a mechanism it structurally cannot see, and the screen
should say so next to the bars rather than in a footnote nobody reads. Reading
ONS's own reported reason is not a causal claim and makes none
(`docs/domain-model.md` §10).

**No shipping rule demotes.** The action exists, is plumbed end to end and is
tested, and the deferred physics rules are where it will first be used — see
:data:`REOPENING_TRIGGER`. A ``demoted`` flag that no rule can raise is a column
nobody can trust the day one does.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from wattsteer_ml.diagnosis.publication import (
    RULE_ACTION_ORDER,
    FiredRule,
    RuleAction,
)
from wattsteer_ml.diagnosis.rule_context import UNMODELLED_REASON, RuleContext
from wattsteer_ml.driver_groups import DRIVER_GROUP_CODES, GroupCode

#: What a fired rule may record. JSON scalars and lists of codes, because
#: ``rule_flags`` is a ``jsonb`` column the narration is **required** to state,
#: and a fact the renderer cannot pronounce is a fact nobody reads.
Fact = str | int | float | bool | None | tuple[str, ...]

#: A predicate returns *the inputs that fired it*, or ``None``. It does not
#: return an action: the action is the rule's declared one, fixed when the rule
#: was constructed, so no rule can escalate itself at evaluation time.
Predicate = Callable[[RuleContext], Mapping[str, Fact] | None]

#: Which groups a ``demote`` rule pushes below the fold. **Codes, never
#: contributions** — the bar keeps its ``Φ``, its sign, its share and its rank.
Demotion = Callable[[RuleContext], frozenset[GroupCode]]

#: Where the deferred rules reopen, recorded in code because the next session
#: reads the module before it reads the spec.
#:
#: Every rule that would encode grid *physics* — "NE export saturated at the
#: corridor limit ⇒ export stress must be named"; "hydro reservoirs above X ⇒
#: inflexibility dominates" — needs a threshold nobody can set today. This is a
#: bounded deferral and not a shrug:
REOPENING_TRIGGER = (
    "Reopen when three point-in-time folds exist and the driver-stability "
    "report has been produced. A candidate rule is admitted only if (a) it "
    "fires on at least 20 days in that report, (b) every quantity in its "
    "predicate is an ingested column or an artifact field, and (c) its action "
    "is annotate or demote — a new withhold rule needs a separate review, "
    "because withholding is the only action a user can notice as an absence."
)

#: Which narration surface renders. ``template`` is not a degradation here: a
#: withheld day is a day the deterministic sentence is the honest one.
NarrationSource = Literal["model", "template"]


class RuleError(ValueError):
    """A rule, or a set of them, that could not be evaluated as declared."""


@dataclass(frozen=True)
class Rule:
    """A predicate with exactly one declared action, and nothing else.

    The action is a **field**, not a return value. A rule author writes the
    predicate and picks one of three actions once; there is no code path by
    which evaluating a rule chooses a different one, and no fourth action to
    pick.
    """

    code: str
    action: RuleAction
    fires: Predicate
    #: Only a ``demote`` rule may carry one, and it must.
    demotes: Demotion | None = None

    def __post_init__(self) -> None:
        if not self.code:
            raise RuleError("a rule with no code cannot appear in the flags")
        if self.action not in RULE_ACTION_ORDER:
            raise RuleError(
                f"{self.code!r} claims the action {self.action!r}; a rule may "
                "annotate, demote or withhold, and may do nothing else"
            )
        if (self.action == "demote") != (self.demotes is not None):
            raise RuleError(
                f"{self.code!r} declares {self.action!r} and "
                f"{'names' if self.demotes is not None else 'names no'} groups "
                "to demote; demoting is the only action that moves a bar below "
                "the fold, and it is the only one that may name a group"
            )


@dataclass(frozen=True)
class RuleOutcome:
    """Everything the rules decided. Not one of it is a number on the screen.

    Read this type as the shape of the valve: four fields, three of them codes
    and one of them the recorded inputs of whatever fired. There is nowhere on
    it for a ``Φ``, a share, a rank, a probability or a band to travel, so
    handing it to the publication cannot move one.
    """

    #: Every fired rule, in declared order, with the inputs that fired it.
    flags: tuple[FiredRule, ...]
    #: The groups a ``demote`` rule pushed below the fold. A **display** fact,
    #: stored beside a complete contribution and never in place of one.
    demoted: frozenset[GroupCode]
    #: The strictest action any fired rule took, or ``None`` when none fired.
    governing_action: RuleAction | None
    #: The codes of the rules that withheld, in declared order. The API
    #: publishes this as ``withheld_by`` beside untouched drivers.
    withheld_by: tuple[str, ...]
    #: Every rule code the engine **evaluated**, in declared order — not only
    #: the ones that fired.
    #:
    #: This is the field that turns "the rules ran and nothing fired" into a
    #: statement rather than an absence. ``flags=()`` alone cannot say it: it is
    #: also what a publish path that never called :func:`apply_rules` would
    #: produce, and `.scratch/api-surface/issues/10-forecast-publication.md`
    #: named that exact indistinguishability as the one place the one-way valve
    #: was still a convention. A row now carries the roll call, so the two cases
    #: are different values and the empty one is refused all the way down —
    #: here, in :class:`~wattsteer_ml.diagnosis.publication.AttributionRow`, at
    #: the gateway's parse, and by a NOT NULL column with a cardinality check.
    #:
    #: It is a list of **codes**, which is the only thing it could be: a count
    #: would not say *which*, and a boolean would be a claim with no evidence
    #: on it.
    evaluated: tuple[str, ...]

    @property
    def narration_source(self) -> NarrationSource:
        """Which surface may render — the whole of what ``withhold`` does."""
        return "template" if self.governing_action == "withhold" else "model"

    def for_row(self) -> dict[str, Any]:
        """The rule fields of a published attribution row, as keyword arguments.

        ``AttributionRow(attribution=…, readings=…, **outcome.for_row())`` is
        the whole of the ordinary path, which is the point: the one-line call
        supplies the roll call, and a publish path that wanted an empty-flagged
        row would have to spell out a lie rather than accept a default.

        Returns a plain mapping and never names a publication type, so this
        module still cannot reach a published number —
        ``tests/test_domain_rules.py``'s AST walk over this file is what holds
        that, and it is unchanged.
        """
        return {
            "rule_flags": self.flags,
            "rules_evaluated": self.evaluated,
            "demoted": self.demoted,
        }


def _facts(rule: Rule, found: Mapping[str, Fact]) -> Mapping[str, Fact]:
    for name, value in found.items():
        if not isinstance(value, str | int | float | bool | tuple | type(None)):
            raise RuleError(
                f"{rule.code!r} recorded {name}={value!r}; a fact is a value the "
                "narration is required to state, so it is a JSON scalar and "
                "never an object a renderer cannot pronounce"
            )
    return dict(found)


def _demoted(rule: Rule, context: RuleContext) -> frozenset[GroupCode]:
    if rule.demotes is None:
        return frozenset()
    codes = rule.demotes(context)
    unknown = sorted(set(codes) - set(DRIVER_GROUP_CODES))
    if unknown:
        raise RuleError(
            f"{rule.code!r} demotes {', '.join(unknown)}, which is not a driver "
            "group; a rule may push a bar below the fold and may not invent one"
        )
    return frozenset(codes)


def apply_rules(context: RuleContext, rules: Sequence[Rule] | None = None) -> RuleOutcome:
    """Evaluate the rules in declared order and record what they decided.

    Nothing is applied to anything here. The outcome travels beside the
    attribution — the caller passes ``outcome.flags`` and ``outcome.demoted`` to
    :class:`~wattsteer_ml.diagnosis.publication.AttributionRow`, which copies
    every number off the ``DayAttribution`` itself — so "the rules ran" and "the
    numbers changed" are not two readings of the same event.

    Args:
        context: the projection of the four inputs a rule may read.
        rules: the rules to evaluate, in declared order.
            :data:`SHIPPING_RULES` by default.

    Raises:
        RuleError: if two rules share a code, or a rule records a fact the
            narration could not state, or demotes a group that does not exist.
    """
    declared = SHIPPING_RULES if rules is None else tuple(rules)
    if not declared:
        # `rules=()` would return an outcome that is indistinguishable from one
        # nothing was evaluated for, which is precisely the state the roll call
        # exists to make unrepresentable. A caller that wants no rules to fire
        # passes rules that do not fire, not no rules.
        raise RuleError(
            "a rule set with no rules in it evaluates nothing; an outcome with "
            "an empty roll call cannot be told apart from a publish path that "
            "never ran the rules at all, and that is the one state a published "
            "attribution may not carry"
        )
    seen: set[str] = set()
    for rule in declared:
        if rule.code in seen:
            raise RuleError(
                f"{rule.code!r} is declared twice; a fired rule is traced by its "
                "code and two of them make the trace ambiguous"
            )
        seen.add(rule.code)

    flags: list[FiredRule] = []
    demoted: set[GroupCode] = set()
    withheld_by: list[str] = []
    for rule in declared:
        found = rule.fires(context)
        if found is None:
            continue
        flags.append(
            FiredRule(code=rule.code, action=rule.action, facts=_facts(rule, found))
        )
        demoted |= _demoted(rule, context)
        if rule.action == "withhold":
            withheld_by.append(rule.code)

    governing: RuleAction | None = None
    if flags:
        governing = max((one.action for one in flags), key=RULE_ACTION_ORDER.index)
    return RuleOutcome(
        flags=tuple(flags),
        demoted=frozenset(demoted),
        governing_action=governing,
        withheld_by=tuple(withheld_by),
        # The roll call, in declared order, whatever fired. `declared` is
        # non-empty by construction — `SHIPPING_RULES` is four rules and an
        # explicitly empty `rules` argument is refused below — so a published
        # row can never carry an empty one from this function.
        evaluated=tuple(rule.code for rule in declared),
    )


# --- The four that ship --------------------------------------------------------
#
# Every numeric literal below is a bound of the quantity it compares — ``0`` is
# "not stale at all" and ``1`` is "the whole centroid set" — and never a
# threshold somebody chose. The one threshold in the table, the ``2 ×`` on the
# standard error, is not here either: it is decided beside the two numbers it
# compares, by `DayAttribution.ranking_is_noise`, and reaches the context as a
# fact. A test asserts this file holds no other number.


def _nothing_to_explain(context: RuleContext) -> Mapping[str, Fact] | None:
    """A day with no risk and no magnitude has no ranking worth narrating."""
    if context.day_occurrence_probability >= context.lowest_risk_bin_edge:
        return None
    if context.hours_p50_nonzero > 0:
        return None
    return {
        "day_occurrence_probability": context.day_occurrence_probability,
        "lowest_risk_bin_edge": context.lowest_risk_bin_edge,
        "hours_p50_nonzero": context.hours_p50_nonzero,
    }


def _attribution_is_noise(context: RuleContext) -> Mapping[str, Fact] | None:
    """The ranking is smaller than its own background-sampling error."""
    if not context.ranking_is_noise:
        return None
    return {
        "sum_abs_attributed_mwh": context.sum_abs_attributed_mwh,
        "attribution_stderr_mwh": context.attribution_stderr_mwh,
    }


def _stale_inputs(context: RuleContext) -> Mapping[str, Fact] | None:
    """A confident-looking explanation built on a quiet degradation."""
    run_age = context.weather_run_age_hours
    coverage = context.weather_centroid_coverage
    stale_run = run_age is not None and run_age > 0
    partial_coverage = coverage is not None and coverage < 1
    if not (stale_run or partial_coverage or context.null_headline_features):
        return None
    return {
        "weather_run_age_hours": run_age,
        "weather_centroid_coverage": coverage,
        "null_headline_features": context.null_headline_features,
    }


def _unmodelled_outage_regime(context: RuleContext) -> Mapping[str, Fact] | None:
    """Yesterday was mostly a mechanism this model structurally cannot see."""
    recent = context.recent_reasons
    if recent is None or recent.top_reason != UNMODELLED_REASON:
        return None
    return {
        "settled_date": recent.settled_date.isoformat(),
        "top_reason": recent.top_reason,
        "top_reason_share": recent.top_reason_share,
    }


#: The declared order, which is the evaluation order. The two ``withhold``
#: rules come first so that a trace reads in the order the spec's table does;
#: the order does not decide the outcome — the strictest action does — and a
#: test asserts that reversing it changes nothing but the order of the flags.
SHIPPING_RULES: tuple[Rule, ...] = (
    Rule(code="nothing_to_explain", action="withhold", fires=_nothing_to_explain),
    Rule(code="attribution_is_noise", action="withhold", fires=_attribution_is_noise),
    Rule(code="stale_inputs", action="annotate", fires=_stale_inputs),
    Rule(
        code="unmodelled_outage_regime",
        action="annotate",
        fires=_unmodelled_outage_regime,
    ),
)

SHIPPING_RULE_CODES: tuple[str, ...] = tuple(one.code for one in SHIPPING_RULES)
