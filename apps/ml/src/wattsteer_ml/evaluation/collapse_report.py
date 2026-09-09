"""The ticket-011 block as a published figure — and what produced it, stamped.

:mod:`~wattsteer_ml.evaluation.collapse` counts the six figures. This module is
what turns them into **the number the flex-optimizer spec is owed**: the rows
gathered per fold segment and per subsystem, stamped with the
`VintageFidelity` of the fold behind them, and — the part that is not
bookkeeping — stamped with **where the hours came from**.

`docs/specs/flex-optimizer.md`, "The uncertainty posture — decided", plans on
P50 and promises the P10 edge. `docs/specs/forecaster.md` shows that
``Q_Y(q) = 0`` for every ``q ≤ 1 − p``, so a P50-planned dispatch sees zero
offered energy in every hour more likely than not to be quiet, and closes with
"that number is the deliverable this spec owes ticket 011". A large
``share_of_days_with_no_non_zero_p50_hour`` reopens the posture. Which means the
number carries a decision, and **a number that carries a decision has to say
what it is a measurement of.**

## ``collapse_source``, and why it exists

`diagnosis/background.py` stamps ``background_source`` — ``artifact`` or
``base_fit`` — and `training/conformal.py` stamps ``correction_regime``, so a
stored row names the rule that produced it rather than leaving a reader to infer
it from context that does not travel with the row. This module does the same
thing for the collapse, because the failure it prevents is specific and cheap to
hit: the six figures are computable from *any* set of bands, including the
fabricated ones this repository's fixtures are full of, and a fixture-derived
``share_of_days_with_no_non_zero_p50_hour`` is a plausible-looking decimal that
reads exactly like a statement about the Brazilian grid.

So there are three values and they are not interchangeable:

- :data:`HOLDOUT_HOURS_SOURCE` — the hours were read out of
  ``canonical_forecast_hour``. Only this one is evidence about the grid.
- :data:`FIXTURE_SOURCE` — the hours were fabricated. The figures are arithmetic
  over invented probabilities and describe nothing.
- :data:`UNMEASURED_SOURCE` — there were no hours. Carried by
  :class:`UnmeasuredCollapse`, which has no figures at all rather than zeroes.

:attr:`CollapseProvenance.is_measurement` is the one predicate, and
:meth:`CollapseReport.card_block` writes ``measured`` from it beside every
figure, so a reader of the card cannot reach a number without reaching the
sentence that says what it is.

## Why the hours are read rather than re-composed

The population is the **out-of-fold** band — what the product would have shown
on a day it never saw — which `docs/specs/replay.md` already required be kept:
`evaluation/holdout.py` mints those days as ``backfilled_holdout``
publications and the gateway appends them. So the collapse over a fold is a
*read* of rows that already exist, and this module fits no model, draws no
ensemble and inverts no mixture. Recomposing them here would be a second
composition of the band the optimizer plans against, and
:func:`wattsteer_ml.mixture.compose` has one call site in this service on
purpose.

``origin_kind = 'backfilled_holdout'`` is therefore a **constant in the SQL
text** and not a parameter. A ``served`` row is a record of a day the product
published, drawn from whatever artifact was promoted at the time; pooling those
with a fold's held-out days would produce one share over two populations, and a
filter a caller can widen is not a population.

## What this module does not do

It does not decide. There is no threshold here, no verdict field and no
"collapsed" boolean — the ticket says the block is evidence and ticket 011
decides — and there is deliberately nothing to tune into the answer somebody
wanted.

It also never pools across fold segments. Shares over two segments would have to
be re-counted over the union of their hours, and the union of a
``revision_optimistic`` quarter with a ``point_in_time`` one is the row
`docs/specs/forecaster.md` forbids;
:func:`~wattsteer_ml.evaluation.vintage.assert_no_averaged_rows` runs on
construction so a report that lost half a split fold cannot be published.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

import asyncpg

from wattsteer_ml.artifacts import CARD_SUFFIX
from wattsteer_ml.canonical import VintageFidelity
from wattsteer_ml.canonical_reads import ReadAxes, apply_axes
from wattsteer_ml.caveated import CaveatedFigure
from wattsteer_ml.constants import SUBSYSTEM_CODES, Subsystem
from wattsteer_ml.evaluation.collapse import CollapseBlock
from wattsteer_ml.evaluation.matrix import RowKey
from wattsteer_ml.evaluation.vintage import FoldSegment, assert_no_averaged_rows
from wattsteer_ml.lanes import Lane
from wattsteer_ml.mixture import QuantileBand
from wattsteer_ml.training.bundle import read_card, write_card

#: The card block ticket 011 reads. Named for the figure and not for the
#: harness that produced it: nothing in the key says "fold", "ladder" or
#: "backtest", because the optimizer work reads this without knowing any of them.
COLLAPSE_BLOCK_KEY = "p50_collapse_report"

#: :attr:`CollapseProvenance.collapse_source` when the bands were read out of
#: Postgres. **The only value that makes the block evidence about the grid.**
HOLDOUT_HOURS_SOURCE = "canonical_forecast_hour"

#: When the bands were fabricated. Every fixture in this repository produces
#: this, and :meth:`CollapseReport.card_block` says so in the block itself.
FIXTURE_SOURCE = "fixture"

#: When there were no bands at all. :class:`UnmeasuredCollapse` carries it, and
#: carries no figures.
UNMEASURED_SOURCE = "unmeasured"

#: The origin kind the measurement is over. Spelt here rather than imported from
#: `publication.py`, which imports `training` and would drag LightGBM into a
#: report that fits nothing and reads rows. A duplicated contract constant is a
#: thing that drifts, so `tests/test_p50_collapse_report.py` pins this one to
#: :data:`wattsteer_ml.publication.BACKFILLED_HOLDOUT_ORIGIN_KIND` and to the
#: literal in :data:`HOLDOUT_HOURS_SQL`.
HOLDOUT_ORIGIN_KIND = "backfilled_holdout"

#: One fold segment's held-out bands for one lane, in day order.
#:
#: ``origin_kind`` is a constant in this text and ``local_hour`` is selected
#: rather than derived: the writer resolved the civil hour against
#: ``America/Sao_Paulo`` when the row was minted, and deriving it a second time
#: here would be a second timezone opinion about the same instant.
#:
#: The lane travels as three bound arguments because a band is only comparable
#: with another band of the same ``threshold_mw`` (`docs/domain-model.md` §8.3),
#: and because two feature sets are two models. Nothing in this statement can
#: select a quantile: all three are returned, and the two the figures need are
#: the two the composition makes zero.
HOLDOUT_HOURS_SQL = """
select
  subsystem::text as subsystem,
  target_date,
  local_hour,
  occurrence_probability,
  p10_mwh,
  p50_mwh,
  p90_mwh,
  run_label,
  feature_set,
  gate_profile::text as gate_profile,
  threshold_mw
