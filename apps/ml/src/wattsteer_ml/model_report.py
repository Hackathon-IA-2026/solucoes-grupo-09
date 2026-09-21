"""A static HTML page comparing the models on the volume, written after a retrain.

    python -m wattsteer_ml.model_report [--root DIR]
    <artifact root>/experiments/report.html

**A record, and nothing reads it back.** Like :mod:`wattsteer_ml.experiment_reports`
it sits beside the lanes: no serving, gate or `/v1/meta` path opens it. It reads
the volume through the same files those paths read — ``promotions.jsonl`` for
what is promoted, the cards for what each artifact measured — so it cannot
disagree with them about which artifact is current.

**The ladder is shown per ``(fold, vintage_fidelity)`` and never merged.** A
``revision_optimistic`` fold and a ``point_in_time`` one are different claims
(forecaster, vintage fidelity), so they are separate blocks with the fidelity
printed on each. The delta against rung 1 is taken only between rows of one
block, which is what "identical folds, rows, gate and threshold" buys.

**An absence is a sentence.** A card written before ``fold_metrics`` existed
says it has no ladder data; a ``null`` column says the segment gave it nothing to
measure. Neither is rendered as a zero. Nothing here sums or averages a quantile
across subsystems: the persisted rows are already pooled over the fold, and the
page carries no per-subsystem figure at all.

**One self-contained file.** Inline CSS, no script, no dependency, so it opens
from a downloaded volume with no server. Every value is HTML-escaped: a
promotion reason is free text from the gate.

**The reliability curve is not on this page.** The card holds ``ece``/``brier``
per row, not the bins; drawing a curve would mean persisting one first.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .artifacts import CARD_SUFFIX
from .config import settings
from .experiment_reports import EXPERIMENTS_DIRNAME
from .lanes import Lane, LaneNameError
from .promotions import (
    PROMOTION_LOG_FILENAME,
    PromotionLog,
    PromotionLogError,
    PromotionRecord,
)
from .training.bundle import read_card

REPORT_FILENAME = "report.html"
FOLD_METRICS_KEY = "fold_metrics"

#: The rung every other one is compared against — the mandatory 7-day baseline.
BASELINE_RUNG = "same_hour_7d"
#: The artifact's own rung.
MODEL_RUNG = "lightgbm"

_STYLE = (
    "body{font:14px/1.45 system-ui,sans-serif;margin:24px auto;max-width:1100px;"
    "padding:0 16px;color:#1b1f24}"
    "h1{font-size:22px}"
    "h2{font-size:17px;margin-top:32px;border-bottom:1px solid #d0d7de;"
    "padding-bottom:4px}"
    "h3{font-size:14px;margin:18px 0 4px}"
    "table{border-collapse:collapse;margin:6px 0 12px}"
    "th,td{border:1px solid #d0d7de;padding:3px 9px;text-align:right}"
    "th:first-child,td:first-child{text-align:left}"
    "th{background:#f6f8fa}.absent{color:#8a5a00}.muted{color:#57606a}"
    ".better{color:#1a7f37}.worse{color:#cf222e}"
    "code{background:#f6f8fa;padding:1px 4px}details{margin:4px 0}"
    "pre{background:#f6f8fa;padding:8px;overflow:auto}"
)


def _esc(value: object) -> str:
    return html.escape(str(value))


def _num(value: object, places: int = 3) -> str:
    """A figure, or the stated absence. ``None`` is never rendered as ``0``."""
    if value is None:
        return '<span class="absent">not measured</span>'
    if isinstance(value, bool) or not isinstance(value, int | float):
        return _esc(value)
    return f"{value:.{places}f}"


def _lane_dirs(root: Path) -> list[tuple[Lane, Path]]:
    """Directories that parse as a lane. ``experiments`` and stray files do not."""
    found: list[tuple[Lane, Path]] = []
    if not root.is_dir():
        return found
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name == EXPERIMENTS_DIRNAME:
            continue
        try:
            found.append((Lane.parse(entry.name), entry))
        except LaneNameError:
            continue
    return found


def _cards(lane_dir: Path) -> dict[str, dict[str, Any]]:
    cards: dict[str, dict[str, Any]] = {}
    for path in sorted(lane_dir.glob(f"*{CARD_SUFFIX}")):
        try:
            cards[path.name.removesuffix(CARD_SUFFIX)] = read_card(path)
        except (ValueError, OSError):
            # An unreadable card is one artifact missing from a report, and the
            # gate and /v1/meta are where a damaged volume is loud.
            continue
    return cards


def _ladder_html(rows: Sequence[Mapping[str, Any]]) -> str:
    """One block per ``(fold, vintage)``: a row per rung, deltas against rung 1."""
    groups: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for row in rows:
        key = (str(row.get("fold_id")), str(row.get("vintage_fidelity")))
        groups.setdefault(key, []).append(row)
    parts: list[str] = []
    for (fold_id, fidelity), group in sorted(groups.items()):
        group = sorted(group, key=lambda r: r.get("rung_number", 99))
        baseline = next((r for r in group if r.get("rung") == BASELINE_RUNG), None)
        base_q = None if baseline is None else baseline.get("qloss_mwh")
        parts.append(f"<h3>{_esc(fold_id)} · <code>{_esc(fidelity)}</code></h3>")
        parts.append(
            "<table><tr><th>rung</th><th>rows</th><th>qloss MWh</th>"
            f"<th>Δ vs {BASELINE_RUNG}</th><th>PR-AUC</th><th>Brier</th><th>ECE</th>"
            "<th>P10 cov.</th><th>P90 cov.</th><th>crossing</th></tr>"
        )
        for r in group:
            q = r.get("qloss_mwh")
            if base_q in (None, 0) or q is None or r is baseline:
                delta = '<span class="muted">—</span>' if r is baseline else _num(None)
            else:
                change = (q - base_q) / base_q * 100
                cls = "better" if change < 0 else "worse"
                delta = f'<span class="{cls}">{change:+.1f}%</span>'
            parts.append(
                f"<tr><td>{_esc(r.get('rung'))}</td><td>{_esc(r.get('rows'))}</td>"
                f"<td>{_num(q, 2)}</td><td>{delta}</td><td>{_num(r.get('pr_auc'))}</td>"
                f"<td>{_num(r.get('brier'))}</td><td>{_num(r.get('ece'))}</td>"
                f"<td>{_num(r.get('coverage_p10'))}</td><td>{_num(r.get('coverage_p90'))}</td>"
                f"<td>{_num(r.get('crossing_rate'))}</td></tr>"
            )
        parts.append("</table>")
    return "".join(parts)


def _decision_row(record: PromotionRecord) -> str:
    evidence = record.evidence
    return (
        f"<tr><td>{_esc(record.at.strftime('%Y-%m-%d %H:%M'))}</td>"
        f"<td><code>{_esc(record.artifact_id)}</code></td><td>{_esc(record.decision)}</td>"
        f"<td>{_num(evidence.get('bootstrap_p'))}</td>"
        f"<td style='text-align:left'>{_esc(record.reason)}</td></tr>"
    )


def _lane_html(lane: Lane, lane_dir: Path, log: PromotionLog) -> str:
    cards = _cards(lane_dir)
    current = log.promoted(lane)
    history = log.for_lane(lane)
    parts = [f"<h2>{_esc(lane.directory_name)}</h2>"]
    if current is None:
        parts.append('<p class="absent">No artifact is promoted in this lane.</p>')
    else:
        parts.append(f"<p>Promoted: <code>{_esc(current)}</code></p>")
    if history:
        parts.append(
            "<h3>Decisions</h3><table><tr><th>at (UTC)</th><th>artifact</th>"
            "<th>decision</th><th>bootstrap P</th><th>reason</th></tr>"
            + "".join(_decision_row(r) for r in reversed(history))
            + "</table>"
        )
    else:
        parts.append('<p class="absent">This lane has no recorded decision.</p>')
    # The ladder of the promoted artifact, else the newest card that has one.
    shown = current if current in cards else (max(cards) if cards else None)
    if shown is None:
        parts.append(
            '<p class="absent">No model card is on the volume for this lane.</p>'
        )
        return "".join(parts)
    metrics = cards[shown].get(FOLD_METRICS_KEY)
    label = "promoted" if shown == current else "newest, not promoted"
    parts.append(f"<h3>Ladder — <code>{_esc(shown)}</code> ({label})</h3>")
    if not isinstance(metrics, list) or not metrics:
        parts.append(
            '<p class="absent">This card has no ladder data: it was written before '
            "the table was kept. The next retrain writes it.</p>"
        )
    else:
        parts.append(_ladder_html(metrics))
    return "".join(parts)


def _experiments_html(root: Path) -> str:
    base = root / EXPERIMENTS_DIRNAME
    files = sorted(p for p in base.glob("*/*.json")) if base.is_dir() else []
    if not files:
        return '<p class="absent">No experiment report has been saved on this volume.</p>'
    parts = []
    for path in files:
        try:
            body = json.dumps(json.loads(path.read_text(encoding="utf-8")), indent=2)
        except (OSError, ValueError) as error:
            body = f"unreadable: {error}"
        parts.append(
            f"<details><summary>{_esc(path.parent.name)} · <code>{_esc(path.stem)}</code>"
            f"</summary><pre>{_esc(body)}</pre></details>"
        )
    return "".join(parts)


def render(root: Path, *, now: datetime | None = None) -> str:
    """The whole page as a string. Reads the volume, writes nothing."""
    stamp = (now or datetime.now(UTC)).strftime("%Y-%m-%d %H:%M UTC")
    try:
        log = PromotionLog.read(root / PROMOTION_LOG_FILENAME)
        log_note = ""
    except PromotionLogError as error:
        log = PromotionLog(path=root / PROMOTION_LOG_FILENAME, records=())
        log_note = (
            f'<p class="absent">The decision log could not be read: {_esc(error)}</p>'
        )
    lanes = _lane_dirs(root)
    body = "".join(_lane_html(lane, path, log) for lane, path in lanes)
    if not lanes:
        body = '<p class="absent">No lane directory is on this volume.</p>'
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        "<title>WattSteer model comparison</title>"
        f"<style>{_STYLE}</style></head><body><h1>Model comparison</h1>"
        f'<p class="muted">Generated {_esc(stamp)} after a retrain. A snapshot: it '
        "goes stale until the next one. Fidelity blocks are never merged.</p>"
        f"{log_note}{body}<h2>Experiment reports</h2>{_experiments_html(root)}"
        "</body></html>"
    )


def write_report(root: Path) -> Path:
    """Render and place the page atomically. Raises on failure — see the caller."""
    path = root / EXPERIMENTS_DIRNAME / REPORT_FILENAME
    partial = path.with_name(f"{path.name}.tmp")
    page = render(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial.write_text(page, encoding="utf-8")
    os.replace(partial, path)
    return path


def write_report_or_warn(root: Path) -> Path | None:
    """The retrain's call: a page that cannot be drawn is a warning, not a failure.

    Caught broadly on purpose. The fits and the gate have already decided and
    been recorded; nothing about a record of them may change the exit code the
    operator's schedule reads.
    """
    try:
        return write_report(root)
    except Exception as failure:
        print(
            json.dumps(
                {"warning": f"model report was not written under {root}: {failure}"}
            ),
            file=sys.stderr,
        )
        return None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wattsteer-ml-model-report")
    parser.add_argument("--root", default=str(settings.artifact_dir))
    args = parser.parse_args(list(argv) if argv is not None else None)
    path = write_report(Path(args.root))
    print(path)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
