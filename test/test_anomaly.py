"""Tests for traffic anomaly detection.
"""
import unittest
from training.anomaly import detect_anomaly, DEFAULT_THRESHOLDS

class TestAnomalyDetection(unittest.TestCase):
    def test_no_historical(self):
        detected, severity, a_type, explanation = detect_anomaly([], 30)
        self.assertFalse(detected)
        self.assertEqual(severity, "")
        self.assertIn("Insufficient historical data", explanation)

    def test_normal_speed(self):
        hist = [30, 32, 31, 29, 30]
        detected, severity, a_type, explanation = detect_anomaly(hist, 31)
        self.assertFalse(detected)
        self.assertIn("within normal variation", explanation)

    def test_speed_drop_low(self):
        hist = [40, 42, 41, 39, 40]
        detected, severity, a_type, explanation = detect_anomaly(hist, 35)
        self.assertTrue(detected)
        self.assertEqual(severity, "LOW")
        self.assertEqual(a_type, "speed_drop")

    def test_speed_spike_high(self):
        hist = [20, 22, 21, 19, 20]
        detected, severity, a_type, explanation = detect_anomaly(hist, 40)
        self.assertTrue(detected)
        self.assertEqual(severity, "HIGH")
        self.assertEqual(a_type, "speed_spike")

    def test_invalid_current(self):
        hist = [30, 31, 32]
        detected, severity, a_type, explanation = detect_anomaly(hist, None)
        self.assertFalse(detected)
        self.assertIn("Current speed is missing", explanation)

if __name__ == "__main__":
    unittest.main()
