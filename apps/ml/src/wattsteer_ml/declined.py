"""Every figure this service declines to state, assembled from the constants.

The discipline of refusing to publish a number rather than fabricating one has
held throughout this repository, and it has produced a growing set of *named*
absences: :data:`~wattsteer_ml.evaluation.lead_time.ARCHIVE_FEATURES_HAVE_NO_SHAPE`,
:data:`~wattsteer_ml.evaluation.dessem_ab.NOT_RUN_YET`,
:data:`~wattsteer_ml.training.conformal.MARGINAL_COVERAGE_NOT_RUN_YET` and the
rest. Each of them is honest where it stands. Collectively they were scattered
across cards, blocks and wire fields, so nobody could answer the obvious
question — *what does this system decline to tell me, and why* — in one look.
The value of refusing to fabricate is only realised if the refusals are
findable.

## Assembled, and not transcribed

**There is no list in this module.** A roll of named absences would go stale the
first time somebody added one, which is the failure this repository has already
had twice — three artefacts claiming three different row counts, and a "does not
exist yet" comment repeated in five places after the thing existed. So a reason
constant *is* its own registry entry: :class:`DeclinedFigure` subclasses
:class:`str`, so the sentence a card already carries is the same object the
census reads, and :func:`declined_figures` finds it by walking this package.

Declaring one anywhere under ``wattsteer_ml`` is the whole of the work. Nothing
imports it, nothing registers it, and nothing here has to be told about it;
``apps/ml/tests/test_declined_figures.py`` demonstrates that rather than
asserting it in prose, and reconciles the walk against a source scan so that a
constant the walk cannot see is a failure instead of a silent omission.

## Why a ``str`` subclass rather than a table beside the constants

Because the alternative is two things to keep in step. ``admissibility.py``'s
``WITHHELD_REASONS`` is an identity-to-sentence map and works there because the
identity is a closed ``Literal`` the type checker enumerates; a named absence
has no such enumeration — its identity is the constant's own name. A table
keyed by that name would be a list, and a reason with no row in it would be
invisible in exactly the way this ticket exists to fix.

Subclassing ``str`` also means **no call site moved.** ``block["reason"] ==
NOT_RUN_YET`` still holds, ``MARGINAL_COVERAGE_NOT_RUN_YET in claim_note`` still
holds, and ``json.dumps`` still writes the sentence. The census is additional
information on a value that already existed, which is the only shape of change
that could be made to seven constants at once without touching what reads them.

## Two kinds, and they are two on purpose

:data:`DECLINE_KINDS` has two members and must keep having two.
``ARCHIVE_FEATURES_HAVE_NO_SHAPE`` says a thing **cannot be built**;
``NOT_RUN_YET`` was chosen by forecaster 18 specifically so that it would *not*
read like that, and forecaster 24's ``MARGINAL_COVERAGE_NOT_RUN_YET`` follows
18. Rounding the two into one "unavailable" bucket would destroy the
information the last several tickets were written to create, so the kind is a
required keyword on every declaration: a new reason cannot be added without
choosing, and cannot be added nameless.

## What is *not* here

The eighth named absence is ``band_unavailable_reason: "no_joint_ensemble"``,
and it is not declared here because it is not produced here. This service
publishes ``Publication.national = None``; the identity is a ``packages/core``
schema enum and the sentence is the gateway's, so it is declared beside the
enum in ``packages/core/src/declines.ts`` and merged onto ``GET /v1/meta``
there. Spelling it in both languages is what a golden vector is for, and it
would still be two spellings of one fact.

Nor is there a figure anywhere on this surface. A census of withheld
measurements is the last place that could afford to carry a number a reader
might take for one, so every field of every entry is prose.
"""

from __future__ import annotations

import importlib
import pkgutil
from collections.abc import Iterator
from types import ModuleType
from typing import Any, Literal

#: Whether a figure **cannot** be produced or merely **has not** been.
#:
#: Two members, and the reason they are two is the whole of this module's
#: contribution to the vocabulary: see the note above. A third bucket that
#: covered both would be a rounding of the distinction, not an addition to it.
DeclineKind = Literal["unrunnable", "unrun"]

#: The two, as data — so that the runtime check in :class:`DeclinedFigure` can
#: refuse a third without ``warn_unreachable`` calling the check dead code.
DECLINE_KINDS: tuple[str, ...] = ("unrunnable", "unrun")