from canonical_forecast_hour
where target_date between $1::date and $2::date
  and origin_kind = 'backfilled_holdout'::forecast_origin_kind
  and feature_set = $3
  and gate_profile = $4::forecast_gate_profile
  and threshold_mw = $5::double precision
order by target_date, subsystem, local_hour
"""


class CollapseReportError(ValueError):
    """The rows cannot support the report that was asked for."""


@dataclass(frozen=True)
class PublishedBand:
    """``p`` and the P10/P50/P90 of one stored row.

    :class:`~wattsteer_ml.mixture.QuantileBand` rather than three floats, so the
    ordering the database's ``band_monotone`` check enforces is re-asserted on
    this side rather than assumed to have survived the crossing.
    """

    band: QuantileBand
    occurrence_probability: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.occurrence_probability <= 1.0:
            raise CollapseReportError(
                f"{self.occurrence_probability!r} is not a probability; a stored "
                "row that is out of range is a fault to stop on, not a figure to "
                "count"
            )


@dataclass(frozen=True)
class PublishedHour:
    """One persisted hour, narrowed to what a collapse is counted from.

    Satisfies :class:`~wattsteer_ml.evaluation.collapse.ServedHour` structurally.
    It holds no mixture, no expectation and no technology split — not because
    they are unavailable but because the collapse is a statement about ``p`` and
    the band, and a value that carried the rest would invite a second figure to
    be computed from a row that was only ever selected for this one.
    """

    key: RowKey
    forecast: PublishedBand


@dataclass(frozen=True)
class CollapseProvenance:
    """What produced the figures. Travels with them, always, and never optional.

    Constructed through :meth:`measured` or :meth:`fixture` rather than by
    field, so ``collapse_source`` cannot be set to
    :data:`HOLDOUT_HOURS_SOURCE` by a caller that did not read a row.
    """

    collapse_source: str
    #: The lane the bands belong to. Two lanes are two models, and their shares
    #: are not one share.
    lane: Lane
    #: ``canonical_as_of()`` the rows were resolved at. ``None`` for fixtures,
    #: which were resolved against nothing.
    as_of: datetime | None
    #: ``run_label`` as the stored rows carry it — which backtest run wrote
    #: them. ``None`` when the hours did not come from a row.
    run_label: str | None

    @property
    def is_measurement(self) -> bool:
        """Whether these figures are evidence about the grid. One predicate."""
        return self.collapse_source == HOLDOUT_HOURS_SOURCE

    @classmethod
    def measured(
        cls, *, lane: Lane, as_of: datetime, run_label: str
    ) -> CollapseProvenance:
        """The stamp for figures counted over rows read from Postgres."""
        return cls(
            collapse_source=HOLDOUT_HOURS_SOURCE,
            lane=lane,
            as_of=as_of,
            run_label=run_label,
        )

    @classmethod
    def fixture(cls, *, lane: Lane) -> CollapseProvenance:
        """The stamp for figures counted over fabricated bands.

        Named, rather than left to a default, because the default is the value
        that would do damage. Every test in this repository builds this one.
        """
        return cls(collapse_source=FIXTURE_SOURCE, lane=lane, as_of=None, run_label=None)

    def card_fields(self) -> dict[str, Any]:
        return {
            "measured": self.is_measurement,
            "collapse_source": self.collapse_source,
            "origin_kind": HOLDOUT_ORIGIN_KIND,
            "lane": self.lane.directory_name,
            "feature_set": self.lane.feature_set,
            "gate_profile": self.lane.gate_profile,
            "threshold_mw": self.lane.threshold_mw,
            "run_label": self.run_label,
            "as_of": None if self.as_of is None else self.as_of.isoformat(),
        }


@dataclass(frozen=True)
class CollapseSegmentRow:
    """One fold segment's block: the pooled figures and the four subsystems.

    The segment rather than a fold id, for the reason
    :class:`~wattsteer_ml.evaluation.metrics.MetricsRow` carries one: a figure
    that has lost its `VintageFidelity` is a figure whose caveat cannot be
    recovered, and this one carries a decision.
    """

    segment: FoldSegment
    block: CollapseBlock

    def card_entry(self) -> dict[str, Any]:
        return {
            "row_id": self.segment.row_id,
            "fold_id": self.segment.fold_id,
            "vintage_fidelity": self.segment.fidelity,
            "segment_hash": self.segment.segment_hash,
            "test_start": self.segment.test_start.isoformat(),
            "test_end": self.segment.test_end.isoformat(),
            **self.block.as_card_entry(),
        }


class ScoredRow(Protocol):
    """A metrics row, narrowed to the two fields this module reads.

    Structural, so :class:`~wattsteer_ml.evaluation.metrics.MetricsRow` satisfies
    it without this module importing the metrics table — the report is about six
    figures and a stamp, and it should not acquire an opinion about the other
    thirty columns a scored row happens to carry.
    """

    @property
    def segment(self) -> FoldSegment: ...

    @property
    def collapse(self) -> CollapseBlock | None: ...


@dataclass(frozen=True)
class CollapseReport:
    """The six figures per fold segment and per subsystem, and their provenance.

    Never pooled across segments, and never published without
    :attr:`provenance`. :meth:`card_block` is the whole published surface.
    """

    provenance: CollapseProvenance
    rows: tuple[CollapseSegmentRow, ...]

    def __post_init__(self) -> None:
        if not self.rows:
            raise CollapseReportError(
                "a collapse report with no fold segment; an absent measurement is "
                "UnmeasuredCollapse, which carries a reason instead of no rows"
            )
        seen = [row.segment.row_id for row in self.rows]
        if len(set(seen)) != len(seen):
            raise CollapseReportError(
                f"a fold segment is reported twice: {sorted(seen)!r}; one segment "
                "has one row, and a duplicate is a day counted twice"
            )
        assert_no_averaged_rows([row.segment for row in self.rows])

    @classmethod
    def of(
        cls,
        blocks: Iterable[tuple[FoldSegment, CollapseBlock]],
        *,
        provenance: CollapseProvenance,
    ) -> CollapseReport:
        return cls(
            provenance=provenance,
            rows=tuple(
                CollapseSegmentRow(segment=segment, block=block)
                for segment, block in blocks
            ),
        )

    @classmethod
    def from_scored_rows(
        cls, rows: Iterable[ScoredRow], *, provenance: CollapseProvenance
    ) -> CollapseReport:
        """The same block, assembled from a metrics table's rows.

        The fold-evaluation harness has already counted the six figures on every
        row it scored (:attr:`MetricsRow.collapse
        <wattsteer_ml.evaluation.metrics.MetricsRow.collapse>`), so a run that
        fitted models publishes its report from those rather than re-counting —
        one arithmetic, two entry points. A row whose block is ``None`` measured
        nothing and is **dropped rather than zeroed**, which is the same rule
        :class:`~wattsteer_ml.evaluation.collapse.P50Collapse` applies one level
        down.

        The caller supplies the provenance because this module cannot see where
        the scored hours came from — and a report that guessed would guess
        :data:`HOLDOUT_HOURS_SOURCE` on a fixture.
        """
        return cls.of(
            ((row.segment, row.collapse) for row in rows if row.collapse is not None),
            provenance=provenance,
        )

    @property
    def lane(self) -> Lane:
        """Read off the provenance, so a report cannot name a second lane."""
        return self.provenance.lane

    @property
    def subsystems_reported(self) -> tuple[Subsystem, ...]:
        """The subsystems that appear in at least one segment's block."""
        labels = {cell.label for row in self.rows for cell in row.block.by_subsystem}
        return tuple(code for code in SUBSYSTEM_CODES if code in labels)

    @property
    def fidelities(self) -> tuple[VintageFidelity, ...]:
        """The vintages the reported segments carry, in the order they appear."""
        seen: list[VintageFidelity] = []
        for row in self.rows:
            if row.segment.fidelity not in seen:
                seen.append(row.segment.fidelity)
        return tuple(seen)

    def card_block(self) -> dict[str, Any]:
        """The block, under :data:`COLLAPSE_BLOCK_KEY`.

        ``reads`` and ``vintage_caveat`` are prose on purpose: the optimizer work
        reads this block without reading this module, and the two things it must
        not do are take a fixture-stamped decimal for a property of the grid and
        reopen — or refuse to reopen — a posture on folds whose labels have all
        been revised since.
        """
        block: dict[str, Any] = {
            **self.provenance.card_fields(),
            "reads": _READS if self.provenance.is_measurement else _NOT_A_READING,
            "vintage_fidelities": list(self.fidelities),
            "folds": [row.card_entry() for row in self.rows],
        }
        if "point_in_time" not in self.fidelities:
            block["vintage_caveat"] = _REVISION_OPTIMISTIC_ONLY
        return {COLLAPSE_BLOCK_KEY: block}


