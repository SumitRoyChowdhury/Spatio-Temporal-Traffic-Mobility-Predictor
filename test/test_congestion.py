import math
import unittest

from training.congestion import (
    CongestionCategory,
    CongestionThresholds,
    classify_speed,
)


class CongestionClassificationTest(unittest.TestCase):
    def test_required_exact_values(self):
        """Test all exact values specified in the task requirements table."""
        cases = [
            (65, CongestionCategory.FREE_FLOW),
            (51, CongestionCategory.FREE_FLOW),
            (50, CongestionCategory.MODERATE_TRAFFIC),
            (35, CongestionCategory.MODERATE_TRAFFIC),
            (25, CongestionCategory.MODERATE_TRAFFIC),
            (24, CongestionCategory.HEAVY_CONGESTION),
            (20, CongestionCategory.HEAVY_CONGESTION),
            (0, CongestionCategory.HEAVY_CONGESTION),
            (None, CongestionCategory.INSUFFICIENT_DATA),
            (math.nan, CongestionCategory.INSUFFICIENT_DATA),
            (math.inf, CongestionCategory.INSUFFICIENT_DATA),
            (-math.inf, CongestionCategory.INSUFFICIENT_DATA),
        ]

        for speed, expected in cases:
            with self.subTest(speed=speed, expected=expected):
                self.assertEqual(classify_speed(speed), expected)

    def test_boundary_conditions(self):
        """Verify strict boundary rules:

        - Speed > 50: FREE FLOW
        - Speed >= 25 and <= 50: MODERATE TRAFFIC
        - Speed < 25: HEAVY CONGESTION
        """
        self.assertEqual(classify_speed(50.0001), CongestionCategory.FREE_FLOW)
        self.assertEqual(classify_speed(50.0), CongestionCategory.MODERATE_TRAFFIC)
        self.assertEqual(classify_speed(49.999), CongestionCategory.MODERATE_TRAFFIC)
        self.assertEqual(classify_speed(25.0), CongestionCategory.MODERATE_TRAFFIC)
        self.assertEqual(classify_speed(24.999), CongestionCategory.HEAVY_CONGESTION)

    def test_invalid_types_return_insufficient_data(self):
        """Verify non-numeric or unparseable inputs return INSUFFICIENT DATA."""
        self.assertEqual(classify_speed("invalid"), CongestionCategory.INSUFFICIENT_DATA)
        self.assertEqual(classify_speed([]), CongestionCategory.INSUFFICIENT_DATA)
        self.assertEqual(classify_speed({}), CongestionCategory.INSUFFICIENT_DATA)

    def test_configurable_thresholds(self):
        """Verify custom threshold configuration is respected."""
        custom = CongestionThresholds(free_flow_min=60.0, moderate_min=30.0)
        self.assertEqual(classify_speed(55.0, thresholds=custom), CongestionCategory.MODERATE_TRAFFIC)
        self.assertEqual(classify_speed(61.0, thresholds=custom), CongestionCategory.FREE_FLOW)
        self.assertEqual(classify_speed(28.0, thresholds=custom), CongestionCategory.HEAVY_CONGESTION)

    def test_predict_integration(self):
        """Verify predict() includes congestion classifications in its result."""
        from datetime import datetime, timedelta, timezone
        from pathlib import Path
        import numpy as np
        from test_reference_models import FakeConnection, RecordingModel
        from training.predict_speed import predict

        target = datetime(2017, 5, 10, 8, 30, tzinfo=timezone.utc)
        stored = {
            target - timedelta(days=1): 65.0,
            target - timedelta(days=7): 35.0,
            target: 60.0,
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

        self.assertIn("congestion_by_model", result)
        self.assertIn("overall_congestion", result)
        # Average of 65 and 35 is 50 -> MODERATE TRAFFIC
        self.assertEqual(result["overall_congestion"], CongestionCategory.MODERATE_TRAFFIC)
        self.assertEqual(result["congestion_by_model"]["xgboost"], CongestionCategory.MODERATE_TRAFFIC)


if __name__ == "__main__":
    unittest.main()
