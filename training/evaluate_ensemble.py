#!/usr/bin/env python3
"""Evaluate the three reference models on a held-out CSV and fit ensemble weights.

The CSV is in the PEMS-BAY wide layout: one column per sensor ID plus a
timestamp column (``Unnamed: 0``), one row per five-minute slot. Features for
each (sensor, timestamp) are read from PostgreSQL exactly as at prediction
time (previous-day, previous-week and previous-year speeds), so test days need
not be in the database themselves.

The ensemble is a weighted mean of the three model predictions. The weights
are the non-negative coefficients summing to 1 that minimise squared error
on the test data. Because that fit uses the test data, the weights are also
scored with time-blocked cross-validation (fit on some blocks of the day,
score on the held-out block) for an out-of-sample estimate.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from training.db import connect
from training.predict_speed import load_models
from training.reference_features import (
    FEATURE_NAMES,
    MAX_VALID_SPEED,
    REFERENCE_FEATURES,
    reference_timestamps,
    to_utc,
)

MODEL_NAMES = ("xgboost", "catboost", "lightgbm")
ENSEMBLE_FILE = "ensemble_weights.json"
CV_FOLDS = 6


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("csv", type=Path, help="Wide test CSV (sensors as columns).")
    parser.add_argument("--artifacts-dir", type=Path, default=Path("model_artifacts"))
    return parser.parse_args()


def load_test_csv(path: Path) -> pd.DataFrame:
    """Return long-format rows: sensor_id, observed_at (UTC), speed."""
    wide = pd.read_csv(path)
    time_column = "Unnamed: 0" if "Unnamed: 0" in wide.columns else wide.columns[-1]
    wide[time_column] = pd.to_datetime(wide[time_column], utc=True)
    long = wide.melt(id_vars=time_column, var_name="sensor_id", value_name="speed")
    long = long.rename(columns={time_column: "observed_at"})
    long["sensor_id"] = long["sensor_id"].astype(int)
    long["speed"] = pd.to_numeric(long["speed"], errors="coerce")
    valid = long["speed"].between(0, MAX_VALID_SPEED)
    return long[valid].reset_index(drop=True)


def attach_references(frame: pd.DataFrame) -> pd.DataFrame:
    """Add previous-day/week/year speeds from PostgreSQL for each row."""
    timestamps = sorted(frame["observed_at"].unique())
    lookups = {
        name: {to_utc(ts.to_pydatetime()): reference_timestamps(ts.to_pydatetime())[name]
               for ts in timestamps}
        for name in REFERENCE_FEATURES
    }
    needed = sorted({ts for mapping in lookups.values() for ts in mapping.values()})
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            "SELECT sensor_id, observed_at, speed FROM observations WHERE observed_at = ANY(%s)",
            (needed,),
        )
        rows = cursor.fetchall()
    history = {(int(s), to_utc(t)): float(v) for s, t, v in rows}

    def lookup(sensor_id: int, ts: pd.Timestamp, name: str) -> float:
        value = history.get((sensor_id, lookups[name][to_utc(ts.to_pydatetime())]))
        if value is None or not np.isfinite(value) or not 0 <= value <= MAX_VALID_SPEED:
            return np.nan
        return value

    out = frame.copy()
    for name in REFERENCE_FEATURES:
        out[name] = np.array(
            [lookup(s, t, name) for s, t in zip(out["sensor_id"], out["observed_at"])],
            dtype=np.float32,
        )
    has_any = out[list(REFERENCE_FEATURES)].notna().any(axis=1)
    return out[has_any].reset_index(drop=True)


def metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    error = predicted - actual
    ss_res = float(np.sum(error**2))
    ss_tot = float(np.sum((actual - actual.mean()) ** 2))
    return {
        "rmse": float(np.sqrt(np.mean(error**2))),
        "mae": float(np.mean(np.abs(error))),
        "mape": float(np.mean(np.abs(error) / np.maximum(actual, 1.0)) * 100),
        "r2": 1 - ss_res / ss_tot if ss_tot else float("nan"),
        "bias": float(np.mean(error)),
    }


def fit_weights(predictions: np.ndarray, actual: np.ndarray) -> np.ndarray:
    """Least-squares weights constrained to w >= 0 and sum(w) = 1."""
    count = predictions.shape[1]

    def loss(w: np.ndarray) -> float:
        return float(np.mean((predictions @ w - actual) ** 2))

    def grad(w: np.ndarray) -> np.ndarray:
        return 2 * predictions.T @ (predictions @ w - actual) / len(actual)

    result = minimize(
        loss,
        np.full(count, 1 / count),
        jac=grad,
        method="SLSQP",
        bounds=[(0.0, 1.0)] * count,
        constraints=[{"type": "eq", "fun": lambda w: w.sum() - 1}],
        options={"ftol": 1e-12, "maxiter": 500},
    )
    if not result.success:
        raise RuntimeError(f"Weight optimisation failed: {result.message}")
    weights = np.clip(result.x, 0, None)
    return weights / weights.sum()


def cross_validated(predictions: np.ndarray, actual: np.ndarray, times: np.ndarray) -> dict:
    """Fit weights on all but one contiguous block of the day; score that block."""
    unique = np.sort(np.unique(times))
    blocks = np.array_split(unique, CV_FOLDS)
    ensemble = np.empty_like(actual)
    fold_weights = []
    for block in blocks:
        test = np.isin(times, block)
        w = fit_weights(predictions[~test], actual[~test])
        fold_weights.append(w.tolist())
        ensemble[test] = predictions[test] @ w
    return {"folds": CV_FOLDS, "metrics": metrics(actual, ensemble), "fold_weights": fold_weights}


def run() -> int:
    args = parse_args()
    artifacts_dir = args.artifacts_dir.resolve()
    models, model_metrics = load_models(artifacts_dir)

    test = attach_references(load_test_csv(args.csv))
    if test.empty:
        raise RuntimeError("No test row has a previous-day, week or year reference in the database.")
    frame = test.loc[:, list(REFERENCE_FEATURES)].copy()
    frame.insert(0, "sensor_id", pd.Categorical(test["sensor_id"], categories=model_metrics["sensor_categories"]))
    frame = frame[list(FEATURE_NAMES)]

    actual = test["speed"].to_numpy(dtype=np.float64)
    predictions = np.column_stack(
        [np.asarray(models[name].predict(frame), dtype=np.float64) for name in MODEL_NAMES]
    )
    weights = fit_weights(predictions, actual)
    weighted = predictions @ weights
    equal = predictions.mean(axis=1)
    baseline = test[list(REFERENCE_FEATURES)].mean(axis=1, skipna=True).to_numpy()

    per_model = {name: metrics(actual, predictions[:, i]) for i, name in enumerate(MODEL_NAMES)}
    best = min(per_model, key=lambda name: per_model[name]["rmse"])

    # Average speed across sensors for each five-minute slot, for the chart.
    series = pd.DataFrame({"t": test["observed_at"], "actual": actual, "weighted": weighted,
                           **{name: predictions[:, i] for i, name in enumerate(MODEL_NAMES)}})
    by_time = series.groupby("t").mean().reset_index()
    timeline = [
        {"timestamp": row.t.isoformat(), "actual": round(row.actual, 2),
         "weighted": round(row.weighted, 2),
         **{name: round(getattr(row, name), 2) for name in MODEL_NAMES}}
        for row in by_time.itertuples()
    ]

    report = {
        "test_file": args.csv.name,
        "test_start": test["observed_at"].min().isoformat(),
        "test_end": test["observed_at"].max().isoformat(),
        "test_examples": int(len(test)),
        "test_sensors": int(test["sensor_id"].nunique()),
        "reference_coverage": {name: int(test[name].notna().sum()) for name in REFERENCE_FEATURES},
        "models": per_model,
        "best_model": best,
        "weights": {name: float(w) for name, w in zip(MODEL_NAMES, weights)},
        "weighting_method": "Least-squares weights constrained to be non-negative and sum to 1, fitted on the test data",
        "weighted_ensemble": metrics(actual, weighted),
        "weighted_ensemble_cross_validated": cross_validated(predictions, actual, test["observed_at"].to_numpy()),
        "equal_mean_ensemble": metrics(actual, equal),
        "reference_mean_baseline": metrics(actual, baseline),
        "timeline": timeline,
    }
    out = artifacts_dir / ENSEMBLE_FILE
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"Test rows: {len(test):,} ({report['test_sensors']} sensors, "
          f"{report['test_start']} → {report['test_end']})")
    for name in MODEL_NAMES:
        m = per_model[name]
        print(f"  {name:9s} RMSE {m['rmse']:.3f}  MAE {m['mae']:.3f}  R² {m['r2']:.4f}")
    for label, key in (("weighted", "weighted_ensemble"), ("equal mean", "equal_mean_ensemble"),
                       ("ref. mean", "reference_mean_baseline")):
        m = report[key]
        print(f"  {label:10s} RMSE {m['rmse']:.3f}  MAE {m['mae']:.3f}  R² {m['r2']:.4f}")
    cv = report["weighted_ensemble_cross_validated"]["metrics"]
    print(f"  weighted (CV) RMSE {cv['rmse']:.3f}  MAE {cv['mae']:.3f}")
    print("Weights:", {k: round(v, 4) for k, v in report["weights"].items()})
    print(f"Best single model: {best}. Saved {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
