"""What a gate profile may see — and why the two lanes are two experiments.

`docs/specs/forecaster.md` recommends serving two artifacts: the morning view at
``gate_early`` and the evening view at ``gate_late``, the second superseding the
first as a newer vintage of the same valid hours. It is easy to read that as one
model published twice, or as one model and a worse-tuned copy of it. It is
neither, and this module is where the difference is written down once.

**The measured fact.** `docs/specs/feature-engineering.md` §"The day-ahead
programme" fixes the programme for day D at **D−1 15:00 BRT**, six hours after
``gate_early``'s D−1 09:00 BRT. `docs/research/publication-lag.md` tightened the
evidenced bound to an observed 11:53 BRT and that is still after 09:00. So every
``programmed_*`` column is NULL at the early gate, and with it every ``proxy_*``
column — the proxies subtract from the programme, and no term of that
subtraction is coalesced to zero. Nobody repaired it: reaching for an earlier
hour would put a value in the column that the served model will not have at
09:00, which is the exact leak the feature spec exists to prevent. The whole
``dessem_*`` family is absent at ``gate_early`` too, for a *different* reason —
DESSEM for day D is not published until the evening of D−1 at all, so its
absence is structural rather than a publication instant nobody moved.

**Two reasons, kept apart.** :class:`WithheldReason` is the distinction, and it
is not decoration: one of them could change if an earlier programme publication
were ever evidenced (`docs/research/publication-lag.md`'s scheduled probe is
what would settle it), and the other cannot change at all. A card that folded
them together would invite somebody to go looking for a fix to the half that has
none.

**Why this is not "unpopulated".**
:attr:`~wattsteer_ml.training.contract.FeatureContract.unpopulated` names a
column the training rows showed as NULL throughout, and its stated meaning is "a
feature block that exists but has no data behind it yet" — a temporary state
somebody should go and fix. At ``gate_early`` the twelve set-A programme and
proxy columns are unpopulated *and always will be*, and reading them as pending
ingestion is the misreading this module removes. The early lane has weather,
calendar, capacity and lagged actuals, and no programme and no residual load,
**by construction**; that is a different experiment from the late one, not a
worse-tuned copy of it.

**The authority is the database, not this file.** ``available_at_gate_early`` is
a column of ``feature_dictionary_entry``, seeded in
`apps/api/drizzle/0033_both_feature_sets_and_the_dictionary.sql` and held to the
DESSEM rule by a CHECK constraint. It reaches Python through the generated
:mod:`wattsteer_ml.model_inputs` artifact. No feature name is written here — a
second list would fail by agreeing with the wrong thing, which is how
``ordered_features.yaml`` failed.

**What the shapes here make unrepresentable:**

- **An attribute that is both admitted and withheld.** :class:`LaneVector`
  refuses the overlap, so the two counts it publishes are counts of a
  partition. That the partition is *total* — that it covers every model input
  of the set — is :func:`vector_for`'s job, since it is the only caller that
  has the whole ordered list, and `tests/test_two_lanes.py` asserts it there
  rather than here.
- **A withheld attribute without its reason.** :class:`WithheldAttribute`
  requires one, and the reason is derived from the column's class rather than
  supplied, so no caller can label a DESSEM column a publication-lag problem.
- **A contrast of a gate profile with itself.** :class:`LaneContrast` refuses
  two lanes that share a gate profile. What it publishes is the *difference in
  admissible attributes*, and between two lanes at one gate that difference is
  not the thing anybody is asking about.
- **Two lanes' numbers side by side with nothing between them.**
  :class:`LaneContrast` is the only shape in this service that holds both lanes
  at once, and it cannot be built without the census that says why they are not
  the same experiment.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from wattsteer_ml.caveated import CaveatedFigure
from wattsteer_ml.features import GateProfile
from wattsteer_ml.lanes import Lane
from wattsteer_ml.model_inputs import MODEL_INPUTS, ModelInput, ModelInputs

#: Why a feature set's two gate profiles do not have comparable scores.
#:
#: Found by the rule in :mod:`wattsteer_ml.caveated` rather than named by the
#: ticket, which is the point of having a rule: the morning and the evening
#: view are two experiments, so a *difference* between their scores is a
#: difference in what each was allowed to see. The sentence is the one this
#: block has always published, verbatim, and the feature set is filled in
#: through :meth:`~wattsteer_ml.caveated.CaveatedFigure.filled` because it
#: appears nowhere else in the block.
CROSS_GATE_DIFFERENCE_IS_NOT_QUALITY = CaveatedFigure(
    "The morning and the evening view are two experiments, not one "
    "model published twice. The evening view supersedes the morning "
    "one as a newer vintage of the same valid hours; a difference in "
    "{feature_set}'s scores across the two gates is a "
    "difference in what the model was allowed to see, and is not a "
    "statement about either model's quality.",
    figure=(
        "any score compared between one feature set's `gate_early` and "
        "`gate_late` artifacts — qloss_mwh, pr_auc, coverage, all of them"
    ),
    misreading=("that the gate profile with the better score is the better model"),
    surface=(
        "the model card's `lane.experiment` block, `note`, beside the `early` "
        "and `late` halves it is a statement about"
    ),
)

#: The gate profile at which every model input of a set is admissible. Named
#: rather than spelled ``!= "gate_early"``: the dictionary answers exactly one
#: availability question, and a third profile would need its own column there
#: before it could mean anything here.
LATE_GATE: GateProfile = "gate_late"

#: The early gate, D−1 09:00 BRT.
EARLY_GATE: GateProfile = "gate_early"

#: The feature-dictionary class of the DESSEM block. A column carrying it is
#: absent at ``gate_early`` structurally — DESSEM for day D does not exist that
#: morning — and ``feature_rows`` refuses ``dessem_augmented_v1`` at any gate
#: but the late one rather than returning a column of NULLs for it.
DESSEM_CLASS = "D"

#: Why an attribute is not available at ``gate_early``.
#:
#: ``structural`` — the source does not exist at that instant, and no
#: publication schedule could make it. ``publication_lag`` — the source exists
#: for day D but is published after the gate, so the column is NULL by
#: arithmetic on two instants rather than by the nature of the data.
WithheldReason = Literal["structural", "publication_lag"]

#: One sentence per reason, for the card and for the operator reading it at
#: 03:00. Stated here so the two readings cannot drift apart across the surfaces
#: that print them.
WITHHELD_REASONS: dict[WithheldReason, str] = {
    "structural": (
        "the source does not exist at this gate: DESSEM for day D is not "
        "published until the evening of D−1, so gate_early could not see it at "
        "any publication schedule"
    ),
    "publication_lag": (
        "the source exists for day D and is published after this gate: the "
        "ONS day-ahead programme is stamped D−1 15:00 BRT, six hours after "
        "gate_early's D−1 09:00 BRT, and the observed bound of 11:53 BRT is "
        "still after it. The proxy_* family subtracts from the programme and "
        "is NULL wherever it is"
    ),
}


class AdmissibilityError(ValueError):
    """A lane and the attributes it is bound to disagree about its gate."""


class WithheldAtGateError(AdmissibilityError):
    """A lane learnt from an attribute its gate cannot see.

    The leak `docs/specs/feature-engineering.md` exists to prevent, named at the
    one moment it is detectable: a ``gate_early`` artifact whose programme
    columns carry values has been fitted on a number it will not have at 09:00,
    and every fold it was scored on flattered it.
    """

    def __init__(self, lane: Lane, columns: tuple[str, ...]) -> None:
        super().__init__(
            f"{lane}: {list(columns)} carry values at {lane.gate_profile}, which "
            "cannot see them. A model fitted on a value it will not have at "
            "serve time is the leak the feature spec exists to prevent, so this "
            "is a refusal rather than a warning."
        )
        self.lane = lane
        self.columns = columns


@dataclass(frozen=True)
class WithheldAttribute:
    """One model input this gate profile cannot see, and why not."""

    column_name: str
    #: The feature dictionary's own notation — ``P``, ``P+W+T``, ``D+T``.
    class_label: str
    reason: WithheldReason

    @property
    def explanation(self) -> str:
        return WITHHELD_REASONS[self.reason]

    def as_dict(self) -> dict[str, Any]:
        return {
            "column_name": self.column_name,
            "class_label": self.class_label,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class LaneVector:
    """The census of one lane's experiment: what it may see, and what it may not.

    Not the design matrix. Nothing here drops a column from a fit — the vector
    the database returns is the vector the contract hashes, and a withheld
    column arrives as a NULL and stays one, because
    :mod:`wattsteer_ml.training.design` performs no imputation anywhere on the
    served path. What this says is which of those NULLs are a property of the
    gate rather than of the ingestion, which is the sentence a reader of the
    card cannot otherwise get.
    """

    feature_set: str
    gate_profile: str
    #: The inputs this gate can see, in the composite type's attribute order.
    admitted: tuple[str, ...]
    withheld: tuple[WithheldAttribute, ...]

    def __post_init__(self) -> None:
        if not self.admitted:
            raise AdmissibilityError(
                f"{self.feature_set} at {self.gate_profile} admits no model "
                "input; a lane with nothing to learn from is not a lane"
            )
        overlap = set(self.admitted) & set(self.withheld_names)
        if overlap:
            raise AdmissibilityError(
                f"{sorted(overlap)} are both admitted and withheld at "
                f"{self.gate_profile}; an attribute is one or the other"
            )

    @property
    def withheld_names(self) -> tuple[str, ...]:
        return tuple(item.column_name for item in self.withheld)

    @property
    def input_count(self) -> int:
        """Every model input of the set, admitted or not."""
        return len(self.admitted) + len(self.withheld)

    def withheld_for(self, reason: WithheldReason) -> tuple[str, ...]:
        return tuple(item.column_name for item in self.withheld if item.reason == reason)

    @property
    def headline(self) -> str:
        """One line naming this lane's experiment, for a human."""
        if not self.withheld:
            return (
                f"{self.feature_set} at {self.gate_profile}: all "
                f"{self.input_count} model inputs are available at this gate"
            )
        return (
            f"{self.feature_set} at {self.gate_profile}: {len(self.admitted)} of "
            f"{self.input_count} model inputs, with {len(self.withheld)} "
            "withheld by the gate. This is a different experiment from the "
            "late-gate lane, not a worse-tuned copy of it"
        )

    def card_fields(self) -> dict[str, Any]:
        """The card's ``lane.experiment`` block.

        On the same document as ``contract.unpopulated_features``, and that is
        the point: at ``gate_early`` those two lists overlap, and only this one
        says which of the NULLs nobody is going to fix.
        """
        return {
            "model_inputs": self.input_count,
            "admitted": len(self.admitted),
            "withheld": [item.as_dict() for item in self.withheld],
            "withheld_reasons": {
                reason: WITHHELD_REASONS[reason]
                for reason in ("structural", "publication_lag")
                if self.withheld_for(reason)
            },
            "headline": self.headline,
        }


