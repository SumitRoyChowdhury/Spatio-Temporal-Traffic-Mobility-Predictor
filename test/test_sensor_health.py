"""Unit and integration tests for Real-Time Sensor Health Monitoring System."""

import unittest
from datetime import datetime, timedelta, timezone

from training.sensor_health import (
    AlertSeverity,
    AlertType,
    SensorHealthService,
    SensorStatus,
    calculate_data_quality,
    calculate_missing_percentage,
    calculate_uptime,
    determine_sensor_status,
)

UTC = timezone.utc


class TestSensorHealthDetection(unittest.TestCase):
    """Test core sensor status calculation and threshold logic."""

    def setUp(self):
        self.ref_time = datetime(2017, 5, 31, 23, 55, 0, tzinfo=UTC)
        self.exp_interval = 300       # 5m
        self.delayed_thresh = 900     # 15m
        self.offline_thresh = 1800    # 30m

    def test_sensor_online_detection(self):
        """Sensor within expected reporting interval is ONLINE."""
        last_rec = self.ref_time - timedelta(seconds=120)  # 2m ago
        status = determine_sensor_status(
            last_rec, self.ref_time, self.exp_interval, self.delayed_thresh, self.offline_thresh
        )
        self.assertEqual(status, SensorStatus.ONLINE)

    def test_sensor_delayed_detection(self):
        """Sensor past expected interval but within delayed threshold is DELAYED."""
        last_rec = self.ref_time - timedelta(seconds=600)  # 10m ago (between 5m and 15m)
        status = determine_sensor_status(
            last_rec, self.ref_time, self.exp_interval, self.delayed_thresh, self.offline_thresh
        )
        self.assertEqual(status, SensorStatus.DELAYED)

    def test_sensor_offline_detection(self):
        """Sensor past delayed threshold is OFFLINE."""
        last_rec = self.ref_time - timedelta(seconds=2400)  # 40m ago
        status = determine_sensor_status(
            last_rec, self.ref_time, self.exp_interval, self.delayed_thresh, self.offline_thresh
        )
        self.assertEqual(status, SensorStatus.OFFLINE)

    def test_sensor_inactive_state(self):
        """Deactivated sensor returns NOT_ACTIVE regardless of timestamp."""
        status = determine_sensor_status(
            self.ref_time, self.ref_time, is_active=False
        )
        self.assertEqual(status, SensorStatus.NOT_ACTIVE)

    def test_sensor_never_transmitted(self):
        """Sensor with no transmission timestamp returns OFFLINE."""
        status = determine_sensor_status(None, self.ref_time, is_active=True)
        self.assertEqual(status, SensorStatus.OFFLINE)

    def test_sensor_future_timestamp(self):
        """Sensor reporting timestamp ahead of reference time remains ONLINE."""
        last_rec = self.ref_time + timedelta(seconds=60)
        status = determine_sensor_status(last_rec, self.ref_time)
        self.assertEqual(status, SensorStatus.ONLINE)


class TestSensorMetricsCalculations(unittest.TestCase):
    """Test data quality, missing percentage, and uptime formulas."""

    def test_data_quality_calculation(self):
        self.assertEqual(calculate_data_quality(288, 288), 100.0)
        self.assertEqual(calculate_data_quality(144, 288), 50.0)
        self.assertEqual(calculate_data_quality(0, 288), 0.0)
        self.assertEqual(calculate_data_quality(0, 0), 0.0)
        # Clamped within [0, 100]
        self.assertEqual(calculate_data_quality(300, 288), 100.0)

    def test_missing_percentage_calculation(self):
        self.assertEqual(calculate_missing_percentage(0, 288), 0.0)
        self.assertEqual(calculate_missing_percentage(72, 288), 25.0)
        self.assertEqual(calculate_missing_percentage(288, 288), 100.0)

    def test_uptime_calculation(self):
        self.assertEqual(calculate_uptime(288, 288), 100.0)
        self.assertEqual(calculate_uptime(216, 288), 75.0)
        self.assertEqual(calculate_uptime(0, 288), 0.0)


class TestSensorHealthServiceIntegration(unittest.TestCase):
    """Integration tests connecting to actual PostgreSQL database."""

    @classmethod
    def setUpClass(cls):
        cls.service = SensorHealthService()

    def test_health_summary(self):
        summary = self.service.get_sensor_health_summary()
        self.assertIn("total_sensors", summary)
        self.assertIn("online_sensors", summary)
        self.assertIn("delayed_sensors", summary)
        self.assertIn("offline_sensors", summary)
        self.assertIn("average_data_quality", summary)
        self.assertIn("overall_uptime", summary)
        self.assertEqual(summary["total_sensors"], 325)

    def test_all_sensors_pagination_and_search(self):
        res = self.service.get_all_sensors(limit=10, page=1)
        self.assertEqual(len(res["sensors"]), 10)
        self.assertEqual(res["total"], 325)
        self.assertGreaterEqual(res["total_pages"], 32)

        # Search test
        search_res = self.service.get_all_sensors(search="400001")
        self.assertEqual(search_res["total"], 1)
        self.assertEqual(search_res["sensors"][0]["sensor_id"], 400001)

    def test_sensor_details(self):
        detail = self.service.get_sensor_details(400001)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["sensor_id"], 400001)
        self.assertIn("metrics_24h", detail)
        self.assertIn("uptime", detail)
        self.assertIn("latitude", detail)
        self.assertIn("longitude", detail)
        self.assertGreater(detail["metrics_24h"]["data_quality_pct"], 90.0)

    def test_sensor_history(self):
        history = self.service.get_sensor_history(400001, days=7)
        self.assertIsInstance(history, list)
        self.assertGreater(len(history), 0)
        self.assertIn("data_quality", history[0])
        self.assertIn("uptime", history[0])

    def test_sensor_readings(self):
        readings = self.service.get_sensor_readings(400001, limit=5)
        self.assertIsInstance(readings, list)
        self.assertEqual(len(readings), 5)
        self.assertIn("observed_at", readings[0])
        self.assertIn("speed", readings[0])

    def test_alerts_and_resolution(self):
        alerts_res = self.service.get_alerts()
        self.assertIn("alerts", alerts_res)
        self.assertIn("total", alerts_res)

        if alerts_res["alerts"]:
            alert_id = alerts_res["alerts"][0]["id"]
            resolved = self.service.resolve_alert(alert_id)
            self.assertTrue(resolved["is_resolved"])

    def test_update_sensor_config(self):
        updated = self.service.update_sensor_config(400001, delayed_threshold=1500)
        self.assertEqual(updated["delayed_threshold"], 1500)
        # Restore default
        self.service.update_sensor_config(400001, delayed_threshold=900)

    def test_monitoring_cycle(self):
        result = self.service.run_monitoring_cycle()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["sensors_checked"], 325)


if __name__ == "__main__":
    unittest.main()
