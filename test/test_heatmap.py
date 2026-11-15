import math
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

from training.congestion import (
    CongestionCategory,
    CongestionRatioThresholds,
    classify_congestion_ratio,
)
from training.heatmap import HeatmapService

UTC = timezone.utc


class FakeCursor:
    def __init__(self, database, sensor_meta=None):
        self.database = database
        self.sensor_meta = sensor_meta or {
            400001: {"Name": "Main St", "Fwy": 101, "Dir": "N", "Latitude": 37.35, "Longitude": -121.90, "Abs_PM": 12.5},
            400002: {"Name": "Oak Ave", "Fwy": 880, "Dir": "S", "Latitude": 37.40, "Longitude": -121.95, "Abs_PM": 18.2},
            400003: {"Name": "El Camino", "Fwy": 280, "Dir": "N", "Latitude": 37.45, "Longitude": -122.00, "Abs_PM": 24.1},
        }
        self.configs = {
            400001: (65.0, "Freeway", "mph"),
            400002: (60.0, "Highway", "mph"),
            400003: (45.0, "Arterial", "mph"),
        }
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        if params is None:
            params = []
        q_upper = query.upper()
        if "ALTER TABLE" in q_upper:
            self.rows = []
        elif "FROM SENSORS" in q_upper and "METADATA" in q_upper:
            self.rows = [
                (sid, meta, self.configs[sid][0], self.configs[sid][1], self.configs[sid][2])
                for sid, meta in self.sensor_meta.items()
            ]
        elif "MIN(OBSERVED_AT)" in q_upper:
            self.rows = [(datetime(2017, 1, 1, 0, 0, tzinfo=UTC), datetime(2017, 6, 30, 23, 55, tzinfo=UTC))]
        elif "FROM OBSERVATIONS" in q_upper and "WHERE OBSERVED_AT = %S" in q_upper:
            target_ts = params[0]
            self.rows = []
            for sid in self.sensor_meta:
                stored = self.database.get(sid, {})
                if target_ts in stored:
                    self.rows.append((sid, stored[target_ts]))
        elif "FROM OBSERVATIONS" in q_upper and "WHERE OBSERVED_AT IN" in q_upper:
            timestamps = params
            self.rows = []
            for sid in self.sensor_meta:
                stored = self.database.get(sid, {})
                for ts in timestamps:
                    if ts in stored:
                        self.rows.append((sid, ts, stored[ts]))
        elif "FROM OBSERVATIONS" in q_upper and "OBSERVED_AT >=" in q_upper:
            sid = params[0]
            start_ts = params[1]
            end_ts = params[2]
            stored = self.database.get(sid, {})
            self.rows = [(ts, spd) for ts, spd in stored.items() if start_ts <= ts <= end_ts]
        elif "INSERT INTO SENSOR_CONFIGURATIONS" in q_upper:
            sid = params[0]
            ff = params[1] or 65.0
            rc = params[2] or "Freeway"
            su = params[3] or "mph"
            self.configs[sid] = (ff, rc, su)
            self.rows = []
        else:
            self.rows = []

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

    def commit(self):
        pass


