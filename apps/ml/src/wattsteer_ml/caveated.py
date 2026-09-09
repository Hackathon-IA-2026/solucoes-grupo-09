"""Every figure this service publishes that does not mean what its name says.

:mod:`wattsteer_ml.declined` is the census of *absences*, and forecaster 25
built it while naming the family its two kinds do not cover:

    The ``_NOT_A_READING`` family ("THESE DELTAS ARE NOT A MEASUREMENT OF THE
    GRID") is neither unrunnable nor unrun — the figure **is** published and
    means nothing.

That is the sharper risk, and this module is its mirror. An absent figure
cannot mislead anybody: a reader who wanted it is told why it is not there. A
*present* figure carrying a caveat nobody reads is a number that will be
quoted. ``coverage_p10 = 1.0`` is the case that proves it — real arithmetic,
computed over **zero** rows on which the served floor was a positive number,
read for months as evidence that the floor was perfect. Nobody was lying. The
caveat simply was not attached to the number.

## The rule, so that the next one is found rather than remembered

Write the sentence a reader takes away from the published pair — *name* is
*value*. A figure is **caveated** when that sentence is false, or is true of
something other than what the name denotes, and only a sentence published
beside it makes it true.

Narrower than "worth a footnote", on purpose, because a census that swept in
every note beside every number would be a second copy of the cards. Three
kinds of sentence sit next to figures in this repository and are **not**
caveats by this rule:

- a **definition** (``_READS``) — it says what the figure was counted over in
  the case where the figure is what it says. The take-away was already true.
- an **absence** (``_NOTHING_YET``) — there is no published value to misread,
  and it is forecaster 25's census that answers for it.
- a statement about **authority** (``_DECIDES_NOTHING``) or about **precision**
  (``_SAMPLE_SIZE``) — nothing may be promoted off this block, and the sample
  is small. Both leave the take-away sentence true, merely weak or unactionable.

What is left arrives along three axes, and they are where to look rather than
what to list:

1. **the inputs are not the thing.** The arithmetic ran over fabricated rows,
   so the figure is a statement about a fixture — the ``_NOT_A_READING`` family,
   in six blocks.
2. **the support is not the thing.** The figure is counted over rows that
   cannot falsify it (``coverage_p10`` where no row states a lower bound), or
   is an identity restated (``share_p50_zero`` is ``share_p50_forced_zero``).
3. **the population or the parameter is not the one the name carries.** The
   figure moves with something its name does not mention, so it is not the same
   quantity as the same-named figure beside it — :data:`COMPARABILITY
   <wattsteer_ml.evaluation.threshold_sweep.COMPARABILITY>` across three
   thresholds, ``_REVISION_OPTIMISTIC_ONLY`` across a label revision,
   ``nominal_claim`` on a band labelled ``P10-P90``.

## Assembled, and not transcribed

**There is no list in this module**, for the reason
:mod:`wattsteer_ml.declined` gives and one more: a caveat list rots *faster*
than an absence list, because a caveat attaches to a number people actively
use. An absence nobody maintains stays absent; a figure whose caveat has gone
stale keeps being read.

So a caveat sentence *is* its own census entry. :class:`CaveatedFigure`
subclasses :class:`str`, so the sentence a card already carries is the object
:func:`caveated_figures` reads, found by walking this package.
``apps/ml/tests/test_caveated_figures.py`` demonstrates that rather than
asserting it in prose, and reconciles the walk against a source scan so that a
construction the walk cannot see is a failure instead of a silent omission.

**No call site moved, and that is the hard constraint of the ticket.** Several
of these are load-bearing where they stand:
:data:`~wattsteer_ml.training.conformal.NOT_A_NINETY_PERCENT_BAND` already says
a band "must not be described as" a 90% band, ``COMPARABILITY`` is what stops
five of six sweep figures being read across the arms, and the
``_NOT_A_READING`` prose is what a reader of a fabricated block meets first.
Collecting them may not relocate any of them, and subclassing :class:`str` is
what makes that possible: ``dict(COMPARABILITY)`` still copies,
``" ".join((..., NOT_A_NINETY_PERCENT_BAND, ...))`` still joins, and
``json.dumps`` still writes the sentence.

## Two censuses, and the ``kind`` binary gained no third member

:data:`~wattsteer_ml.declined.DECLINE_KINDS` has two members and still has two.
The temptation is to add ``published_but_meaningless`` and be done, and it is
the wrong change twice over.

``unrunnable`` and ``unrun`` are two answers to **one** question — *does this
figure exist?* A caveated figure answers *yes* to that question and then a
different one, about what the number it published is a statement about. A kind
that answered both would be answering "no, and also yes".

Worse, it would put a *present* number under a heading whose entire contract is
absence. ``/v1/meta``'s ``declines`` block exists so that a reviewer can read
what this deployment refuses to claim; a reviewer who found ``coverage_p10``
there would conclude it was withheld, when the whole defect is that it is not.
So the two censuses are separate objects, served side by side, and
``test_caveated_figures.py`` asserts they stay disjoint.

They do share the walk — :func:`~wattsteer_ml.declined.package_modules` is
imported rather than restated, so there is one place that imports ``pkgutil``
and one definition of what "this package" means.

## Where a caveat is met, and why it is in two places

Both, and they are not alternatives.

**Attached**, because that is the only thing that helps the code path that
reads the figure. ``share_p50_zero`` is the case: the optimizer's posture
question is what it exists for, and a caveat on ``/v1/meta`` does nothing at
all for a consumer holding a metrics row. So each of these is published in the
same block as the figure it qualifies — where it already was, for the ones that
already were, and beside the number for the four this ticket adds.

**Collected**, because attachment is unfindable. A reviewer deciding whether to
trust this system cannot read every card block to discover which of its
published numbers do not mean what they say, and that is exactly the question
``/v1/meta`` already answers for absences. The two are the *same objects*, so
there is nothing to keep in step.

Nor is there a figure anywhere on this surface. A census of numbers that mean
something other than what they say is the last place that could afford to carry
one, so every field of every entry is prose.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from types import ModuleType
from typing import Any

from wattsteer_ml.declined import DeclinedFigure, is_package, package_modules


class CaveatedFigure(str):
    """A caveat sentence, which is also its census entry.

    A ``str``, so every card field, ``dict`` copy, ``" ".join`` and
    ``json.dumps`` that already carries one of these keeps working unchanged.
    The three keyword arguments are what the sentence alone could not say:

    - :attr:`figure` — *which* published number this changes the meaning of. A
      caveat explains a misreading; it does not always name the quantity being
      misread, and a census whose rows do not name the figure is a census of
      prose.
    - :attr:`misreading` — **the sentence this caveat exists to make false**:
      what the number reads as if a reader takes the name and the value and
      nothing else. Required, and it is the forced choice of this census the
      way ``kind`` is forced in :class:`~wattsteer_ml.declined.DeclinedFigure`.
      An author who cannot write down what the figure would be quoted as has
      not decided whether it is misleading, and the caveat they wrote is
      decoration.
    - :attr:`surface` — the block, field or response where a consumer meets the
      figure *and* this sentence, so that the census is a way into the artefact
      rather than a restatement of it.
    """

    #: Which published figure this changes the meaning of, as a noun phrase.
    figure: str
    #: What the figure reads as without this sentence. False, and published.
    misreading: str
    #: The card block, wire field or response the figure and this are met on.
    surface: str

    def __new__(
        cls,
        caveat: str,
        *,
        figure: str,
        misreading: str,
        surface: str,
    ) -> CaveatedFigure:
        if isinstance(caveat, DeclinedFigure):
            raise ValueError(
                "A named absence is not a caveat. "
                f"{str(caveat)[:60]!r} explains why a figure is not stated; a "
                "caveat explains why a figure that *is* stated means something "
                "other than its name. Republishing one as the other would file "
                "a published number in a census whose contract is absence, "
                "which is the reading forecaster 25 kept its two kinds apart "
                "to prevent."
            )
        for name, value in (
            ("figure", figure),
            ("misreading", misreading),
            ("surface", surface),
        ):
            if value.strip() == "":
                raise ValueError(
                    f"A caveat with no {name} cannot be read: this census "
                    "exists so that a reader can find which published numbers "
                    "do not mean what they say, what they would be quoted as, "
                    "and where they would have met them."
                )
        if caveat.strip() == "":
            raise ValueError(
                "A caveated figure with no caveat is a figure that misleads."
            )
        if misreading.strip() == caveat.strip():
            raise ValueError(
                "The misreading is the caveat restated. It is meant to be the "
                "sentence this caveat makes false — what the number reads as "
                "with the name and the value and nothing else — and copying "
                "the correction into it skips the only decision this field "
                "asks for."
            )
        caveated = str.__new__(cls, caveat)
        caveated.figure = figure
        caveated.misreading = misreading
        caveated.surface = surface
        return caveated

    def filled(self, **values: object) -> CaveatedFigure:
        """This caveat with its placeholders substituted, still a caveat.

        A few of these name something only the block knows —
        :data:`~wattsteer_ml.admissibility.CROSS_GATE_DIFFERENCE_IS_NOT_QUALITY`
        names the feature set whose two gate scores are being compared, and
        that name appears nowhere else in its block, so dropping it to make the
        sentence a constant would cost a consumer information. ``str.format``
        alone would cost the *census* the entry instead, by returning a plain
        :class:`str`; this returns a :class:`CaveatedFigure` carrying the same
        three fields, so the published field is still one of these and the
        module-level template is still what the walk finds and reports.
        """
        return CaveatedFigure(
            str.format(self, **values),
            figure=self.figure,
            misreading=self.misreading,
            surface=self.surface,
        )

    def as_entry(self, *, name: str, declared_in: str) -> dict[str, Any]:
        """One census row. The name and the module come from the walk."""
        return {
            "name": name,
            "declared_in": declared_in,
            "figure": self.figure,
            "caveat": str(self),
            "misreading": self.misreading,
            "surface": self.surface,
        }


def _named_in(module: ModuleType) -> list[tuple[str, CaveatedFigure]]:
    """Every caveat a module holds, under the name a reader would grep for.

    A module attribute answers to its own name. A caveat declared as the value
    of a module-level mapping or sequence answers to the subscript —
    ``COMPARABILITY["pr_auc"]`` — because that map is *published* as one
    figure-to-sentence table and splitting it into six constants so that a
    scan could anchor on them would be a worse module for the sake of a regex.

    One level deep, and no further. A caveat nested inside a structure inside a
    structure is not something a reader would find by grepping for a name, and
    the source scan in ``test_caveated_figures.py`` is what turns an
    unreachable declaration into a failure rather than an omission.
    """
    found: list[tuple[str, CaveatedFigure]] = []
    for name, value in list(vars(module).items()):
        if isinstance(value, CaveatedFigure):
            found.append((name, value))
        elif isinstance(value, Mapping):
            found.extend(
                # Double-quoted, because the subscript is meant to be the grep
                # and the source it is a grep for is a dict literal.
                (f'{name}["{key}"]' if isinstance(key, str) else f"{name}[{key!r}]", item)
                for key, item in value.items()
                if isinstance(item, CaveatedFigure)
            )
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            found.extend(
                (f"{name}[{index}]", item)
                for index, item in enumerate(value)
                if isinstance(item, CaveatedFigure)
            )
    return found


def caveated_figures() -> tuple[dict[str, Any], ...]:
    """Every caveated figure this service publishes, in declaration order.

    Sorted by ``(declared_in, name)`` and **not by name alone**, which is the
    one place this census's shape differs from
    :func:`~wattsteer_ml.declined.declined_figures`. Six modules declare a
    ``_NOT_A_READING``: six blocks are each arithmetic over their own
    fabricated inputs, each naming its own figures, and renaming them apart so
    that a bare string could be an identity would invent six distinctions where
    there is one recurring defect. The pair is the identity, and it is also the
    grep.

    The walk reaches the same object more than once whenever a package
    re-exports it, so the declaration site is resolved rather than picked, on
    :func:`~wattsteer_ml.declined.declined_figures`' rule: a module that is not
    a package wins over one that is, and ties break alphabetically, so the
    census is byte-stable across processes.
    """
    found: dict[int, tuple[bool, str, str, CaveatedFigure]] = {}
    for module in package_modules():
        origin = (is_package(module), module.__name__)
        for name, value in _named_in(module):
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
            key=lambda entry: (str(entry["declared_in"]), str(entry["name"])),
        )
    )


__all__ = ["CaveatedFigure", "caveated_figures"]
