#!/usr/bin/env python3
"""Predict traffic speed for a sensor at a timestamp from historical references.

The prediction uses the same sensor's speed at the same timestamp one day,
one week and one year earlier, read from PostgreSQL. Missing references are
passed to the models as missing values, so whatever is available is used. If
none of the three exists, no prediction is made and the shortfall is logged.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd
from dotenv import load_dotenv

from training.reference_features import (
    FEATURE_NAMES,
    FORECAST_TYPE,
    INSUFFICIENT_DATA_MESSAGE,
    METRICS_FILE,
    REFERENCE_FEATURES,
    align_to_sampling_grid,
    reference_timestamps,
    to_utc,
    valid_speed,
)

load_dotenv()

LOGGER = logging.getLogger("gridlock.predict_speed")
EXIT_INSUFFICIENT_DATA = 3


class InsufficientDataError(RuntimeError):
    """None of the historical references needed for a prediction exists."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sensor-id", type=int, required=True)
    parser.add_argument(
        "--timestamp",
        required=True,
        help="ISO-8601 timestamp; without an offset it is treated as UTC.",
    )
    parser.add_argument("--artifacts-dir", type=Path, default=Path("model_artifacts"))
    return parser.parse_args()


def parse_timestamp(value: str) -> datetime:
    try:
        return to_utc(datetime.fromisoformat(value.strip().replace("Z", "+00:00")))
    except ValueError as error:
        raise ValueError(f"Timestamp must be a valid ISO-8601 datetime: {value!r}") from error


def fetch_speeds(
    connection, sensor_id: int, timestamps: list[datetime]
) -> tuple[bool, dict[datetime, float]]:
    """Return whether the sensor exists, and its stored speeds at ``timestamps``."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM sensors WHERE sensor_id = %s", (sensor_id,))
        if cursor.fetchone() is None:
            return False, {}
        cursor.execute(
            """
            SELECT observed_at, speed
            FROM observations
            WHERE sensor_id = %s AND observed_at = ANY(%s)
            """,
            (sensor_id, timestamps),
        )
        return True, {to_utc(observed_at): speed for observed_at, speed in cursor.fetchall()}


def load_models(artifacts_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    from catboost import CatBoostRegressor
    from lightgbm import Booster
    from xgboost import XGBRegressor

    metrics_path = artifacts_dir / METRICS_FILE
    if not metrics_path.is_file():
        raise FileNotFoundError(
            f"Reference models are not trained (missing {metrics_path}). Run "
            "./.venv/bin/python -m training.train_reference_models first."
        )
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    if metrics.get("forecast_type") != FORECAST_TYPE:
        raise ValueError(f"{metrics_path} does not describe historical-reference models.")
    if metrics.get("features") != list(FEATURE_NAMES):
        raise ValueError("Trained model features do not match the prediction features.")
    files = metrics["model_files"]
    xgboost = XGBRegressor()
    xgboost.load_model(artifacts_dir / files["xgboost"])
    catboost = CatBoostRegressor()
    catboost.load_model(artifacts_dir / files["catboost"])
    lightgbm = Booster(model_file=str(artifacts_dir / files["lightgbm"]))
    return {"xgboost": xgboost, "catboost": catboost, "lightgbm": lightgbm}, metrics


def predict(
    sensor_id: int,
    requested_timestamp: datetime,
    artifacts_dir: Path,
    *,
    connection_factory: Callable[[], Any] | None = None,
    model_loader: Callable[[Path], tuple[dict[str, Any], dict[str, Any]]] = load_models,
) -> dict[str, object]:
    if connection_factory is None:
        from training.db import connect as connection_factory

    target = align_to_sampling_grid(requested_timestamp)
    lookups = reference_timestamps(target)
    with connection_factory() as connection:
        sensor_exists, speeds = fetch_speeds(
            connection, sensor_id, [*lookups.values(), target]
        )
    if not sensor_exists:
        raise ValueError(f"Unknown sensor ID: {sensor_id}")

    references = {name: valid_speed(speeds.get(ts)) for name, ts in lookups.items()}
    result: dict[str, object] = {
        "sensor_id": sensor_id,
        "requested_timestamp": to_utc(requested_timestamp).isoformat(),
        "target_timestamp": target.isoformat(),
        "references": {
            name: {"timestamp": lookups[name].isoformat(), "speed": references[name]}
            for name in REFERENCE_FEATURES
        },
        "references_used": [name for name, speed in references.items() if speed is not None],
    }
    if not result["references_used"]:
        message = (
            f"{INSUFFICIENT_DATA_MESSAGE}: sensor {sensor_id} has no previous-day, "
            f"previous-week or previous-year speed for {target.isoformat()}."
        )
        LOGGER.warning(message)
        raise InsufficientDataError(message)

    models, metrics = model_loader(artifacts_dir)
    row = {
        "sensor_id": pd.Categorical([sensor_id], categories=metrics["sensor_categories"]),
        **{
            name: np.array([np.nan if speed is None else speed], dtype=np.float32)
            for name, speed in references.items()
        },
    }
    frame = pd.DataFrame(row)[list(FEATURE_NAMES)]
    predictions = {name: float(model.predict(frame)[0]) for name, model in models.items()}
    if not all(math.isfinite(value) for value in predictions.values()):
        raise RuntimeError("A model returned a non-finite speed prediction.")

    result["predicted_speed_by_model"] = predictions
    result["mean_predicted_speed"] = float(np.mean(list(predictions.values())))
    # When the target time is already in the database (e.g. a historical
    # check), report the recorded value alongside the predictions.
    result["actual_speed"] = valid_speed(speeds.get(target))
    return result


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = parse_args()
    try:
        result = predict(
            args.sensor_id, parse_timestamp(args.timestamp), args.artifacts_dir.resolve()
        )
    except InsufficientDataError:
        return EXIT_INSUFFICIENT_DATA
    except (ValueError, FileNotFoundError, RuntimeError) as error:
        LOGGER.error("%s", error)
        return 2
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
