"""Unit and Integration Tests for GridLock AR/VR Traffic Simulator Service and APIs."""

import unittest
from pathlib import Path
from training.simulator import SimulatorService, get_congestion_color
from training.congestion import CongestionCategory

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class TestSimulatorService(unittest.TestCase):
    """Test suite for SimulatorService logic and physics calculations."""

    def setUp(self):
        self.sim = SimulatorService(meta_csv_path=PROJECT_ROOT / "PEMS-BAY-META.csv")

    def test_corridors_loaded(self):
        corridors = self.sim.get_available_corridors()
        self.assertGreater(len(corridors), 0, "Should load freeway corridors from PEMS-BAY-META.csv")
        # Check that major freeways exist
        fwy_names = [c["freeway"] for c in corridors]
        self.assertIn("85", fwy_names)
        self.assertIn("101", fwy_names)
        self.assertIn("880", fwy_names)

    def test_corridor_postmile_ordering(self):
        corridor = self.sim._corridors_cache.get("85-N")
        self.assertIsNotNone(corridor)
        self.assertGreater(len(corridor), 5)
        # Verify strictly non-decreasing postmiles
        pms = [s["postmile"] for s in corridor]
        self.assertEqual(pms, sorted(pms), "Sensors along corridor must be sorted by postmile")

    def test_get_highway_scene_structure(self):
        scene = self.sim.get_highway_scene(
            freeway="85",
            direction="N",
            timestamp_str="2017-05-15T08:30:00",
            model_name="ensemble",
            max_sensors=8,
        )
        self.assertIn("freeway", scene)
        self.assertIn("direction", scene)
        self.assertIn("sensors", scene)
        self.assertIn("segments", scene)
        self.assertIn("total_length_km", scene)
        self.assertGreater(len(scene["sensors"]), 0)
        self.assertEqual(len(scene["segments"]), len(scene["sensors"]) - 1)

    def test_sensor_metrics_and_classification(self):
        scene = self.sim.get_highway_scene("85", "N", "2017-05-15T08:30:00", "ensemble")
        for s in scene["sensors"]:
            self.assertIn("sensor_id", s)
            self.assertIn("effective_speed", s)
            self.assertIn("congestion_category", s)
            self.assertIn("color", s)
            self.assertIn(s["congestion_category"], ["FREE_FLOW", "MODERATE", "HEAVY"])
            self.assertTrue(s["color"].startswith("#"))
            # Greenshields physics check
            self.assertGreater(s["traffic_density_veh_km"], 0)
            self.assertGreater(s["flow_rate_veh_hr"], 0)

    def test_segment_metrics_and_spawn_targets(self):
        scene = self.sim.get_highway_scene("85", "N", "2017-05-15T08:30:00", "ensemble")
        for seg in scene["segments"]:
            self.assertGreater(seg["length_m"], 0)
            self.assertGreater(seg["target_vehicle_count"], 0)
            self.assertIn(seg["congestion_category"], ["FREE_FLOW", "MODERATE", "HEAVY"])
            self.assertTrue(seg["color"].startswith("#"))

    def test_color_mapping(self):
        self.assertEqual(get_congestion_color(CongestionCategory.FREE_FLOW), "#10b981")
        self.assertEqual(get_congestion_color(CongestionCategory.MODERATE_TRAFFIC), "#f59e0b")
        self.assertEqual(get_congestion_color(CongestionCategory.HEAVY_CONGESTION), "#ef4444")

    def test_invalid_corridor_fallback(self):
        # Request non-existent freeway
        scene = self.sim.get_highway_scene("9999", "Z", "2017-05-15T08:30:00")
        self.assertIsNotNone(scene)
        self.assertGreater(len(scene["sensors"]), 0, "Should fall back gracefully")


if __name__ == "__main__":
    unittest.main()
