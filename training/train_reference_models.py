#!/usr/bin/env python3
"""Train speed models on previous-day, previous-week and previous-year speeds.

Each training example is one validated observation in PostgreSQL: the target
is its speed, and the features are the sensor plus the same sensor's speed at
the same timestamp one day, one week and one year earlier. A missing
reference stays NaN so the models learn to use whichever references exist.
Observations with none of the three references are not trainable and are
skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor
from lightgbm import LGBMRegressor, early_stopping, log_evaluation
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor

from training.db import connect
from training.reference_features import (
    FEATURE_NAMES,
    FORECAST_TYPE,
    METRICS_FILE,
    REFERENCE_FEATURES,
)

MODEL_FILES = {
    "xgboost": "reference_xgboost.json",
    "catboost": "reference_catboost.cbm",
    "lightgbm": "reference_lightgbm.txt",
}
UTC = timezone.utc

# The connection uses a UTC session, so interval arithmetic here matches
# reference_features.reference_timestamps (including Feb 29 -> Feb 28).
# NaN speeds fail BETWEEN in PostgreSQL, so invalid readings become NULL.
TRAINING_SQL = """
SELECT * FROM (
    SELECT
        o.sensor_id,
        (EXTRACT(EPOCH FROM o.observed_at) * 1000000)::bigint AS observed_at_us,
        o.speed,
        CASE WHEN d.speed BETWEEN 0 AND 200 THEN d.speed END AS previous_day_speed,
        CASE WHEN w.speed BETWEEN 0 AND 200 THEN w.speed END AS previous_week_speed,
        CASE WHEN y.speed BETWEEN 0 AND 200 THEN y.speed END AS previous_year_speed
    FROM observations o
    LEFT JOIN observations d
        ON d.sensor_id = o.sensor_id
       AND d.observed_at = o.observed_at - INTERVAL '1 day'
    LEFT JOIN observations w
        ON w.sensor_id = o.sensor_id
       AND w.observed_at = o.observed_at - INTERVAL '7 days'
    LEFT JOIN observations y
        ON y.sensor_id = o.sensor_id
       AND y.observed_at = o.observed_at - INTERVAL '1 year'
    WHERE o.speed BETWEEN 0 AND 200
) AS examples
WHERE previous_day_speed IS NOT NULL
   OR previous_week_speed IS NOT NULL
   OR previous_year_speed IS NOT NULL
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output-dir", type=Path, default=Path("model_artifacts"))
    parser.add_argument("--validation-fraction", type=float, default=0.2)
    parser.add_argument("--estimators", type=int, default=500)
    parser.add_argument("--early-stopping-rounds", type=int, default=40)
    parser.add_argument(
        "--sample-fraction",
        type=float,
        default=1.0,
        help="Randomly keep this fraction of examples (for quicker trial runs).",
    )
    parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if not 0.05 <= args.validation_fraction <= 0.4:
        parser.error("--validation-fraction must be between 0.05 and 0.4")
    if not 0 < args.sample_fraction <= 1:
        parser.error("--sample-fraction must be in (0, 1]")
    for name in ("estimators", "early_stopping_rounds", "threads"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    return args


def regression_metrics(target: np.ndarray, prediction: np.ndarray) -> dict[str, float]:
    return {
        "rmse": float(np.sqrt(mean_squared_error(target, prediction))),
        "mae": float(mean_absolute_error(target, prediction)),
        "r2": float(r2_score(target, prediction)),
    }


def load_examples(connection) -> tuple[pd.DataFrame, list[int]]:
    """Stream training examples out of PostgreSQL with COPY."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT sensor_id FROM sensors ORDER BY sensor_id")
        sensor_categories = [int(row[0]) for row in cursor.fetchall()]
    if not sensor_categories:
        raise RuntimeError("The sensors table is empty.")

    with tempfile.NamedTemporaryFile(
        mode="wb", prefix="gridlock-reference-", suffix=".csv"
    ) as buffer:
        with connection.cursor() as cursor:
            with cursor.copy(
                f"COPY ({TRAINING_SQL}) TO STDOUT WITH (FORMAT csv, HEADER true)"
            ) as copy:
                for chunk in copy:
                    buffer.write(chunk)
        buffer.flush()
        frame = pd.read_csv(
            buffer.name,
            dtype={
                "sensor_id": np.int64,
                "observed_at_us": np.int64,
                "speed": np.float32,
                **{name: np.float32 for name in REFERENCE_FEATURES},
            },
        )
    connection.commit()
    if frame.empty:
        raise RuntimeError(
            "No observation has a previous-day, previous-week or previous-year "
            "reading; there is nothing to train on."
        )
    return frame, sensor_categories


def model_inputs(frame: pd.DataFrame, sensor_categories: list[int]) -> pd.DataFrame:
    inputs = frame.loc[:, list(REFERENCE_FEATURES)].copy()
    inputs.insert(
        0,
        "sensor_id",
        pd.Categorical(frame["sensor_id"], categories=sensor_categories),
    )
    return inputs[list(FEATURE_NAMES)]


def reference_mean_baseline(frame: pd.DataFrame) -> np.ndarray:
    """Average of whichever references are available (a no-model baseline)."""
    return frame.loc[:, list(REFERENCE_FEATURES)].mean(axis=1, skipna=True).to_numpy()


def availability_patterns(frame: pd.DataFrame) -> np.ndarray:
    """Label each row by which references it has, e.g. ``"day+week"``."""
    short_names = [
        name.removeprefix("previous_").removesuffix("_speed")
        for name in REFERENCE_FEATURES
    ]
    available = frame.loc[:, list(REFERENCE_FEATURES)].notna().to_numpy()
    codes = available @ (1 << np.arange(len(REFERENCE_FEATURES)))
    labels = np.array(
        [
            "+".join(n for bit, n in enumerate(short_names) if code >> bit & 1)
            for code in range(1 << len(REFERENCE_FEATURES))
        ]
    )
    return labels[codes]


def fit_xgboost(train_x, train_y, valid_x, valid_y, args):
    model = XGBRegressor(
        objective="reg:squarederror",
        eval_metric="rmse",
        n_estimators=args.estimators,
        learning_rate=0.05,
        max_depth=8,
        max_bin=256,
        subsample=0.8,
        colsample_bytree=0.8,
        tree_method="hist",
        enable_categorical=True,
        early_stopping_rounds=args.early_stopping_rounds,
        n_jobs=args.threads,
        random_state=42,
    )
    model.fit(train_x, train_y, eval_set=[(valid_x, valid_y)], verbose=50)
    return model, getattr(model, "best_iteration", None), model.predict(valid_x)


def fit_catboost(train_x, train_y, valid_x, valid_y, args):
    model = CatBoostRegressor(
        iterations=args.estimators,
        depth=8,
        learning_rate=0.05,
        loss_function="RMSE",
        eval_metric="RMSE",
        random_seed=42,
        thread_count=args.threads,
        allow_writing_files=False,
        verbose=50,
    )
    model.fit(
        train_x,
        train_y,
        cat_features=["sensor_id"],
        eval_set=(valid_x, valid_y),
        early_stopping_rounds=args.early_stopping_rounds,
        use_best_model=True,
    )
    return model, model.get_best_iteration(), model.predict(valid_x)


def fit_lightgbm(train_x, train_y, valid_x, valid_y, args):
    model = LGBMRegressor(
        objective="regression",
        n_estimators=args.estimators,
        learning_rate=0.05,
        num_leaves=63,
        max_bin=255,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=args.threads,
        verbosity=-1,
    )
    model.fit(
        train_x,
        train_y,
        categorical_feature=["sensor_id"],
        eval_X=valid_x,
        eval_y=valid_y,
        eval_metric="rmse",
        callbacks=[
            early_stopping(args.early_stopping_rounds, verbose=True),
            log_evaluation(50),
        ],
    )
    prediction = model.predict(valid_x, num_iteration=model.best_iteration_)
    return model, model.best_iteration_, prediction


def save_model(name: str, model: Any, output_dir: Path) -> None:
    path = output_dir / MODEL_FILES[name]
    if name == "lightgbm":
        model.booster_.save_model(str(path))
    else:
        model.save_model(path)


def run() -> int:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()

    with connect() as connection:
        frame, sensor_categories = load_examples(connection)
    if args.sample_fraction < 1:
        frame = frame.sample(frac=args.sample_fraction, random_state=42)
    frame = frame.sort_values(["observed_at_us", "sensor_id"], ignore_index=True)
    print(
        f"Loaded {len(frame):,} examples for {frame['sensor_id'].nunique()} "
        f"sensors in {time.monotonic() - started:.1f}s.",
        flush=True,
    )

    start_us = int(frame["observed_at_us"].iloc[0])
    end_us = int(frame["observed_at_us"].iloc[-1])
    five_minutes_us = 5 * 60 * 1_000_000
    cutoff_us = start_us + int((end_us - start_us) * (1 - args.validation_fraction))
    cutoff_us -= cutoff_us % five_minutes_us
    train_mask = (frame["observed_at_us"] < cutoff_us).to_numpy()
    if train_mask.all() or not train_mask.any():
        raise RuntimeError("Chronological train/validation split is empty.")
    cutoff = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(microseconds=cutoff_us)

    train, valid = frame[train_mask], frame[~train_mask]
    train_x, valid_x = (model_inputs(part, sensor_categories) for part in (train, valid))
    train_y, valid_y = train["speed"].to_numpy(), valid["speed"].to_numpy()
    valid_patterns = availability_patterns(valid)
    print(
        f"Training on {len(train):,} examples; validating on {len(valid):,} "
        f"from {cutoff.isoformat()}.",
        flush=True,
    )

    def scored(prediction: np.ndarray) -> dict[str, Any]:
        by_pattern = {
            pattern: {
                "examples": int(mask.sum()),
                **regression_metrics(valid_y[mask], prediction[mask]),
            }
            for pattern in sorted(set(valid_patterns))
            if (mask := valid_patterns == pattern).any()
        }
        return {**regression_metrics(valid_y, prediction), "by_available_references": by_pattern}

    results: dict[str, Any] = {
        "reference_mean_baseline": scored(reference_mean_baseline(valid))
    }
    for name, fit in (
        ("xgboost", fit_xgboost),
        ("catboost", fit_catboost),
        ("lightgbm", fit_lightgbm),
    ):
        print(f"\nTraining {name}...", flush=True)
        model_started = time.monotonic()
        model, best_iteration, prediction = fit(train_x, train_y, valid_x, valid_y, args)
        save_model(name, model, output_dir)
        results[name] = {
            **scored(np.asarray(prediction)),
            "best_iteration": best_iteration,
            "training_seconds": round(time.monotonic() - model_started, 2),
            "model_file": MODEL_FILES[name],
        }
        print(f"{name}: rmse={results[name]['rmse']:.3f} mae={results[name]['mae']:.3f}", flush=True)

    def coverage(part: pd.DataFrame) -> dict[str, int]:
        return {name: int(part[name].notna().sum()) for name in REFERENCE_FEATURES}

    report = {
        "forecast_type": FORECAST_TYPE,
        "target": "speed at sensor and timestamp",
        "features": list(FEATURE_NAMES),
        "reference_offsets": {
            "previous_day_speed": "1 day",
            "previous_week_speed": "7 days",
            "previous_year_speed": "1 calendar year (Feb 29 -> Feb 28)",
        },
        "sensor_categories": sensor_categories,
        "validation_strategy": "chronological holdout",
        "validation_fraction": args.validation_fraction,
        "validation_start_utc": cutoff.isoformat(),
        "sample_fraction": args.sample_fraction,
        "training_examples": int(len(train)),
        "validation_examples": int(len(valid)),
        "reference_coverage": {"train": coverage(train), "validation": coverage(valid)},
        "estimators_requested": args.estimators,
        "models": results,
        "model_files": MODEL_FILES,
        "total_seconds": round(time.monotonic() - started, 2),
    }
    (output_dir / METRICS_FILE).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved models and {METRICS_FILE} to {output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except KeyboardInterrupt:
        print("\nTraining interrupted.", file=sys.stderr)
        raise SystemExit(130)
