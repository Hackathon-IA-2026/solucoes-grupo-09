"""Permute the labels, run the whole pipeline, and demand it score at chance.

`docs/specs/forecaster.md` seam 6 — the shuffled-label control, and the spec's
own answer to "which single test would you keep": *the property that a pipeline
trained on permuted labels must score at chance is what makes every other number
in the model card believable.* It is a **generic detector**, the model layer's
twin of the feature spec's gate ablation and of
`tests/test_shuffled_feature_control.py` one layer down: it catches a whole
class of wrongness — a feature computed after the gate, a fold boundary that
lets a label through, a metric scored against the rows it was fitted on —
**without knowing how the leak happened**.

**The construction.** The label block is permuted across the rows of one fold,
and then :func:`~wattsteer_ml.evaluation.ladder.run_ladder` is run on the
permuted rows exactly as a real run runs it. There is no branch anywhere below
that skips the isotonic map, the conformal correction or the mixture inversion:
rung 4 is :class:`~wattsteer_ml.evaluation.ladder.LightGbmRung`, which reaches
:func:`~wattsteer_ml.training.hurdle.train_fold`, and the numbers judged here
are the ones :class:`~wattsteer_ml.evaluation.metrics.MetricsRow` publishes.
What changed is the labels and nothing else.

**Three properties of the permutation, and each is load-bearing.**

*The five label columns move as one block.* One permutation, applied to
:data:`LABEL_COLUMNS` together, so the label's own joint distribution survives
exactly — the wind/solar split still sums to the total, ``y_has_curtailment``
still agrees with ``y_magnitude_mwh``. What is destroyed is the association
between the label and the row, which is the only thing a model can be reading.
:func:`permute_labels_within_fold` refuses a row carrying a ``y_`` column it was
not told about, because a label left behind by a permutation is precisely the
leak this file exists to find.

*It is pooled across the fold, and deliberately not confined to a cell.* This is
the one place where seam 6 is the **inverse** of the diagnosis layer's
shuffled-feature control, and the inversion is worth stating because copying
that file's rule would silently produce a control that always passes. There, the
permutation had to stay inside ``(subsystem, local_hour)`` so that the permuted
target stayed exchangeable with a background matched on those two. Here the
whole point is to destroy every association a model could read, and
``(subsystem, local_hour)`` is where most of the signal *is*. Measured, on the
lane in `tests/test_shuffled_label_control.py`: a permutation confined to
``(subsystem, local_hour)`` leaves the served rung at PR-AUC 0.335 against a
prevalence of 0.110 — **more** skill than the honest run's 0.298, and nowhere
near chance — and this control fails it, which is
``test_a_permutation_that_respects_the_cell_is_not_this_control``.

*It moves settled labels among settled rows only.* An unlabelled hour is ONS not
having published, which is a property of the row's provenance rather than of its
label, and moving it changes which hours are scored at all. Two things follow:
the shuffled run is scored on **exactly** the rows the honest run was, so the
two are a comparison; and the calibration window keeps the complete days the
path ensemble needs, which a permutation of the NULLs breaks outright — the
first draft of this module moved them and
:class:`~wattsteer_ml.training.ensemble.PitMatrix` refused the fold on 29
complete days against the 30 it requires.

**The two verdicts, and what each is worth on the lane it was measured on.**

- ``pr_auc`` must fall inside :func:`chance_interval` — the interval a PR-AUC at
  chance falls in, at this row's count and prevalence. **This is the detector.**
  Measured over 40 permutation seeds the served rung sits 0.043 to 0.070 *below*
  the interval's ceiling, never once inside 4 points of it; the honest run sits
  0.124 above it, and a run with a label-derived feature column scores PR-AUC
  1.000 against a ceiling of 0.159.
- ``qloss_mwh`` must be no better than the same run's prevalence rung, within
  :data:`QLOSS_FLOOR`. **This one is the weaker of the two, and saying so is
  worth more than letting a green tick imply otherwise.** The prevalence rung's
  magnitude band is the empirical quantiles of the *base fit's* positives, which
  under a permutation are a random subset, so it is a noisy reference; and a
  conformal correction fitted on the calibration block buys real band
  calibration without any per-row skill. Measured over 40 seeds the served
  rung's ratio ranges over ``[0.913, 1.05]`` — it beats the prevalence rung by
  9% on one shuffle with nothing whatever to learn — while the *honest* run
  scores 1.010 and does not beat it at all. So on this lane the ratio cannot
  separate skill from noise, and it is not asked to: what it catches is the
  gross case, and against a leaked label column it reads 0.29–0.36, which is
  where :data:`QLOSS_FLOOR` is placed and what its value is read off.

**Which rungs the verdict is taken on.** :data:`JUDGED_RUNGS` — the served rung,
and by default only it. Seam 6's sentence is "run the whole pipeline … with the
labels randomly permuted", and rung 4 *is* the pipeline: the only rung carrying
the isotonic map, the conformal correction and the served composition. The other
four are baselines the ladder runs for comparison, rung 0 is the reference the
``qloss_mwh`` verdict is read against, and every one of their readings is
recorded. They are not judged for a measured reason: over 40 seeds the two
weakest rungs each landed a marginal 0.006–0.011 above the interval's ceiling
once, a 1% rate consistent with a 99% interval built from a **tie-free** null
that their heavily-tied scores do not match. Judging them would buy no detection
— a harness leak reaches rung 4, and both staged leaks below fire hardest there
— at the price of making the suite's most important test its flakiest, and a
control that cries wolf twice a year is a control people learn to rerun.

**A failure names the fold, the rung and the metric.** :meth:`ChanceReading.
off_chance` returns metric names and :meth:`ShuffledLabelControl.
assert_at_chance` raises with every one of them spelt against its ``row_id``, so
a leak is localised rather than announced. Every reading is recorded whichever
way the verdict went: a detector whose margin nobody can see is one nobody will
trust the next time it fires.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from wattsteer_ml.evaluation.folds import Fold, FoldBlocks
from wattsteer_ml.evaluation.ladder import Rung, run_ladder
from wattsteer_ml.evaluation.metrics import MetricsRow, MetricsTable
from wattsteer_ml.evaluation.vintage import FoldSegment

#: The label block, moved as one unit. Every column of `feature_row` whose name
#: begins with ``y_``; :func:`permute_labels_within_fold` refuses rows carrying
#: one that is not here, because a label column added later and left behind by
#: the permutation would be a leak this control could not see.
LABEL_COLUMNS: tuple[str, ...] = (
    "y_constrained_off_wind_mwh",
    "y_constrained_off_solar_mwh",
    "y_constrained_off_total_mwh",
    "y_has_curtailment",
    "y_magnitude_mwh",
)

#: The column that says whether ONS has settled this hour. A NULL here is an
#: unlabelled row, and unlabelled rows do not take part in the permutation.
TOTAL_COLUMN = "y_constrained_off_total_mwh"

#: The rung every other rung's ``qloss_mwh`` is read against. Rung 0 predicts one
#: number for every hour, so it is the honest zero point.
PREVALENCE_RUNG = "prevalence"

#: The rung seam 6 is *about*: the served pipeline, the only rung that carries
#: the isotonic map, the conformal correction and the served composition. Every
#: rung's reading is recorded; this is the one the verdict is taken on. See the
#: module docstring, "Which rungs the verdict is taken on".
SERVED_RUNG = "lightgbm"

#: The rungs :meth:`ShuffledLabelControl.assert_at_chance` judges, by default.
JUDGED_RUNGS: tuple[str, ...] = (SERVED_RUNG,)

#: How far below the prevalence rung's ``qloss_mwh`` a rung may sit before the
#: control calls it skill. Not a measurement of anything — it is a line, placed
#: between two measured populations: over 40 permutation seeds the served rung's
#: ratio bottomed out at 0.913, and a run with a label-derived feature column
#: left in the table scored 0.29–0.36. Every reading records its own ratio, so a
#: run that only just clears this leaves the number behind to argue with.
QLOSS_FLOOR = 0.80

#: Draws of the chance null. Two thousand puts the 0.5% and 99.5% quantiles on
#: ten draws each, which is enough for an interval nothing is expected to sit
#: near and cheap enough to run per row.
CHANCE_RESAMPLES = 2_000

#: The interval's coverage. Wide, because the question this control asks is
#: "could this have come from no signal at all", and the cost of a false alarm
#: on a suite that runs on every commit is that the one test everybody must
#: believe becomes the one everybody reruns.
CHANCE_LEVEL = 0.99


class ShuffledLabelError(ValueError):
    """The rows, or the table, cannot support the control that was asked for."""


class ChanceError(AssertionError):
    """A shuffled-label run scored off chance. The harness leaks."""


def permute_labels_within_fold(
    rows: Sequence[Mapping[str, Any]], *, seed: int
) -> tuple[dict[str, Any], ...]:
    """The same rows, with the label block permuted across the settled ones.

    Pooled over the whole fold's date range rather than global, which is the
    spec's wording and its reason: a permutation across folds would move a
    January label onto a July row, and the seasonal mismatch it introduces would
    be read by the metrics as an absence of skill that the model never had.
    Within one fold there is no such artefact to introduce.

    Args:
        rows: every row of one fold — base fit, calibration and test together.
            The permutation crosses those boundaries deliberately: a label that
            leaks from the training block into the test block follows the
            permutation with it, and so still shows up as skill.
        seed: recorded on the control, so a failing run is reproducible.

    Returns:
        Copies, in the order they arrived. Nothing is mutated in place: these
        rows are usually a module-scoped fixture and a second test reads them.

    Raises:
        ShuffledLabelError: if a row carries a ``y_`` column outside
            :data:`LABEL_COLUMNS`, or fewer than two settled hours.
    """
    for row in rows:
        unknown = sorted(
            name for name in row if name.startswith("y_") and name not in LABEL_COLUMNS
        )
        if unknown:
            raise ShuffledLabelError(
                f"{unknown} look like label columns and are not in LABEL_COLUMNS; a "
                "label the permutation leaves behind is exactly the leak this "
                "control exists to find, so it refuses rather than shuffling "
                "around it"
            )
    settled = [
        index for index, row in enumerate(rows) if row.get(TOTAL_COLUMN) is not None
    ]
    if len(settled) < 2:
        raise ShuffledLabelError(
            f"{len(settled)} settled hours in this fold; a permutation of fewer "
            "than two labels is not a permutation"
        )
    order = np.random.default_rng(seed).permutation(len(settled))
    donors = {
        settled[position]: settled[int(moved)] for position, moved in enumerate(order)
    }
    permuted: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        one = dict(row)
        donor = donors.get(index)
        if donor is not None:
            for name in LABEL_COLUMNS:
                one[name] = rows[donor][name]
        permuted.append(one)
    return tuple(permuted)


def chance_interval(
    *,
    rows: int,
    positives: int,
    seed: int,
    resamples: int = CHANCE_RESAMPLES,
    level: float = CHANCE_LEVEL,
) -> tuple[float, float]:
    """The interval a PR-AUC at chance falls in, at this count and prevalence.

    Built by resampling the **labels**: ``positives`` of the ``rows`` are placed
    uniformly at random against a fixed ranking, ``resamples`` times, and the
    interval is the two central quantiles of the average precisions that
    produces. For a ranking with no ties, average precision is
    ``(1/k)·Σ_i i/r_i`` over the positives' ranks ``r_i``, so the null depends on
    ``(rows, positives)`` alone and on no model — which is what makes this
    interval a property of the question rather than of the run being judged.

    **Why the labels and not the rows.** The alternative — resampling hours,
    with their scores — centres the interval on the value observed, which
    answers "how precisely was this measured" rather than "could this have come
    from nothing". It also needs the per-hour scores, and
    :class:`~wattsteer_ml.evaluation.metrics.MetricsTable` deliberately does not
    carry them. This interval is centred on chance, which is the centre seam 6
    asks about, and it is computable from ``rows`` and ``prevalence`` — two
    columns the published table already has.

    **It is conservative in the presence of ties.** A model with nothing to read
    hands many hours the same probability, and
    :func:`~wattsteer_ml.evaluation.metrics.pr_auc` consumes ties as a group,
    which pulls its value *toward* prevalence and away from the tails. The
    tie-free null is therefore wider than the run's own, so this interval
    under-detects rather than false-alarms — the right direction for a test that
    runs on every commit.
    """
    if positives <= 0 or positives >= rows:
        raise ShuffledLabelError(
            f"{positives} positives in {rows} hours; average precision over one "
            "class is not a score, and it has no chance interval either"
        )
    if not 0.0 < level < 1.0:
        raise ShuffledLabelError(f"{level!r} is not a coverage level")
    generator = np.random.default_rng(seed)
    steps = np.arange(1, positives + 1, dtype=np.float64)
    draws = np.empty(resamples, dtype=np.float64)
    for index in range(resamples):
        ranks = np.sort(generator.choice(rows, size=positives, replace=False)) + 1
        draws[index] = float(np.mean(steps / ranks))
    tail = (1.0 - level) / 2.0
    return float(np.quantile(draws, tail)), float(np.quantile(draws, 1.0 - tail))


@dataclass(frozen=True)
class ChanceReading:
    """One rung on one fold segment, and what chance would have given it.

    Holds the numbers rather than a verdict, because the numbers are the point:
    a test that prints ``False`` tells whoever broke the harness nothing.
    """

    #: ``F5``, or ``F6@point_in_time`` for one half of a split fold. The fold a
    #: failure names.
    row_id: str
    rung: str
    rung_number: int
    rows: int
    #: Whether ``p`` reached the composition through an isotonic map, and
    #: ``Q_pos`` through ``δ_lo``/``δ_hi``. Carried so that "the control ran the
    #: same code path as a real run" is a assertion rather than a claim about a
    #: call site somebody has to go and read.
    calibrated: bool
    conformalised: bool
    prevalence: float
    #: ``None`` when the segment gave PR-AUC nothing to rank — every hour of one
    #: class. An absent measurement, not a passing one.
    pr_auc: float | None
    #: :func:`chance_interval` at this row's count and prevalence.
    pr_auc_chance: tuple[float, float] | None
    qloss_mwh: float
    #: The same run's prevalence rung, on the same segment.
    prevalence_qloss_mwh: float

    def __post_init__(self) -> None:
        if self.prevalence_qloss_mwh <= 0.0:
            raise ShuffledLabelError(
                f"{self.row_id}/{self.rung}: the prevalence rung scored "
                f"{self.prevalence_qloss_mwh} MWh, so there is no reference to read "
                "this rung's qloss_mwh against"
            )

    @property
    def pr_auc_excess(self) -> float | None:
        """``pr_auc − prevalence``. Positive is skill, and skill is the failure."""
        return None if self.pr_auc is None else self.pr_auc - self.prevalence

    @property
    def qloss_ratio(self) -> float:
        """``qloss_mwh`` over the prevalence rung's. Below one is skill."""
        return self.qloss_mwh / self.prevalence_qloss_mwh

    def off_chance(self) -> tuple[str, ...]:
        """The metrics that scored too well, by name. Empty is the pass."""
        against: list[str] = []
        if (
            self.pr_auc is not None
            and self.pr_auc_chance is not None
            and self.pr_auc > self.pr_auc_chance[1]
        ):
            against.append("pr_auc")
        if self.qloss_ratio < QLOSS_FLOOR:
            against.append("qloss_mwh")
        return tuple(against)

    def recorded(self) -> dict[str, Any]:
        """What the run leaves behind, whichever way the verdict went."""
        return {
            "row_id": self.row_id,
            "rung": self.rung,
            "rows": self.rows,
            "prevalence": self.prevalence,
            "pr_auc": self.pr_auc,
            "pr_auc_excess": self.pr_auc_excess,
            "pr_auc_chance": self.pr_auc_chance,
            "qloss_mwh": self.qloss_mwh,
            "qloss_ratio": self.qloss_ratio,
            "off_chance": self.off_chance(),
        }