@dataclass(frozen=True)
class UnmeasuredCollapse:
    """No figures, and the sentence saying why — the shape of an absent number.

    Returned by :func:`measure_p50_collapse` when the query found no held-out
    band. A report of zeroes would say the posture never collapses and a report
    of ones would say it always does; both are readings of an empty table, and
    neither is a thing anybody may plan against. So this value has no field that
    could be mistaken for a figure.
    """

    lane: Lane
    as_of: datetime
    reason: str
    collapse_source: str = UNMEASURED_SOURCE

    @property
    def is_measurement(self) -> bool:
        return False

    def card_block(self) -> dict[str, Any]:
        return {
            COLLAPSE_BLOCK_KEY: {
                "measured": False,
                "collapse_source": self.collapse_source,
                "origin_kind": HOLDOUT_ORIGIN_KIND,
                "lane": self.lane.directory_name,
                "as_of": self.as_of.isoformat(),
                "reason": self.reason,
                "reads": _NOTHING_YET,
            }
        }


def record_collapse_report(
    report: CollapseReport | UnmeasuredCollapse, *, root: Path, artifact_id: str
) -> Path:
    """Write the block onto an artifact's card, under :data:`COLLAPSE_BLOCK_KEY`.

    An edit of a card already on the volume, through the one reader and the one
    writer :func:`~wattsteer_ml.evaluation.gate.record_decision` uses, so the
    Decision group and this one cannot disagree about what a card is.

    **An** :class:`UnmeasuredCollapse` **is written too.** A card that carries no
    collapse block at all and a card that carries "this could not be measured
    yet" look identical to anybody grepping for the figure, and only one of them
    is true of an environment with no backfilled holdout rows. Writing the
    absence is what makes it a fact somebody can act on rather than a gap.
    """
    path = root / report.lane.directory_name / f"{artifact_id}{CARD_SUFFIX}"
    card = read_card(path)
    write_card(path, {**card, **report.card_block()})
    return path


