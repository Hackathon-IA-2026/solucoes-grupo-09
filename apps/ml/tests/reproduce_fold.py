"""Train the shared fixture fold and print a digest of what it predicted.

Run as a script by `test_hurdle_training.py` in a **separate interpreter**, so
that "same inputs and same seed reproduce identical predictions" is asserted
across processes rather than within one. The difference is not pedantic: a
process-salted `hash()`, an unseeded shuffle or a thread-count-dependent
histogram build all reproduce perfectly inside one interpreter and diverge
between two, and the weekly retrain is always a second interpreter.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from conftest import (
    AS_OF,
    FIXTURE_BACKGROUND_ROWS_PER_CELL,
    FUNCTION_DEFINITION,
    WINDOW_START,
)
from feature_row_fixtures import feature_rows
from out_of_fold_fixtures import pool
from wattsteer_ml.evaluation import materialize_fold_calendar
from wattsteer_ml.training import forecast_rows, train_fold


def digest() -> tuple[str, str]:
    """``(feature_hash, sha256 over every composed number of the test period)``."""
    fold = materialize_fold_calendar(AS_OF).fold("F1")
    blocks = fold.blocks_for(WINDOW_START)
    rows = feature_rows(first=blocks.base_fit_start, last=blocks.test_end)
    trained = train_fold(
        rows,
        fold=fold,
        blocks=blocks,
        function_definition=FUNCTION_DEFINITION,
        pool=pool(),
        background_rows_per_cell=FIXTURE_BACKGROUND_ROWS_PER_CELL,
        artifact_id="2026-08-29T04:00:00Z",
    )
    test_rows = [row for row in rows if row["target_date"] >= blocks.test_start]
    running = hashlib.sha256()
    for hour in forecast_rows(trained.bundle, test_rows):
        band = hour.forecast.band
        running.update(
            "\t".join(
                (
                    hour.key.line,
                    # `repr` of a float round-trips exactly, so this compares the
                    # bits and not a rendering of them.
                    repr(hour.forecast.occurrence_probability),
                    repr(band.p10),
                    repr(band.p50),
                    repr(band.p90),
                    repr(hour.forecast.expected_mwh),
                )
            ).encode()
        )
    return trained.bundle.contract.feature_hash, running.hexdigest()


if __name__ == "__main__":
    print("\n".join(digest()))
