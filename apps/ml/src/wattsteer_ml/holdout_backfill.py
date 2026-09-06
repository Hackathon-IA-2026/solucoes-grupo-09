"""The backtest run that keeps its out-of-fold forecasts. One fold, both lanes.

`docs/specs/replay.md`, "Where the `fold_holdout` forecasts come from":

    At the end of a backtest run, every fold's out-of-fold predictions are
    persisted as `Forecast` rows … whose new field ``origin_kind`` is
    **`backfilled_holdout`**.

Every piece of that sentence existed before this module and none of it ran.
:mod:`wattsteer_ml.evaluation.holdout` mints the publications from a fitted
fold; `apps/api/src/forecast/backfill.ts` parses and appends them. What was
missing was a *caller* — nothing under this package, `apps/api/src/jobs` or
anywhere else ever produced one — so the Time Machine answered
``REPLAY_FORECAST_UNAVAILABLE`` on precisely the F1–F5 days it exists to show.
This module is that caller.

## Why it is beside the retrain driver and not inside it

:mod:`wattsteer_ml.retrain` is pinned to the **live edge**, and it has to be:
"the weekly retrain always scores against F6". But the live edge is the
post-go-live quarter, whose days the product has actually served — those days
resolve `served` and a reconstruction of them is not what WattSteer said. The
days that answer a refusal are the **frozen** quarters behind it, and no other
caller in the repository can read a frozen fold's window.

So the composition is the retrain's, reused rather than restated —
:func:`~wattsteer_ml.retrain.read_lane_inputs` (now taking a fold id),
:func:`~wattsteer_ml.retrain.build_pool`,
:func:`~wattsteer_ml.training.train_fold`,
:func:`~wattsteer_ml.training.save_artifact` — and what is new here is the fold
selection, the artifact identity, and the hand-off.

## The artifact id is the fold's, which is what makes a rerun a vintage

The retrain's run id is a clock, because a retrain is an event. A backfill is
not: scoring F3 twice is scoring F3, and the second pass should *supersede* the
first rather than sit beside it. A clock-derived id would give every pass a
different ``run_label``, and two reconstructions of one day under two artifact
ids are duplicates that nothing downstream can rank —
``PUBLISHED_DAYS_SQL`` orders on ``published_at`` and ``data_version``, and both
would be equal.

:func:`fold_artifact_id` therefore derives the id from ``quarter_end``, which
the calendar rules fix and the clock never moves. A second pass then writes the
same ``(subsystem, target_date, origin_kind, gate_profile, run_label)`` key at a
later ``ingested_at``, which is exactly the append-only vintage the bitemporal
rules ask for: the older replay is still reconstructible at its own ``AsOf``.

## Nothing here writes to Postgres, and nothing here can mint a record

The modelling service is read-only against Postgres. This driver reads feature
rows, fits, and prints the payload; the gateway's worker appends it
(`apps/api/src/jobs/holdout-backfill.ts`). And the discriminator is not a
parameter anywhere on the path: ``fold_holdout_publications`` writes
:data:`~wattsteer_ml.publication.BACKFILLED_HOLDOUT_ORIGIN_KIND` as a constant
into its one ``build_publication`` call, and there is no argument to this
module that reaches it.

## A lane's failure is a line, not the run

The retrain's posture, for the retrain's reason: the two served lanes are
independent, and a fold that cannot be scored in the evening view is still worth
scoring in the morning one. What makes the *run* a failure is scoring no lane at
all, which is what :func:`main`'s exit code says.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg

from wattsteer_ml.config import settings
from wattsteer_ml.evaluation import Fold, FoldCalendar, materialize_fold_calendar
from wattsteer_ml.evaluation.holdout import HoldoutBacktest, fold_holdout_publications
from wattsteer_ml.evaluation.serving_lanes import SERVING_LANES
from wattsteer_ml.lanes import Lane, format_instant
from wattsteer_ml.retrain import LaneInputs, build_pool, read_lane_inputs
from wattsteer_ml.training import save_artifact, train_fold


class HoldoutBackfillError(RuntimeError):
    """The run cannot proceed — no such fold, no calendar edge, no database."""


def fold_artifact_id(fold: Fold) -> str:
    """The artifact id a fold's holdout is written under. Stable, by design.

    ``quarter_end`` and never ``test_end``: the second grows while a fold is the
    live edge, so an id derived from it would move with the clock and every pass
    would mint a second, unrankable reconstruction of the same days. See the
    module docstring.
    """
    return f"{fold.quarter_end.isoformat()}T00:00:00Z"


def newest_frozen_fold(calendar: FoldCalendar) -> Fold | None:
    """The most recent fold whose test period will never change again.

    ``None`` before the first quarter has frozen — a real state on a young
    calendar, and not a fault. The newest one is the default because it is the
    fold most likely to hold days no run has reconstructed yet; the earlier ones
    are reached by naming them, which is what an operator backfilling the whole
    window does.
    """
    frozen = calendar.frozen_folds
    return frozen[-1] if frozen else None


@dataclass(frozen=True)
class HoldoutBackfillRequest:
    """One backfill, fully pinned. Nothing below this reads a clock."""

    as_of: datetime
    root: Path
    database_url: str
    #: Which fold to score. ``None`` is :func:`newest_frozen_fold`, resolved
    #: against the calendar ``as_of`` materialises — never against the live edge,
    #: which is the retrain's fold and is served for real.
    fold_id: str | None = None
    lanes: tuple[Lane, ...] = SERVING_LANES

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None:
            raise HoldoutBackfillError(
                "as_of must be tz-aware; a naive instant materialises no calendar"
            )

    def calendar(self) -> FoldCalendar:
        return materialize_fold_calendar(self.as_of.date())

    def fold(self, calendar: FoldCalendar) -> Fold:
        """The fold this run scores, or a refusal naming what the calendar holds."""
        if self.fold_id is None:
            fold = newest_frozen_fold(calendar)
            if fold is None:
                raise HoldoutBackfillError(
                    f"no fold has frozen as of {self.as_of.date().isoformat()}; the "
                    "only fold on this calendar is still the live edge, which the "
                    "weekly retrain scores and the product serves for real"
                )
            return fold
        for fold in calendar.folds:
            if fold.id == self.fold_id:
                return fold
        raise HoldoutBackfillError(
            f"no fold {self.fold_id!r} on the calendar as of "
            f"{self.as_of.date().isoformat()}; it holds "
            f"{[fold.id for fold in calendar.folds]!r}"
        )


@dataclass(frozen=True)
class LaneFailure:
    """A lane that reached no publication, and the sentence that says why."""

    lane: Lane
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {"lane": self.lane.directory_name, "reason": self.reason}


@dataclass(frozen=True)
class HoldoutBackfillReport:
    """What one run produced: the payloads to write, and the lanes that did not.

    The payloads are the *whole* deliverable — this side writes nothing — so the
    report is what crosses to the gateway rather than a summary of a side
    effect.
    """

    fold_id: str
    artifact_id: str
    as_of: datetime
    runs: tuple[HoldoutBacktest, ...]
    failures: tuple[LaneFailure, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "fold_id": self.fold_id,
            "artifact_id": self.artifact_id,
            "as_of": format_instant(self.as_of),
            "runs": [one.as_payload() for one in self.runs],
            "failures": [failure.as_dict() for failure in self.failures],
        }


async def _lane_inputs(
    request: HoldoutBackfillRequest, lane: Lane, fold_id: str
) -> LaneInputs:
    conn: asyncpg.Connection[Any] = await asyncpg.connect(
        request.database_url, server_settings={"default_transaction_read_only": "on"}
    )
    try:
        return await read_lane_inputs(conn, lane, as_of=request.as_of, fold_id=fold_id)
    finally:
        await conn.close()


def backfill_lane(
    inputs: LaneInputs, *, request: HoldoutBackfillRequest, artifact_id: str
) -> HoldoutBacktest:
    """One lane's fold: fit it, keep the artifact, mint its held-out days.

    The artifact is saved **before** the publications are minted, for the reason
    the retrain saves one before the gate runs: the card is what
    `apps/ml/.../replay/cards.py` re-checks the held-out property against at read
    time, and a row naming an artifact whose card is not on the volume is a
    ``500`` rather than a replay. A run that wrote rows without the card would
    have produced exactly that.
    """
    trained = train_fold(
        inputs.rows,
        fold=inputs.fold,
        blocks=inputs.blocks,
        function_definition=inputs.function_definition,
        pool=build_pool(inputs),
        created_at=request.as_of,
        artifact_id=artifact_id,
    )
    save_artifact(trained.bundle, trained.card, root=request.root)
    return fold_holdout_publications(inputs.rows, trained=trained)


def run_holdout_backfill(request: HoldoutBackfillRequest) -> HoldoutBackfillReport:
    """One fold, every served lane, whatever the others did."""
    calendar = request.calendar()
    fold = request.fold(calendar)
    artifact_id = fold_artifact_id(fold)

    runs: list[HoldoutBacktest] = []
    failures: list[LaneFailure] = []
    for lane in request.lanes:
        try:
            inputs = asyncio.run(_lane_inputs(request, lane, fold.id))
            runs.append(backfill_lane(inputs, request=request, artifact_id=artifact_id))
        except Exception as error:
            # A lane's fault is a line in the report, never the run: the two
            # served lanes are independent, and the morning view is the fallback
            # that makes a wrong evening call recoverable.
            reason = f"{type(error).__name__}: {error}"
            failures.append(LaneFailure(lane=lane, reason=reason))
    return HoldoutBackfillReport(
        fold_id=fold.id,
        artifact_id=artifact_id,
        as_of=request.as_of,
        runs=tuple(runs),
        failures=tuple(failures),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m wattsteer_ml.holdout_backfill`` — one fold, one JSON payload.

    A process rather than a request handler, for the retrain's reasons: a
    multi-minute LightGBM fit on the modelling service's event loop stalls every
    read it is also serving. ``POST /internal/backfill/holdout`` spawns it and
    hands the report to the worker that appends it.

    The exit code is the operator's signal — non-zero when *no* lane produced a
    publication, which is the only outcome that is unambiguously a failed run.
    """
    parser = argparse.ArgumentParser(prog="wattsteer-ml-holdout-backfill")
    parser.add_argument(
        "--fold",
        default=None,
        help=(
            "which fold to score — F1, F2, … Defaults to the newest frozen fold, "
            "which is the one most likely to hold days no run has reconstructed "
            "yet. The live edge is the weekly retrain's fold and is served."
        ),
    )
    parser.add_argument("--root", default=str(settings.artifact_dir))
    parser.add_argument("--database-url", default=settings.database_url or "")
    parser.add_argument(
        "--as-of",
        default=None,
        help="the instant the calendar is materialised at, ISO-8601 UTC to the "
        "second. Defaults to now, which is only right for a hand-run backfill.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.database_url:
        print(
            json.dumps({"error": "no database url; set DATABASE_URL or pass one"}),
            file=sys.stderr,
        )
        return 2
    as_of = (
        datetime.now(UTC)
        if args.as_of is None
        else datetime.strptime(args.as_of, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    )
    try:
        report = run_holdout_backfill(
            HoldoutBackfillRequest(
                as_of=as_of,
                root=Path(args.root),
                database_url=args.database_url,
                fold_id=args.fold,
            )
        )
    except HoldoutBackfillError as refusal:
        print(json.dumps({"error": str(refusal)}), file=sys.stderr)
        return 2
    print(json.dumps(report.as_dict()))
    return 0 if report.runs else 1


if __name__ == "__main__":  # pragma: no cover - the process entry point
    sys.exit(main())
