"""How much faster is a machine at this project's training, measured, not quoted.

The retrain fits LightGBM with ``num_threads = 1`` (it is part of the model
configuration, for reproducibility), so a bigger machine cannot make one fit
faster except through a faster core. What it can do is run more fits at once:
folds, lanes, A/B arms and configuration variants are independent. So this
prints both numbers for the machine it runs on, on a synthetic matrix of the
real design matrix's shape and with the served booster's parameters:

- ``one_fit_s``: one fit, one thread;
- ``parallel_fits_per_min``: ``processes`` single-thread fits at once.

    python infra/aws/bench/fit_speed.py [processes]
"""

import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import lightgbm as lgb
import numpy as np

ROWS, FEATURES, ROUNDS = 90_000, 78, 400


def _data() -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(20_260_828)
    x = rng.normal(size=(ROWS, FEATURES))
    y = np.maximum(0.0, x[:, 0] * 3 + x[:, 1] ** 2 - x[:, 2] * x[:, 3] + rng.normal(size=ROWS))
    return x, y


def fit(seed: int) -> float:
    x, y = _data()
    params = {
        "objective": "quantile", "alpha": 0.5, "learning_rate": 0.05, "num_leaves": 63,
        "min_data_in_leaf": 100, "feature_fraction": 0.9, "bagging_fraction": 0.9,
        "bagging_freq": 1, "seed": seed, "deterministic": True, "force_row_wise": True,
        "num_threads": 1, "verbosity": -1,
    }
    start = time.perf_counter()
    lgb.train(params, lgb.Dataset(x, y), num_boost_round=ROUNDS)
    return time.perf_counter() - start


if __name__ == "__main__":
    cpus = os.cpu_count() or 1
    processes = int(sys.argv[1]) if len(sys.argv) > 1 else cpus
    one = min(fit(1) for _ in range(2))
    start = time.perf_counter()
    with ProcessPoolExecutor(processes) as pool:
        list(pool.map(fit, range(processes)))
    wall = time.perf_counter() - start
    print(f"cpus={cpus} one_fit_s={one:.2f} processes={processes} "
          f"parallel_wall_s={wall:.2f} parallel_fits_per_min={processes * 60 / wall:.1f}")