def lane_vector(lane: Lane, *, inputs: ModelInputs = MODEL_INPUTS) -> LaneVector:
    """The census for one lane, from the generated model-input artifact."""
    return vector_for(
        feature_set=lane.feature_set, gate_profile=lane.gate_profile, inputs=inputs
    )


def vector_for(
    *,
    feature_set: str,
    gate_profile: str,
    inputs: ModelInputs = MODEL_INPUTS,
) -> LaneVector:
    """:func:`lane_vector` without needing a :class:`~wattsteer_ml.lanes.Lane`.

    The evaluation matrix's arms are (feature set, gate profile) pairs that have
    no threshold and therefore are not lanes; they still need the census, and
    inventing a threshold to obtain it would put a number in a card that no arm
    was run at.
    """
    admitted: list[str] = []
    withheld: list[WithheldAttribute] = []
    for item in inputs.inputs_for(feature_set):
        if _available_at(item, gate_profile):
            admitted.append(item.column_name)
        else:
            withheld.append(
                WithheldAttribute(
                    column_name=item.column_name,
                    class_label=item.class_label,
                    reason=_reason(item),
                )
            )
    return LaneVector(
        feature_set=feature_set,
        gate_profile=gate_profile,
        admitted=tuple(admitted),
        withheld=tuple(withheld),
    )