async def read_holdout_hours(
    conn: asyncpg.Connection[Any],
    *,
    segment: FoldSegment,
    lane: Lane,
    as_of: datetime,
) -> tuple[tuple[PublishedHour, ...], str | None]:
    """One segment's held-out bands, and the ``run_label`` that wrote them.

    Opens its own transaction so the read axes cannot outlive it, exactly as
    :func:`wattsteer_ml.forecast_reads.read_planning_profile` and
    :func:`wattsteer_ml.replay.reads.read_calendar_evidence` do.

    The ``run_label`` comes back beside the hours rather than being asked for
    separately: it is what the *rows* say, so a report cannot claim a run whose
    rows it did not read. Two runs' rows in one segment is a refusal — their
    bands come from two artifacts and one share over both is a share of nothing.
    """
    async with conn.transaction():
        await apply_axes(conn, ReadAxes(as_of=as_of))
        records = await conn.fetch(
            HOLDOUT_HOURS_SQL,
            segment.test_start,
            segment.test_end,
            lane.feature_set,
            lane.gate_profile,
            lane.threshold_mw,
        )
    rows = [dict(record) for record in records]
    labels = sorted({str(row["run_label"]) for row in rows})
    if len(labels) > 1:
        raise CollapseReportError(
            f"{segment.row_id}: held-out bands from more than one backtest run "
            f"({labels!r}); they come from two artifacts, and one share over both "
            "is a share of neither"
        )
    hours = tuple(_published_hour(row) for row in rows)
    return hours, labels[0] if labels else None