class TestTrafficHeatmap(unittest.TestCase):
    def test_congestion_ratio_classification(self):
        """Test ratio thresholds: Free Flow (>= 0.70), Moderate (0.40 - 0.70), Heavy (< 0.40)."""
        free_flow_speed = 65.0

        # Free Flow: 55 mph / 65 = 0.846 >= 0.70
        cat, ratio, f_ref = classify_congestion_ratio(55.0, free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.FREE_FLOW)
        self.assertAlmostEqual(ratio, 0.846, places=2)
        self.assertEqual(f_ref, 65.0)

        # Exact boundary Free Flow: 45.5 mph / 65 = 0.70
        cat, ratio, _ = classify_congestion_ratio(45.5, free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.FREE_FLOW)

        # Moderate: 35 mph / 65 = 0.538 (between 0.40 and 0.70)
        cat, ratio, _ = classify_congestion_ratio(35.0, free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.MODERATE_TRAFFIC)
        self.assertAlmostEqual(ratio, 0.538, places=2)

        # Heavy: 20 mph / 65 = 0.308 (< 0.40)
        cat, ratio, _ = classify_congestion_ratio(20.0, free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.HEAVY_CONGESTION)
        self.assertAlmostEqual(ratio, 0.308, places=2)

        # Missing / invalid speed -> INSUFFICIENT DATA
        cat, ratio, _ = classify_congestion_ratio(None, free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.INSUFFICIENT_DATA)
        self.assertIsNone(ratio)

        cat, ratio, _ = classify_congestion_ratio(float("nan"), free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.INSUFFICIENT_DATA)

        cat, ratio, _ = classify_congestion_ratio(-5.0, free_flow_speed=free_flow_speed)
        self.assertEqual(cat, CongestionCategory.INSUFFICIENT_DATA)

    def test_road_type_fallback(self):
        """Test fallback reference free-flow speeds for different road categories."""
        # Highway (55 mph): 40 mph / 55 = 0.727 -> Free Flow
        cat, ratio, f_ref = classify_congestion_ratio(40.0, free_flow_speed=None, road_category="Highway")
        self.assertEqual(f_ref, 55.0)
        self.assertEqual(cat, CongestionCategory.FREE_FLOW)

        # Arterial (45 mph): 25 mph / 45 = 0.556 -> Moderate Traffic
        cat, ratio, f_ref = classify_congestion_ratio(25.0, free_flow_speed=None, road_category="Arterial")
        self.assertEqual(f_ref, 45.0)
        self.assertEqual(cat, CongestionCategory.MODERATE_TRAFFIC)

        # Urban (35 mph): 10 mph / 35 = 0.286 -> Heavy Congestion
        cat, ratio, f_ref = classify_congestion_ratio(10.0, free_flow_speed=None, road_category="Urban")
        self.assertEqual(f_ref, 35.0)
        self.assertEqual(cat, CongestionCategory.HEAVY_CONGESTION)

    def test_heatmap_service_initialization_and_metadata(self):
        artifacts = Path("model_artifacts")
        if not artifacts.is_dir():
            raise unittest.SkipTest("model_artifacts not present.")

        target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)
        db_data = {
            400001: {target_ts: 62.0},
            400002: {target_ts: 32.0},
            400003: {target_ts: 12.0},
        }

        conn_factory = lambda: FakeConnection(db_data)
        service = HeatmapService(artifacts_dir=artifacts, connection_factory=conn_factory)

        sensors = service.get_sensors_list()
        self.assertEqual(len(sensors), 3)
        self.assertEqual(sensors[0]["sensor_id"], 400001)

        models = service.get_available_models()
        self.assertEqual(len(models), 4)

        timeline = service.get_timeline()
        self.assertIn("start", timeline)
        self.assertIn("end", timeline)
        self.assertIn("presets", timeline)
        self.assertGreaterEqual(len(timeline["presets"]), 3)

    def test_traffic_heatmap_filtering_and_stats(self):
        artifacts = Path("model_artifacts")
        if not artifacts.is_dir():
            raise unittest.SkipTest("model_artifacts not present.")

        target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)
        db_data = {
            400001: {target_ts: 60.0},  # 60 / 65 = 0.923 -> FREE FLOW (Green)
            400002: {target_ts: 30.0},  # 30 / 60 = 0.500 -> MODERATE (Yellow)
            400003: {target_ts: 10.0},  # 10 / 45 = 0.222 -> HEAVY (Red)
        }

        conn_factory = lambda: FakeConnection(db_data)
        service = HeatmapService(artifacts_dir=artifacts, connection_factory=conn_factory)

        # 1. Query all traffic
        res = service.get_traffic_heatmap(
            timestamp_str="2017-05-15T08:30:00Z",
            model_name="ensemble",
            data_type="actual",
            congestion_filter="ALL",
        )
        self.assertEqual(res["statistics"]["total_sensors"], 3)
        self.assertEqual(res["statistics"]["free_flow_count"], 1)
        self.assertEqual(res["statistics"]["moderate_count"], 1)
        self.assertEqual(res["statistics"]["heavy_count"], 1)
        self.assertEqual(res["statistics"]["no_data_count"], 0)

        # 2. Filter by HEAVY congestion
        heavy_res = service.get_traffic_heatmap(
            timestamp_str="2017-05-15T08:30:00Z",
            congestion_filter="HEAVY",
        )
        self.assertEqual(len(heavy_res["sensors"]), 1)
        self.assertEqual(heavy_res["sensors"][0]["sensor_id"], 400003)
        self.assertEqual(heavy_res["sensors"][0]["color"], "#dc2626")

        # 3. Search filter by ID
        search_res = service.get_traffic_heatmap(
            timestamp_str="2017-05-15T08:30:00Z",
            search="400001",
        )
        self.assertEqual(len(search_res["sensors"]), 1)
        self.assertEqual(search_res["sensors"][0]["sensor_id"], 400001)

    def test_sensor_comparison_series(self):
        artifacts = Path("model_artifacts")
        if not artifacts.is_dir():
            raise unittest.SkipTest("model_artifacts not present.")

        target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)
        db_data = {
            400001: {
                target_ts: 58.0,
            }
        }
        conn_factory = lambda: FakeConnection(db_data)
        service = HeatmapService(artifacts_dir=artifacts, connection_factory=conn_factory)

        comp = service.get_sensor_comparison(
            sensor_id=400001,
            target_timestamp_str="2017-05-15T08:30:00Z",
            hours=2,
            model_name="ensemble",
        )
        self.assertEqual(comp["sensor_id"], 400001)
        self.assertIn("points", comp)
        self.assertIn("metrics", comp)
        self.assertGreater(len(comp["points"]), 0)

    def test_update_sensor_config(self):
        artifacts = Path("model_artifacts")
        if not artifacts.is_dir():
            raise unittest.SkipTest("model_artifacts not present.")

        conn_factory = lambda: FakeConnection({})
        service = HeatmapService(artifacts_dir=artifacts, connection_factory=conn_factory)

        updated = service.update_sensor_config(
            sensor_id=400001,
            free_flow_speed=70.0,
            road_category="Interstate",
        )
        self.assertEqual(updated["free_flow_speed"], 70.0)
        self.assertEqual(updated["road_category"], "Interstate")

    def test_unknown_sensor_error(self):
        artifacts = Path("model_artifacts")
        if not artifacts.is_dir():
            raise unittest.SkipTest("model_artifacts not present.")

        conn_factory = lambda: FakeConnection({})
        service = HeatmapService(artifacts_dir=artifacts, connection_factory=conn_factory)

        with self.assertRaises(ValueError):
            service.get_sensor_detail(sensor_id=999999)


if __name__ == "__main__":
    unittest.main()
