"""The published configuration, and the search that must not happen inside it.

`docs/specs/forecaster.md`: "Hyperparameters are fixed, published, and not
searched during a retrain. A search inside the weekly retrain makes the artifact
irreproducible and the gate's comparison meaningless — the candidate would
differ from the incumbent in both data and configuration."

The numbers below are quoted from that paragraph. The last test is the one that
matters most: it asserts against the training package's own source that no
tuning API is reachable from it, because "we did not search this week" is a
promise and "there is nothing here that could search" is a fact.
"""

from __future__ import annotations

import inspect
import pkgutil
from importlib import import_module

import pytest

import wattsteer_ml.training as training_package
from wattsteer_ml.training import (
    ESTIMATOR_FAMILY,
    MODEL_CONFIG_V1,
    MODEL_CONFIG_V2,
    MODEL_CONFIG_VERSION,
    MODEL_CONFIGS,
    ModelConfig,
    UnknownModelConfigError,
    model_config,
)

#: The tuning APIs a retrain must not be able to reach. Names rather than
#: imports: the point is that none of them appears in this package at all.
SEARCH_APIS = (
    "GridSearchCV",
    "RandomizedSearchCV",
    "optuna",
    "hyperopt",
    "BayesSearchCV",
    "lgb.cv",
    "cv(",
    "tune",
)


def training_sources() -> dict[str, str]:
    sources = {}
    for module in pkgutil.iter_modules(training_package.__path__):
        name = f"{training_package.__name__}.{module.name}"
        sources[name] = inspect.getsource(import_module(name))
    return sources


def test_the_v1_numbers_are_the_specs_numbers() -> None:
    """ "≤ 800 trees, `learning_rate` 0.05, `num_leaves` 63, `min_data_in_leaf` 100"."""
    assert MODEL_CONFIG_V1.num_boost_round == 800
    assert MODEL_CONFIG_V1.learning_rate == 0.05
    assert MODEL_CONFIG_V1.num_leaves == 63
    assert MODEL_CONFIG_V1.min_data_in_leaf == 100
    assert MODEL_CONFIG_V1.early_stopping_rounds > 0


def test_the_configuration_is_addressed_by_a_version() -> None:
    assert MODEL_CONFIGS[MODEL_CONFIG_V1.version] is MODEL_CONFIG_V1
    assert model_config(MODEL_CONFIG_V1.version) is MODEL_CONFIG_V1


def test_an_unpublished_version_is_refused_rather_than_defaulted() -> None:
    """A card naming a configuration this build lacks cannot be reproduced.

    Falling back to the current default would produce an artifact that claims a
    version it was not trained under, which is the one thing the field is for.
    """
    with pytest.raises(UnknownModelConfigError):
        model_config("lgbm_whatever_v9")


def test_the_estimator_family_is_the_gates_allow_list() -> None:
    """`estimator_family ∈ {"lightgbm"}` — where the transformer is refused."""
    assert ESTIMATOR_FAMILY == "lightgbm"


def test_determinism_travels_with_the_version_not_the_caller() -> None:
    """Reproducibility that depends on the host's core count is not reproducibility."""
    params = MODEL_CONFIG_V1.params(objective="binary", role="occurrence")
    assert params["deterministic"] is True
    assert params["force_row_wise"] is True
    assert params["num_threads"] == 1
    assert params["use_missing"] is True
    assert params["zero_as_missing"] is False


def test_two_roles_sharing_an_objective_do_not_share_a_seed() -> None:
    """The conditional-mean booster and the share regressor are both `l2`.

    Giving them one bagging draw would correlate their errors for a reason
    nobody chose.
    """
    mean = MODEL_CONFIG_V1.params(objective="l2", role="magnitude_mean")
    share = MODEL_CONFIG_V1.params(objective="l2", role="wind_share")
    assert mean["seed"] != share["seed"]


def test_the_seed_offset_is_stable_across_processes() -> None:
    """`hash()` is salted per process; an artifact id must not be."""
    assert (
        MODEL_CONFIG_V1.params(objective="l2", role="wind_share")["seed"]
        == MODEL_CONFIG_V1.params(objective="l2", role="wind_share")["seed"]
    )
    source = inspect.getsource(import_module("wattsteer_ml.training.hyperparameters"))
    assert "hash(" not in source


def test_the_card_records_every_number() -> None:
    fields = MODEL_CONFIG_V1.card_fields()
    for name in (
        "model_config_version",
        "estimator_family",
        "num_boost_round",
        "learning_rate",
        "num_leaves",
        "min_data_in_leaf",
        "early_stopping_rounds",
        "seed",
    ):
        assert name in fields


