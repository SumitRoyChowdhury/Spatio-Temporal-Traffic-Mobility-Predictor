"""Comprehensive tests for traffic anomaly detection.

Covers: normal traffic, speed drops, speed spikes, LOW/MEDIUM/HIGH severity,
zero MAD, missing/invalid data, insufficient historical data, and API
response compatibility.
"""
import math
import unittest
from training.anomaly import detect_anomaly, AnomalyThresholds, DEFAULT_THRESHOLDS


class TestNormalTraffic(unittest.TestCase):
    """Speed within normal variation → no anomaly."""

    def test_normal_speed(self):
        hist = [30, 32, 31, 29, 30]
        detected, severity, a_type, explanation = detect_anomaly(hist, 31)
        self.assertFalse(detected)
        self.assertEqual(severity, "")
        self.assertEqual(a_type, "")
        self.assertIn("within normal variation", explanation)

    def test_normal_speed_exact_median(self):
        hist = [50, 50, 50, 50, 50]
        detected, _, _, _ = detect_anomaly(hist, 50)
        self.assertFalse(detected)


class TestSpeedDrop(unittest.TestCase):
    """Current speed below the historical median → speed_drop."""

    def test_sudden_speed_drop(self):
        hist = [60, 62, 61, 59, 60]
        detected, severity, a_type, explanation = detect_anomaly(hist, 45)
        self.assertTrue(detected)
        self.assertEqual(a_type, "speed_drop")
        self.assertIn("deviates", explanation)

    def test_moderate_speed_drop(self):
        hist = [40, 42, 41, 39, 40]
        detected, severity, a_type, _ = detect_anomaly(hist, 32)
        self.assertTrue(detected)
        self.assertEqual(a_type, "speed_drop")


class TestSpeedSpike(unittest.TestCase):
    """Current speed above the historical median → speed_spike."""

    def test_unusual_speed_increase(self):
        hist = [20, 22, 21, 19, 20]
        detected, severity, a_type, explanation = detect_anomaly(hist, 35)
        self.assertTrue(detected)
        self.assertEqual(a_type, "speed_spike")
        self.assertIn("deviates", explanation)


class TestSeverityLevels(unittest.TestCase):
    """Verify LOW, MEDIUM and HIGH severity classifications."""

    def test_low_severity(self):
        # hist = [35,38,40,42,45] → median=40, MAD=2
        # speed=44 → dev=4, ratio=2.0 → LOW (>1.5, <3.0)
        hist = [35, 38, 40, 42, 45]
        detected, severity, _, _ = detect_anomaly(hist, 44)
        self.assertTrue(detected)
        self.assertEqual(severity, "LOW")

    def test_medium_severity(self):
        # speed=47 → dev=7, ratio=3.5 → MEDIUM (>3.0, <5.0)
        hist = [35, 38, 40, 42, 45]
        detected, severity, _, _ = detect_anomaly(hist, 47)
        self.assertTrue(detected)
        self.assertEqual(severity, "MEDIUM")

    def test_high_severity(self):
        # speed=52 → dev=12, ratio=6.0 → HIGH (>5.0)
        hist = [35, 38, 40, 42, 45]
        detected, severity, _, _ = detect_anomaly(hist, 52)
        self.assertTrue(detected)
        self.assertEqual(severity, "HIGH")


class TestZeroMAD(unittest.TestCase):
    """All historical speeds identical → MAD = 0 (uses floor to prevent false HIGH)."""

    def test_zero_mad_tiny_difference_not_anomalous(self):
        # All historical speeds are 50. Current speed is 50.1 mph.
        # With zero MAD protection, 0.1 mph is within normal variation, not a false HIGH.
        hist = [50, 50, 50, 50, 50]
        detected, severity, a_type, explanation = detect_anomaly(hist, 50.1)
        self.assertFalse(detected)
        self.assertEqual(severity, "")
        self.assertIn("within normal variation", explanation)

    def test_zero_mad_significant_difference_detected(self):
        # All historical speeds are 50. Current speed is 58 mph (8 mph deviation).
        # This is a genuine anomaly with ratio = 8.0 / 1.0 = 8.0 > 5.0 -> HIGH.
        hist = [50, 50, 50, 50, 50]
        detected, severity, a_type, explanation = detect_anomaly(hist, 58)
        self.assertTrue(detected)
        self.assertEqual(severity, "HIGH")
        self.assertEqual(a_type, "speed_spike")

    def test_zero_mad_exact_match(self):
        hist = [50, 50, 50, 50]
        detected, _, _, _ = detect_anomaly(hist, 50)
        self.assertFalse(detected)


class TestMissingHistoricalData(unittest.TestCase):
    """Empty or all-None historical list → insufficient data."""

    def test_empty_list(self):
        detected, severity, a_type, explanation = detect_anomaly([], 30)
        self.assertFalse(detected)
        self.assertEqual(severity, "")
        self.assertIn("Insufficient", explanation)

    def test_all_none(self):
        detected, severity, a_type, explanation = detect_anomaly([None, None, None], 30)
        self.assertFalse(detected)
        self.assertIn("Insufficient", explanation)

    def test_all_nan(self):
        detected, _, _, explanation = detect_anomaly([float("nan"), float("nan")], 30)
        self.assertFalse(detected)
        self.assertIn("Insufficient", explanation)