async def measure_p50_collapse(
    conn: asyncpg.Connection[Any],
    *,
    segments: Sequence[FoldSegment],
    lane: Lane,
    as_of: datetime,
) -> CollapseReport | UnmeasuredCollapse:
    """**The deliverable.** The six figures over the held-out bands, or a refusal.

    Args:
        segments: the fold segments to report, from
            :func:`~wattsteer_ml.evaluation.vintage.stamp_calendar`. Split folds
            arrive as two segments and are reported as two rows; passing one half
            of a split fold is refused on construction.
        lane: which artifact's bands. Not derived from the rows: a query that
            took whatever lane the table happened to hold would silently change
            population when a second lane is backfilled.
        as_of: ``canonical_as_of()``. A backtest run appends a newer vintage
            rather than overwriting, so the report is reproducible only against
            the instant it names — which is why the instant is on the card.

    Returns:
        A :class:`CollapseReport` when at least one segment yielded a complete
        subsystem-day, and :class:`UnmeasuredCollapse` when none did — which is
        what an environment with no backfilled holdout rows gets, and it is not
        an error. It is the true answer, and the reason it is a value rather than
        an exception is that a card has to be able to carry it.
    """
    if not segments:
        raise CollapseReportError(
            "no fold segment to report; the segments come from the shared "
            "calendar and an empty list is a caller mistake, not an empty table"
        )
    blocks: list[tuple[FoldSegment, CollapseBlock]] = []
    labels: set[str] = set()
    for segment in segments:
        hours, run_label = await read_holdout_hours(
            conn, segment=segment, lane=lane, as_of=as_of
        )
        block = CollapseBlock.of(hours)
        if block is None or run_label is None:
            continue
        labels.add(run_label)
        blocks.append((segment, block))
    if not blocks:
        return UnmeasuredCollapse(
            lane=lane,
            as_of=as_of,
            reason=(
                f"no {HOLDOUT_ORIGIN_KIND} forecast row for lane "
                f"{lane.directory_name} covers a complete subsystem-day in any of "
                f"the {len(segments)} fold segments asked for, so there is no day "
                "to count a collapse over"
            ),
        )
    if len(labels) > 1:
        raise CollapseReportError(
            f"the segments were written by more than one backtest run "
            f"({sorted(labels)!r}); a report pooled over two runs names neither"
        )
    return CollapseReport.of(
        blocks,
        provenance=CollapseProvenance.measured(
            lane=lane, as_of=as_of, run_label=labels.pop()
        ),
    )