class DeclinedFigure(str):
    """A withheld figure's reason sentence, which is also its census entry.

    A ``str``, so every card field, equality check and substring test that
    already reads one of these keeps working unchanged. The three keyword
    arguments are what the sentence alone could not say:

    - :attr:`figure` — *which* number is not stated. A reason sentence explains
      an absence; it does not name the thing absent, and a census whose rows do
      not name the quantity is a census of prose.
    - :attr:`kind` — ``unrunnable`` or ``unrun``, never defaulted.
    - :attr:`surface` — where a caller actually meets the absence, so that the
      census is a way *into* the artefact rather than a restatement of it.
    """

    #: Which figure is withheld, as a noun phrase.
    figure: str
    #: ``unrunnable`` or ``unrun``.
    kind: DeclineKind
    #: The card block, wire field or response this absence is met on.
    surface: str

    def __new__(
        cls,
        reason: str,
        *,
        figure: str,
        kind: DeclineKind,
        surface: str,
    ) -> DeclinedFigure:
        if kind not in DECLINE_KINDS:
            raise ValueError(
                f"{kind!r} is neither unrunnable nor unrun. A figure that "
                "cannot be produced and a figure nobody has produced yet are "
                "two different statements about this system, and a reason that "
                "declined to choose would be published as one of them anyway."
            )
        for name, value in (("figure", figure), ("surface", surface)):
            if value.strip() == "":
                raise ValueError(
                    f"A declined figure with no {name} cannot be read: the "
                    "census exists so that a reader can find what is missing "
                    "and where they would have met it."
                )
        if reason.strip() == "":
            raise ValueError(
                "A named absence with no reason is an omission wearing a name."
            )
        declined = str.__new__(cls, reason)
        declined.figure = figure
        declined.kind = kind
        declined.surface = surface
        return declined

    def as_entry(self, *, name: str, declared_in: str) -> dict[str, Any]:
        """One census row. The name and the module come from the walk."""
        return {
            "name": name,
            "declared_in": declared_in,
            "figure": self.figure,
            "kind": self.kind,
            "reason": str(self),
            "surface": self.surface,
        }


def _raise(name: str) -> None:
    """A module in this package that will not import is a defect, not a gap.

    ``pkgutil`` swallows import errors by default, which on this walk would
    mean a broken module quietly removing its absences from the census — the
    surface reporting *less* withheld than there is, which is the one direction
    it may never be wrong in.
    """
    raise ImportError(f"{name} could not be imported while taking the census")


def package_modules() -> Iterator[ModuleType]:
    """This package and every module under it, imported.

    Public because :mod:`wattsteer_ml.caveated` — the mirror census, of figures
    that *are* published and mean something other than what their name says —
    walks the same package. Two censuses, one walk: one place imports
    ``pkgutil`` and one definition says what "this package" is, so the two
    cannot come to disagree about which modules exist.
    """
    package = importlib.import_module("wattsteer_ml")
    yield package
    for found in pkgutil.walk_packages(
        package.__path__,
        prefix="wattsteer_ml.",
        onerror=_raise,
    ):
        yield importlib.import_module(found.name)


def is_package(module: ModuleType) -> bool:
    """Whether a module is a package, so a re-export loses to a declaration."""
    return hasattr(module, "__path__")


def declined_figures() -> tuple[dict[str, Any], ...]:
    """Every figure this service declines to state, in name order.

    The walk reaches the same constant more than once whenever a package
    re-exports it, so the declaration site is resolved rather than picked: a
    module that is not a package wins over one that is — a re-export lives in
    an ``__init__``, the declaration does not — and ties break alphabetically,
    so the census is byte-stable across processes.
    """
    found: dict[int, tuple[bool, str, str, DeclinedFigure]] = {}
    for module in package_modules():
        origin = (is_package(module), module.__name__)
        for name, value in list(vars(module).items()):
            if not isinstance(value, DeclinedFigure):
                continue
            seen = found.get(id(value))
            if seen is not None and (seen[0], seen[2]) <= origin:
                continue
            found[id(value)] = (origin[0], name, origin[1], value)
    return tuple(
        sorted(
            (
                value.as_entry(
                    name=name,
                    declared_in=f"apps/ml/src/{module.replace('.', '/')}.py",
                )
                for _, name, module, value in found.values()
            ),
            key=lambda entry: str(entry["name"]),
        )
    )
