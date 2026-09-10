"""The generated model-input artifact, read whole.

`apps/api/src/features/model-inputs-artifact.ts` serialises
``feature_set_model_inputs(feature_set)`` — which derives its names from
``pg_attribute`` on the ``feature_row`` composite type — into
``diagnosis/model_inputs.json``. That file is the Python side's only statement
of what a feature set contains, and nobody types a feature name into it.

**Why this module exists beside the one that already reads that file.**
:func:`wattsteer_ml.driver_groups.load_model_inputs` wanted the names
and nothing else, so it threw away the four other columns the SQL function
returns. One of them —``available_at_gate_early`` — is the whole of forecaster
ticket 19: it is the database's own statement of which attributes exist at
``gate_early`` and which do not, and the Python side had no way to ask. Rather
than add a second reader with a second provenance check, the read lands here
once and ``load_model_inputs`` narrows this module's answer to the names.

**The provenance is checked, not assumed.** An artifact that does not name the
generator and the SQL function it came from is refused. The one property that
makes this file different from the hand-transcribed ``ordered_features.yaml``
it replaced is that no human typed a feature name into it — and a file claiming
nothing about itself is exactly what a hand-edited one would look like.

**Order is the composite type's, and nothing reorders it.** The inputs arrive in
attribute order, which is the order ``feature_hash`` is taken in
(:mod:`wattsteer_ml.training.contract`). Sorting them here would make the
artifact and the hash describe two different vectors.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

#: The generated artifact, beside the module that first needed it. Kept where it
#: is: `apps/api/src/features/model-inputs-artifact.ts` writes to that path, and
#: moving the file would mean editing the generator to chase it.
MODEL_INPUTS_PATH = Path(__file__).parent / "diagnosis" / "model_inputs.json"

#: What the artifact must say about itself, or :func:`load_model_inputs` refuses
#: it.
MODEL_INPUTS_GENERATOR = "apps/api/src/features/model-inputs-artifact.ts"
MODEL_INPUTS_SOURCE = "feature_set_model_inputs(feature_set)"

#: Hourly, or one value broadcast across the 24 hours of the target date.
#: ``None`` for ``subsystem`` — the one identity column that is also a model
#: input, and the one the dictionary does not ask the grain question about.
Grain = Literal["hour", "day"]


class ModelInputsError(ValueError):
    """The artifact on disk is not the artifact this module reads.

    Raised at load, never at serve time. A malformed model-input list is a
    build fault: every caller of this module is answering "what is this lane
    bound to", and guessing is the one answer that is worse than none.
    """


@dataclass(frozen=True)
class ModelInput:
    """One ordered model input of one feature set."""

    #: 1-based position within this set, in the composite type's own order.
    input_index: int
    column_name: str
    #: ``W``, ``P``, ``D``, ``K``, ``T``, ``P+W+T``, ``identity`` — the feature
    #: spec's own notation, joined by ``+`` when a column has more than one.
    class_label: str
    grain: Grain | None
    #: The database's statement, not this module's: ``false`` for every
    #: ``dessem_*``, ``programmed_*`` and ``proxy_*`` column. The two reasons
    #: behind it differ and :mod:`wattsteer_ml.admissibility` is where they are
    #: told apart.
    available_at_gate_early: bool

    @property
    def classes(self) -> tuple[str, ...]:
        """The class label split back into its members."""
        return tuple(part for part in self.class_label.split("+") if part)


@dataclass(frozen=True)
class ModelInputs:
    """Every feature set the artifact describes, in attribute order."""

    #: How many attributes the ``feature_row`` composite type carries. Not the
    #: number of model inputs: stamps and ``y_*`` labels are attributes too.
    feature_row_attributes: int
    sets: Mapping[str, tuple[ModelInput, ...]]

    def __post_init__(self) -> None:
        if not self.sets:
            raise ModelInputsError("no feature set is described")

    def inputs_for(self, feature_set: str) -> tuple[ModelInput, ...]:
        """The ordered inputs of one set, or say which sets exist.

        Raises rather than returning an empty tuple: "this set has no inputs"
        and "this artifact has never heard of that set" are different sentences,
        and only one of them is a typo in a lane name.
        """
        try:
            return self.sets[feature_set]
        except KeyError:
            raise ModelInputsError(
                f"{feature_set!r} is not a feature set the model-input artifact "
                f"describes; it knows {sorted(self.sets)}"
            ) from None

    def names_by_set(self) -> dict[str, tuple[str, ...]]:
        """Just the ordered names — what the driver-group partition reads."""
        return {
            name: tuple(item.column_name for item in inputs)
            for name, inputs in self.sets.items()
        }


def load_model_inputs(path: Path = MODEL_INPUTS_PATH) -> ModelInputs:
    """Read the generated artifact, provenance first."""
    where = str(path)
    try:
        loaded: object = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:  # pragma: no cover - a corrupt artifact
        raise ModelInputsError(f"{where}: not JSON: {error}") from error
    document = _mapping(loaded, where)

    generated_by = _text(document.get("generated_by"), f"{where}: generated_by")
    source = _text(document.get("source"), f"{where}: source")
    if generated_by != MODEL_INPUTS_GENERATOR or source != MODEL_INPUTS_SOURCE:
        raise ModelInputsError(
            f"{where}: this file must be generated by {MODEL_INPUTS_GENERATOR!r} "
            f"from {MODEL_INPUTS_SOURCE!r}, and says {generated_by!r} / "
            f"{source!r}. Regenerate it with `bun run --cwd apps/api "
            "features:snapshot`; do not write feature names into it by hand — a "
            "hand-written list is what this artifact replaced."
        )
    attributes = _whole(
        document.get("feature_row_attributes"), f"{where}: feature_row_attributes"
    )

    sets: dict[str, tuple[ModelInput, ...]] = {}
    for name, raw in _mapping(document.get("sets"), f"{where}: sets").items():
        entries = _sequence(raw, f"{where}: sets.{name}")
        if not entries:
            raise ModelInputsError(f"{where}: sets.{name} lists no model inputs")
        sets[name] = tuple(
            _input(_mapping(entry, f"{where}: sets.{name}[]"), f"{where}: sets.{name}")
            for entry in entries
        )
    try:
        return ModelInputs(feature_row_attributes=attributes, sets=sets)
    except ModelInputsError as error:
        raise ModelInputsError(f"{where}: {error}") from error


def _input(raw: Mapping[str, Any], where: str) -> ModelInput:
    grain = raw.get("grain")
    if grain is not None and grain not in ("hour", "day"):
        raise ModelInputsError(
            f"{where}[].grain is {grain!r}; a model input is hourly, day grain, "
            "or the one identity column the question is not asked about"
        )
    return ModelInput(
        input_index=_whole(raw.get("input_index"), f"{where}[].input_index"),
        column_name=_text(raw.get("column_name"), f"{where}[].column_name"),
        class_label=_text(raw.get("class_label"), f"{where}[].class_label"),
        grain=grain,
        available_at_gate_early=_flag(
            raw.get("available_at_gate_early"),
            f"{where}[].available_at_gate_early",
        ),
    )


def _mapping(value: object, where: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ModelInputsError(f"{where} is not a JSON object")
    mapping: dict[str, Any] = value
    return mapping


def _sequence(value: object, where: str) -> tuple[object, ...]:
    if not isinstance(value, list):
        raise ModelInputsError(f"{where} is not a JSON array")
    items: list[object] = value
    return tuple(items)


def _text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ModelInputsError(f"{where} is not a non-empty string")
    return value


def _whole(value: object, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ModelInputsError(f"{where} is not a positive integer")
    return value


def _flag(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise ModelInputsError(f"{where} is not a boolean")
    return value


#: The artifact, read once. The card, the matrix and the gate all ask it the
#: same question, and none of them should pay for a second file read to do it.
MODEL_INPUTS = load_model_inputs()