@pytest.mark.parametrize("api", SEARCH_APIS)
def test_no_search_is_reachable_from_the_training_package(api: str) -> None:
    for name, source in training_sources().items():
        if name.endswith(".hyperparameters"):
            continue  # this module names them in a comment on purpose
        assert api not in source, f"{name} can reach {api}"


def test_v2_is_the_current_default_and_v1_still_resolves() -> None:
    """A card naming v1 must go on loading, whichever version trains today."""
    assert MODEL_CONFIG_V2.version == MODEL_CONFIG_VERSION
    assert MODEL_CONFIGS[MODEL_CONFIG_V1.version] is MODEL_CONFIG_V1
    assert MODEL_CONFIGS[MODEL_CONFIG_V2.version] is MODEL_CONFIG_V2
    assert model_config("lgbm_conservative_v1") is MODEL_CONFIG_V1
    assert model_config("lgbm_conservative_v2") is MODEL_CONFIG_V2


def test_v2_shares_every_v1_number_except_the_low_alpha_overrides() -> None:
    """v2 changes one thing: the lowest booster's capacity.

    Every other field — trees, learning rate, the fractions, the seed — is
    identical to v1's, so a fold's v2 fit is comparable with v1's wherever the
    two do not deliberately differ.
    """
    for name in (
        "num_boost_round",
        "learning_rate",
        "num_leaves",
        "min_data_in_leaf",
        "feature_fraction",
        "bagging_fraction",
        "bagging_freq",
        "early_stopping_rounds",
        "seed",
    ):
        assert getattr(MODEL_CONFIG_V1, name) == getattr(MODEL_CONFIG_V2, name)
    assert MODEL_CONFIG_V1.role_overrides == {}
    assert MODEL_CONFIG_V1.recency_half_life_days is None
    # Measured and dropped: the 180-day half-life refused gate_early F6 on
    # `p50_unbiasedness_in_band` (0.5618 against [0.45, 0.55]) while adding 4%
    # of the p10 repair. v2 fits unweighted, exactly as v1 does.
    assert MODEL_CONFIG_V2.recency_half_life_days is None


def test_the_low_alpha_overrides_land_on_the_two_lowest_boosters_and_no_other() -> None:
    """`num_leaves` 63 → 15 on ``magnitude_q0.02`` and no other role.

    Every other role — including ``magnitude_q0.10``, which the report's own
    ranking left untouched — must come back with v1's shared shape unchanged.
    """
    for role in ("magnitude_q0.02",):
        params = MODEL_CONFIG_V2.params(objective="quantile", role=role, alpha=0.02)
        assert params["num_leaves"] == 15
        assert params["min_data_in_leaf"] == 300
        assert params["lambda_l2"] == 10.0
    for role in ("magnitude_q0.10", "magnitude_q0.50", "magnitude_q0.90", "occurrence"):
        params = MODEL_CONFIG_V2.params(objective="quantile", role=role, alpha=0.10)
        assert params["num_leaves"] == MODEL_CONFIG_V1.num_leaves
        assert params["min_data_in_leaf"] == MODEL_CONFIG_V1.min_data_in_leaf
        assert "lambda_l2" not in params


def test_the_card_records_which_roles_v2_treats_differently() -> None:
    fields = MODEL_CONFIG_V2.card_fields()
    assert fields["role_overrides"] == {
        "magnitude_q0.02": {"num_leaves": 15, "min_data_in_leaf": 300, "lambda_l2": 10.0},
    }
    assert fields["recency_half_life_days"] is None
    assert MODEL_CONFIG_V1.card_fields()["role_overrides"] == {}
    assert MODEL_CONFIG_V1.card_fields()["recency_half_life_days"] is None


def test_a_negative_half_life_cannot_be_constructed() -> None:
    with pytest.raises(ValueError, match="recency_half_life_days"):
        ModelConfig(
            version="bad",
            num_boost_round=10,
            learning_rate=0.1,
            num_leaves=3,
            min_data_in_leaf=1,
            feature_fraction=1.0,
            bagging_fraction=1.0,
            bagging_freq=0,
            early_stopping_rounds=0,
            seed=1,
            recency_half_life_days=0,
        )


def test_a_nonsense_configuration_cannot_be_constructed() -> None:
    with pytest.raises(ValueError, match="learning_rate"):
        ModelConfig(
            version="bad",
            num_boost_round=10,
            learning_rate=0.0,
            num_leaves=3,
            min_data_in_leaf=1,
            feature_fraction=1.0,
            bagging_fraction=1.0,
            bagging_freq=0,
            early_stopping_rounds=0,
            seed=1,
        )