def assert_nothing_withheld_was_seen(
    lane: Lane,
    null_rates: Mapping[str, float],
    *,
    inputs: ModelInputs = MODEL_INPUTS,
) -> tuple[str, ...]:
    """Refuse a lane whose withheld attributes carry values. Returns the names.

    ``null_rates`` is :func:`wattsteer_ml.evaluation.gate.null_rates`' output —
    the share of NULLs per feature column over a set of rows. A withheld
    attribute must be NULL in **every** row of that set; one value in one row is
    enough, because the question is not "how much" but "at all".

    Returns the withheld names it checked, so a caller can record that the check
    ran over something rather than over an empty intersection. A withheld name
    the rate table does not mention is skipped rather than assumed present: the
    fixtures the tests train on mirror part of the composite type, and a check
    that raised on a column the rows do not carry would be asserting a fact
    about the migration tree from inside a unit test.
    """
    vector = lane_vector(lane, inputs=inputs)
    checked = tuple(name for name in vector.withheld_names if name in null_rates)
    seen = tuple(name for name in checked if null_rates[name] < 1.0)
    if seen:
        raise WithheldAtGateError(lane, seen)
    return checked


@dataclass(frozen=True)
class LaneContrast:
    """The two lanes, held together — with what makes them incomparable.

    The only shape in this service that carries both the morning and the evening
    view at once, and it cannot be built without both censuses. ``qloss_mwh`` is
    not on it: the gate's first check already refuses a swap across lanes, and
    the remaining risk is a human reading two numbers off one table. Whatever
    prints those two numbers prints this beside them.
    """

    early: LaneVector
    late: LaneVector

    def __post_init__(self) -> None:
        if self.early.gate_profile == self.late.gate_profile:
            raise AdmissibilityError(
                f"a lane contrast is between two gate profiles; both of these "
                f"are {self.early.gate_profile}"
            )
        if self.early.gate_profile != EARLY_GATE:
            raise AdmissibilityError(
                f"the early side of a contrast is {EARLY_GATE}, not "
                f"{self.early.gate_profile}"
            )

    @property
    def withheld_from_early(self) -> tuple[str, ...]:
        """Attributes the evening view has and the morning view does not."""
        return tuple(
            name for name in self.late.admitted if name in set(self.early.withheld_names)
        )

    @property
    def same_experiment(self) -> bool:
        """Always false while anything is withheld — which is always.

        A property rather than a constant so that the day the programme's
        publication instant is measured to fall before 09:00, this answers
        differently on its own instead of needing somebody to remember.
        """
        return not self.withheld_from_early

    def as_dict(self) -> dict[str, Any]:
        return {
            "early": self.early.card_fields(),
            "late": self.late.card_fields(),
            "withheld_from_early": list(self.withheld_from_early),
            "same_experiment": self.same_experiment,
            "note": CROSS_GATE_DIFFERENCE_IS_NOT_QUALITY.filled(
                feature_set=self.early.feature_set
            ),
        }


def _available_at(item: ModelInput, gate_profile: str) -> bool:
    """Whether one input exists at one gate.

    The dictionary answers the early-gate question and only that one; every
    input is available at ``gate_late``, which is what makes it the profile the
    A/B is run at. An unknown profile is refused rather than defaulted, on the
    same terms ``gate_at`` refuses one in SQL: a gate nobody defined has no
    availability, and guessing the permissive answer would admit everything.
    """
    if gate_profile == LATE_GATE:
        return True
    if gate_profile == EARLY_GATE:
        return item.available_at_gate_early
    raise AdmissibilityError(
        f"{gate_profile!r} is not a gate profile; the feature dictionary "
        f"describes availability at {EARLY_GATE!r} and {LATE_GATE!r}"
    )


def _reason(item: ModelInput) -> WithheldReason:
    return "structural" if DESSEM_CLASS in item.classes else "publication_lag"