class TestInvalidCurrentSpeed(unittest.TestCase):
    """Invalid or missing current speed."""

    def test_none_current(self):
        detected, _, _, explanation = detect_anomaly([30, 31, 32], None)
        self.assertFalse(detected)
        self.assertIn("Current speed is missing", explanation)

    def test_nan_current(self):
        detected, _, _, explanation = detect_anomaly([30, 31, 32], float("nan"))
        self.assertFalse(detected)
        self.assertIn("Current speed is missing", explanation)

    def test_inf_current(self):
        detected, _, _, explanation = detect_anomaly([30, 31, 32], float("inf"))
        self.assertFalse(detected)
        self.assertIn("Current speed is missing", explanation)

    def test_string_current(self):
        detected, _, _, explanation = detect_anomaly([30, 31, 32], "bad")
        self.assertFalse(detected)
        self.assertIn("Current speed is missing", explanation)


class TestReturnTypes(unittest.TestCase):
    """API response compatibility: all return values are the right types."""

    def test_return_tuple_normal(self):
        detected, severity, a_type, explanation = detect_anomaly([30, 31, 32], 31)
        self.assertIsInstance(detected, bool)
        self.assertIsInstance(severity, str)
        self.assertIsInstance(a_type, str)
        self.assertIsInstance(explanation, str)

    def test_return_tuple_anomaly(self):
        detected, severity, a_type, explanation = detect_anomaly([30, 31, 32], 60)
        self.assertIsInstance(detected, bool)
        self.assertTrue(detected)
        self.assertIn(severity, ("LOW", "MEDIUM", "HIGH"))
        self.assertIn(a_type, ("speed_drop", "speed_spike"))
        self.assertIsInstance(explanation, str)
        self.assertGreater(len(explanation), 0)

    def test_return_tuple_insufficient(self):
        detected, severity, a_type, explanation = detect_anomaly([], 30)
        self.assertFalse(detected)
        self.assertEqual(severity, "")
        self.assertEqual(a_type, "")
        self.assertGreater(len(explanation), 0)


class TestCustomThresholds(unittest.TestCase):
    """Configurable thresholds work correctly."""

    def test_stricter_thresholds(self):
        thresholds = AnomalyThresholds(low=0.5, medium=1.0, high=2.0)
        # hist = [35, 38, 40, 42, 45] -> median = 40, MAD = 2
        # speed = 43 -> dev = 3, ratio = 1.5 -> ratio > 1.0 and <= 2.0 -> MEDIUM
        hist = [35, 38, 40, 42, 45]
        detected, severity, _, _ = detect_anomaly(hist, 43, thresholds)
        self.assertTrue(detected)
        self.assertEqual(severity, "MEDIUM")


class TestMixedHistoricalValues(unittest.TestCase):
    """Historical list with some None / NaN values mixed in."""

    def test_partial_none(self):
        hist = [None, 30, None, 32, 31]
        detected, severity, a_type, explanation = detect_anomaly(hist, 31)
        self.assertFalse(detected)
        self.assertIn("within normal variation", explanation)

    def test_partial_nan(self):
        hist = [float("nan"), 30, 32, float("nan"), 31]
        detected, _, _, explanation = detect_anomaly(hist, 31)
        self.assertFalse(detected)


class TestPredictAnomalyIntegration(unittest.TestCase):
    """Verify predict() includes all anomaly fields in its result."""

    def test_predict_anomaly_fields(self):
        from datetime import datetime, timedelta, timezone
        from pathlib import Path
        from test_reference_models import FakeConnection, RecordingModel
        from training.predict_speed import predict

        target = datetime(2017, 5, 10, 8, 30, tzinfo=timezone.utc)
        stored = {
            target - timedelta(days=1): 65.0,
            target - timedelta(days=7): 64.0,
            target: 65.0,
        }
        model = RecordingModel()

        def loader(_):
            return (
                {"xgboost": model, "catboost": model, "lightgbm": model},
                {"sensor_categories": [400001]},
            )

        result = predict(
            400001,
            target,
            Path("unused"),
            connection_factory=lambda: FakeConnection({400001: stored}),
            model_loader=loader,
        )

        # Check all required anomaly fields exist
        required_fields = [
            "anomaly_detected",
            "anomaly_severity",
            "anomaly_type",
            "anomaly_explanation",
            "anomaly_current_speed",
            "anomaly_historical_median",
            "anomaly_deviation",
            "anomaly_mad",
        ]
        for field in required_fields:
            self.assertIn(field, result, f"Missing required field {field}")

        # Check preserved fields
        self.assertIn("predicted_speed_by_model", result)
        self.assertIn("mean_predicted_speed", result)
        self.assertIn("congestion_by_model", result)
        self.assertIn("overall_congestion", result)

        self.assertIsInstance(result["anomaly_detected"], bool)
        self.assertIsInstance(result["anomaly_explanation"], str)


if __name__ == "__main__":
    unittest.main()