def _published_hour(row: dict[str, Any]) -> PublishedHour:
    """One stored row as a measurable hour. No arithmetic beyond the band's order."""
    subsystem: Subsystem = row["subsystem"]
    return PublishedHour(
        key=RowKey(
            target_date=row["target_date"],
            local_hour=int(row["local_hour"]),
            subsystem=subsystem,
        ),
        forecast=PublishedBand(
            band=QuantileBand(
                p10=float(row["p10_mwh"]),
                p50=float(row["p50_mwh"]),
                p90=float(row["p90_mwh"]),
            ),
            occurrence_probability=float(row["occurrence_probability"]),
        ),
    )


#: What the block's ``reads`` field says when the figures came out of Postgres.
_READS = (
    "share_of_days_with_no_non_zero_p50_hour is the share of complete "
    "subsystem-days on which no hour has a non-zero P50 — days a P50-planned "
    "dispatch has nothing to act on. Counted over out-of-fold bands read from "
    "canonical_forecast_hour, per fold segment; never pooled across segments, "
    "because their vintage fidelities differ."
)

#: And what it says when they did not. Deliberately blunt, and deliberately in
#: the same field, so a reader who reaches the numbers has already read this.
_NOT_A_READING = CaveatedFigure(
    "THESE FIGURES ARE NOT A MEASUREMENT OF THE GRID. The bands they were "
    "counted over were fabricated, so every share here is arithmetic over "
    "invented probabilities. Only a block whose collapse_source is "
    f"{HOLDOUT_HOURS_SOURCE!r} says anything about the Brazilian system, and "
    "ticket 011 must not read this one.",
    figure="the P50-collapse shares, share_of_days_with_no_non_zero_p50_hour included",
    misreading=(
        "that a P50-planned dispatch has no hour to act in this often on "
        "the Brazilian system"
    ),
    surface="the model card's `p50_collapse_report` block, `reads`",
)

#: On a block whose every segment predates ingestion go-live. The figures are
#: real; what they are figures *about* is a label vintage the product will never
#: see again, and `docs/specs/forecaster.md` requires that the caveat travel with
#: the number rather than be recoverable by whoever remembers the calendar.
_REVISION_OPTIMISTIC_ONLY = CaveatedFigure(
    "Every fold segment here is revision_optimistic: no reported segment's test "
    "period begins after ingestion go-live. The occurrence classifier's "
    "operating region — which is what these shares measure — was fitted and "
    "scored against labels that have since been revised, so this block may not "
    "carry the posture decision on its own until a point_in_time segment exists.",
    figure=(
        "the P50-collapse shares, on a block none of whose fold segments "
        "begins after ingestion go-live"
    ),
    misreading=(
        "that the classifier operating region these shares measure is the "
        "one the product will serve from"
    ),
    surface="the model card's `p50_collapse_report` block, `vintage_caveat`",
)

#: And when there were no bands at all.
_NOTHING_YET = (
    "The measurement ran and found nothing to count. This is not a share of "
    "zero: no held-out band exists for this lane yet, so the posture question "
    "is unanswered rather than answered favourably."
)