@dataclass(frozen=True)
class ShuffledLabelControl:
    """One permutation of one fold's labels, and how every rung scored on it.

    The seeds are fields rather than arguments that were passed and forgotten:
    a control whose permutation cannot be reproduced is a control nobody can
    debug.
    """

    permutation_seed: int
    chance_seed: int
    readings: tuple[ChanceReading, ...]
    #: The rungs the verdict is taken on. Every rung's reading is kept either
    #: way; this says which ones :meth:`assert_at_chance` will raise about.
    judged: tuple[str, ...] = JUDGED_RUNGS

    def __post_init__(self) -> None:
        if not self.readings:
            raise ShuffledLabelError(
                "a shuffled-label control over no rung is not a control"
            )

    @property
    def holds(self) -> bool:
        """Every rung, on every segment, scored at chance."""
        return not self.findings

    @property
    def findings(self) -> tuple[ChanceReading, ...]:
        """The judged readings that scored off chance, in the order made."""
        return tuple(
            reading
            for reading in self.readings
            if reading.rung in self.judged and reading.off_chance()
        )

    def reading(self, *, rung: str, row_id: str | None = None) -> ChanceReading:
        """One rung's reading, for a test that wants to assert on the number."""
        matches = [
            one
            for one in self.readings
            if one.rung == rung and (row_id is None or one.row_id == row_id)
        ]
        if len(matches) != 1:
            raise ShuffledLabelError(
                f"{len(matches)} readings for rung {rung!r} at row {row_id!r}"
            )
        return matches[0]

    def assert_at_chance(self) -> None:
        """Raise :class:`ChanceError` naming every fold and metric that scored well.

        The message is the deliverable. A leak that reports "the shuffled-label
        control failed" has told a reader to go and reproduce it; one that names
        ``F5/lightgbm pr_auc`` has told them where to look.
        """
        if self.holds:
            return
        lines = [
            f"  {one.row_id}/{one.rung}: "
            + ", ".join(
                f"{metric}="
                + (
                    f"{one.pr_auc} against a chance interval of {one.pr_auc_chance} "
                    f"at prevalence {one.prevalence:.4f}"
                    if metric == "pr_auc"
                    else f"{one.qloss_mwh:.3f} MWh, {one.qloss_ratio:.4f} of the "
                    f"prevalence rung's {one.prevalence_qloss_mwh:.3f}"
                )
                for metric in one.off_chance()
            )
            for one in self.findings
        ]
        raise ChanceError(
            "a run trained on labels permuted within the fold scored off chance, "
            "so something in the pipeline is reading a label it was not given "
            f"(permutation seed {self.permutation_seed}):\n" + "\n".join(lines)
        )

    def recorded(self) -> dict[str, Any]:
        """The whole control, flat, for ``record_property``."""
        return {
            "permutation_seed": self.permutation_seed,
            "chance_seed": self.chance_seed,
            "holds": self.holds,
            "judged": list(self.judged),
            "readings": [one.recorded() for one in self.readings],
        }


