import math
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from training.predict_speed import InsufficientDataError, parse_timestamp, predict
from training.reference_features import (
    FEATURE_NAMES,
    align_to_sampling_grid,
    reference_timestamps,
    valid_speed,
)
from training.train_reference_models import availability_patterns, reference_mean_baseline

UTC = timezone.utc


class FakeCursor:
    def __init__(self, database):
        self.database = database
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params):
        sensor_id = params[0]
        if "FROM sensors" in query:
            self.rows = [(1,)] if sensor_id in self.database else []
        else:
            stored = self.database.get(sensor_id, {})
            self.rows = [(ts, stored[ts]) for ts in params[1] if ts in stored]

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, database):
        self.database = database

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.database)


class RecordingModel:
    """Predicts the mean of the non-missing references it receives."""

    def __init__(self):
        self.frames = []

    def predict(self, frame):
        self.frames.append(frame)
        values = frame[list(FEATURE_NAMES[1:])].to_numpy(dtype=float)
        return np.nanmean(values, axis=1)


class ReferenceFeatureTest(unittest.TestCase):
    def test_reference_timestamps(self):
        target = datetime(2017, 5, 10, 8, 30, tzinfo=UTC)
        self.assertEqual(
            reference_timestamps(target),
            {
                "previous_day_speed": datetime(2017, 5, 9, 8, 30, tzinfo=UTC),
                "previous_week_speed": datetime(2017, 5, 3, 8, 30, tzinfo=UTC),
                "previous_year_speed": datetime(2016, 5, 10, 8, 30, tzinfo=UTC),
            },
        )
        self.assertEqual(target.weekday(), reference_timestamps(target)["previous_week_speed"].weekday())

    def test_leap_day_uses_february_28_previous_year(self):
        refs = reference_timestamps(datetime(2020, 2, 29, 12, 0, tzinfo=UTC))
        self.assertEqual(refs["previous_year_speed"], datetime(2019, 2, 28, 12, 0, tzinfo=UTC))

    def test_alignment_and_timezones(self):
        self.assertEqual(
            align_to_sampling_grid(datetime(2017, 3, 1, 10, 7, 29, tzinfo=UTC)),
            datetime(2017, 3, 1, 10, 5, tzinfo=UTC),
        )
        self.assertEqual(
            align_to_sampling_grid(datetime(2017, 3, 1, 10, 7, 30, tzinfo=UTC)),
            datetime(2017, 3, 1, 10, 10, tzinfo=UTC),
        )
        self.assertEqual(parse_timestamp("2017-03-01T10:05:00"), datetime(2017, 3, 1, 10, 5, tzinfo=UTC))
        self.assertEqual(parse_timestamp("2017-03-01T02:05:00-08:00"), datetime(2017, 3, 1, 10, 5, tzinfo=UTC))
        with self.assertRaises(ValueError):
            parse_timestamp("not a time")

    def test_valid_speed(self):
        self.assertEqual(valid_speed(0), 0.0)
        self.assertEqual(valid_speed(65.5), 65.5)
        for invalid in (None, math.nan, math.inf, -1, 200.1, "abc"):
            self.assertIsNone(valid_speed(invalid))

    def test_training_helpers(self):
        frame = pd.DataFrame(
            {
                "previous_day_speed": [60.0, np.nan, 50.0],
                "previous_week_speed": [70.0, 40.0, np.nan],
                "previous_year_speed": [np.nan, np.nan, 30.0],
            }
        )
        self.assertEqual(list(availability_patterns(frame)), ["day+week", "week", "day+year"])
        np.testing.assert_allclose(reference_mean_baseline(frame), [65.0, 40.0, 40.0])


class PredictTest(unittest.TestCase):
    target = datetime(2017, 5, 10, 8, 30, tzinfo=UTC)

    def run_predict(self, stored, sensor_id=400001):
        model = RecordingModel()
        loads = []

        def loader(path):
            loads.append(path)
            return (
                {"xgboost": model, "catboost": model, "lightgbm": model},
                {"sensor_categories": [400001, 400017]},
            )

        result = predict(
            sensor_id,
            self.target,
            Path("unused"),
            connection_factory=lambda: FakeConnection({400001: stored}),
            model_loader=loader,
        )
        return result, model, loads

    def test_uses_only_available_references(self):
        stored = {
            self.target - timedelta(days=1): 60.0,
            self.target - timedelta(days=7): math.nan,  # invalid reading
            self.target: 58.0,
        }
        result, model, _ = self.run_predict(stored)
        self.assertEqual(result["references_used"], ["previous_day_speed"])
        self.assertEqual(result["predicted_speed_by_model"]["xgboost"], 60.0)
        self.assertEqual(result["actual_speed"], 58.0)
        frame = model.frames[0]
        self.assertEqual(list(frame.columns), list(FEATURE_NAMES))
        self.assertTrue(np.isnan(frame["previous_week_speed"].iloc[0]))
        self.assertTrue(np.isnan(frame["previous_year_speed"].iloc[0]))
        self.assertEqual(frame["sensor_id"].dtype.name, "category")

    def test_all_references_missing_logs_and_skips_models(self):
        with self.assertLogs("gridlock.predict_speed", "WARNING") as logs:
            with self.assertRaises(InsufficientDataError):
                self.run_predict({self.target: 58.0})
        self.assertIn("Current data is not sufficient to predict the traffic speed", logs.output[0])

    def test_unknown_sensor(self):
        with self.assertRaisesRegex(ValueError, "Unknown sensor"):
            self.run_predict({}, sensor_id=999)


if __name__ == "__main__":
    unittest.main()