def chance_readings(
    table: MetricsTable,
    *,
    seed: int,
    resamples: int = CHANCE_RESAMPLES,
    level: float = CHANCE_LEVEL,
) -> tuple[ChanceReading, ...]:
    """Read a metrics table against chance, one reading per rung per segment.

    Separate from :func:`run_shuffled_label_control` on purpose. The judge and
    the intervention are two things, and keeping them apart is what lets a test
    point the judge at an *honest* table — which is how this file demonstrates
    that the control is capable of failing rather than merely of passing.
    """
    baselines = {row.row_id: row for row in table.rows if row.rung == PREVALENCE_RUNG}
    missing = sorted({row.row_id for row in table.rows} - set(baselines))
    if missing:
        raise ShuffledLabelError(
            f"{missing} carry no {PREVALENCE_RUNG!r} rung, so there is nothing to "
            "read their qloss_mwh against; seam 6 needs the whole ladder, not a "
            "subset of it"
        )
    return tuple(
        _reading(row, baselines[row.row_id], seed=seed, resamples=resamples, level=level)
        for row in table.rows
    )


def run_shuffled_label_control(
    rows: Sequence[Mapping[str, Any]],
    *,
    fold: Fold,
    blocks: FoldBlocks,
    segments: Sequence[FoldSegment],
    rungs: Sequence[Rung],
    function_definition: str,
    permutation_seed: int,
    chance_seed: int = 20_260_905,
    resamples: int = CHANCE_RESAMPLES,
    level: float = CHANCE_LEVEL,
    judged: Sequence[str] = JUDGED_RUNGS,
    day_grain: bool = False,
) -> ShuffledLabelControl:
    """Permute one fold's labels and run the whole ladder on them.

    :func:`~wattsteer_ml.evaluation.ladder.run_ladder` and nothing else — the
    same call a real run makes, with the same rungs, so the isotonic map, the
    conformal correction and the mixture inversion are all on the path. The only
    thing this function does that a real run does not is
    :func:`permute_labels_within_fold`, and it does it to the rows before the
    harness sees them.

    Args:
        day_grain: off by default. The day band is drawn from a bootstrap over
            the calibration window and is not one of the two metrics seam 6
            judges; leaving it on multiplies the control's cost for a column
            nothing here reads.
    """
    table = run_ladder(
        permute_labels_within_fold(rows, seed=permutation_seed),
        fold=fold,
        blocks=blocks,
        segments=segments,
        run=f"shuffled-label-{permutation_seed}",
        rungs=rungs,
        function_definition=function_definition,
        day_grain=day_grain,
    )
    return ShuffledLabelControl(
        permutation_seed=permutation_seed,
        chance_seed=chance_seed,
        readings=chance_readings(
            table, seed=chance_seed, resamples=resamples, level=level
        ),
        judged=tuple(judged),
    )


def _reading(
    row: MetricsRow,
    baseline: MetricsRow,
    *,
    seed: int,
    resamples: int,
    level: float,
) -> ChanceReading:
    """One published row, read against the chance the same segment allows."""
    positives = round(row.prevalence * row.rows)
    return ChanceReading(
        row_id=row.row_id,
        rung=row.rung,
        rung_number=row.rung_number,
        rows=row.rows,
        calibrated=row.calibrated,
        conformalised=row.conformalised,
        prevalence=row.prevalence,
        pr_auc=row.pr_auc,
        pr_auc_chance=(
            None
            if row.pr_auc is None
            else chance_interval(
                rows=row.rows,
                positives=positives,
                seed=seed,
                resamples=resamples,
                level=level,
            )
        ),
        qloss_mwh=row.qloss_mwh,
        prevalence_qloss_mwh=baseline.qloss_mwh,
    )
