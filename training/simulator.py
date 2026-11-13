"""Highway Simulator Service for GridLock AR/VR Traffic Intelligence Simulator.

Generates 3D-grounded multi-segment highway corridors from real PEMS-BAY sensor metadata,
queries real actual traffic observations and ML predictions (XGBoost, CatBoost, LightGBM,
Weighted Ensemble), computes Greenshields traffic density metrics, and delivers
spatio-temporal simulation feeds for WebXR and 3D rendering.
"""

from __future__ import annotations

import csv
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from training.congestion import (
    CongestionCategory,
    classify_congestion_ratio,
    DEFAULT_RATIO_THRESHOLDS,
)
from training.db import connect
from training.predict_speed import load_models
from training.reference_features import (
    SAMPLING_INTERVAL,
    align_to_sampling_grid,
    valid_speed,
)

LOGGER = logging.getLogger("gridlock.simulator")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
UTC = timezone.utc


def get_congestion_color(category: str) -> str:
    """Return standard hex color for congestion category."""
    if category == CongestionCategory.FREE_FLOW:
        return "#10b981"  # Emerald Green
    elif category == CongestionCategory.MODERATE_TRAFFIC:
        return "#f59e0b"  # Amber Yellow
    elif category == CongestionCategory.HEAVY_CONGESTION:
        return "#ef4444"  # Rose Red
    return "#6b7280"  # Neutral Slate Grey


class SimulatorService:
    """Service providing highway geometry, real sensor telemetry, and traffic physics for 3D/AR/VR simulation."""

    def __init__(
        self,
        artifacts_dir: Optional[Path] = None,
        connection_factory=connect,
        meta_csv_path: Optional[Path] = None,
        heatmap_service: Optional[Any] = None,
    ):
        self.artifacts_dir = artifacts_dir or (PROJECT_ROOT / "model_artifacts")
        self.connection_factory = connection_factory
        self.meta_csv_path = meta_csv_path or (PROJECT_ROOT / "PEMS-BAY-META.csv")
        self.heatmap_service = heatmap_service
        self._corridors_cache: Dict[str, List[Dict[str, Any]]] = {}
        self._load_sensor_meta()

    def _load_sensor_meta(self) -> None:
        """Parse PEMS-BAY-META.csv into indexed freeway corridors."""
        if not self.meta_csv_path.exists():
            LOGGER.warning("PEMS-BAY-META.csv not found at %s", self.meta_csv_path)
            return

        corridors: Dict[str, List[Dict[str, Any]]] = {}
        with open(self.meta_csv_path, mode="r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    sid = int(row["sensor_id"])
                    fwy = str(row.get("Fwy", "")).strip()
                    dir_ = str(row.get("Dir", "")).strip()
                    if not fwy or not dir_:
                        continue

                    key = f"{fwy}-{dir_}"
                    abs_pm = float(row.get("Abs_PM", row.get("State_PM", 0.0)) or 0.0)
                    lat = float(row.get("Latitude", 0.0) or 0.0)
                    lon = float(row.get("Longitude", 0.0) or 0.0)
                    lanes = int(float(row.get("Lanes", 3) or 3))
                    lanes = max(2, min(6, lanes))
                    name = row.get("Name", f"Sensor {sid}")

                    item = {
                        "sensor_id": sid,
                        "freeway": fwy,
                        "direction": dir_,
                        "postmile": abs_pm,
                        "latitude": lat,
                        "longitude": lon,
                        "lanes": lanes,
                        "name": name,
                    }

                    if key not in corridors:
                        corridors[key] = []
                    corridors[key].append(item)
                except Exception:
                    continue

        # Sort each corridor by postmile
        for key in corridors:
            corridors[key].sort(key=lambda s: s["postmile"])

        self._corridors_cache = corridors
        LOGGER.info("Loaded %d corridors from %s", len(corridors), self.meta_csv_path)

    def get_available_corridors(self) -> List[Dict[str, Any]]:
        """Return list of available highway corridors with sensor counts."""
        corridor_names = {
            "85-N": "CA-85 North (South Bay / Silicon Valley)",
            "85-S": "CA-85 South (Silicon Valley Express)",
            "101-N": "US-101 North (Bayshore Freeway)",
            "101-S": "US-101 South (Silicon Valley Corridor)",
            "880-N": "I-880 North (Nimitz Freeway)",
            "880-S": "I-880 South (Nimitz Freeway)",
            "280-N": "I-280 North (Junipero Serra Freeway)",
            "280-S": "I-280 South (Junipero Serra Freeway)",
            "17-N": "CA-17 North (Santa Cruz / San Jose)",
            "17-S": "CA-17 South (Santa Cruz Highway)",
            "237-E": "CA-237 East (South Bay Freeway)",
            "237-W": "CA-237 West (South Bay Freeway)",
            "87-N": "CA-87 North (Guadalupe Parkway)",
            "87-S": "CA-87 South (Guadalupe Parkway)",
        }

        result = []
        for key, sensors in sorted(self._corridors_cache.items(), key=lambda x: -len(x[1])):
            fwy, dir_ = key.split("-")
            name = corridor_names.get(key, f"Freeway {fwy} {dir_}")
            result.append({
                "key": key,
                "freeway": fwy,
                "direction": dir_,
                "name": name,
                "sensor_count": len(sensors),
                "start_postmile": round(sensors[0]["postmile"], 2) if sensors else 0,
                "end_postmile": round(sensors[-1]["postmile"], 2) if sensors else 0,
            })
        return result

    def get_highway_scene(
        self,
        freeway: str = "85",
        direction: str = "N",
        timestamp_str: str = "2017-05-15T08:30:00",
        model_name: str = "ensemble",
        max_sensors: int = 8,
    ) -> Dict[str, Any]:
        """Generate complete 3D highway simulation corridor with real sensor telemetry and physics."""
        key = f"{freeway.strip()}-{direction.strip().upper()}"
        corridor_sensors = self._corridors_cache.get(key)
        if not corridor_sensors:
            # Fallback to default CA-85 N
            key = "85-N"
            corridor_sensors = self._corridors_cache.get(key, [])

        if not corridor_sensors:
            # Synthetic fallback if metadata missing
            corridor_sensors = [
                {"sensor_id": 400001 + i, "freeway": freeway, "direction": direction, "postmile": 5.0 + i * 0.8, "latitude": 37.25 + i * 0.01, "longitude": -121.90 - i * 0.01, "lanes": 3, "name": f"Station {i+1}"}
                for i in range(max_sensors)
            ]

        # Pick evenly spaced or contiguous segment of sensors (e.g. 6 to 10 sensors)
        total_avail = len(corridor_sensors)
        if total_avail > max_sensors:
            # Pick a representative continuous slice
            start_idx = max(0, min(2, total_avail - max_sensors))
            selected_sensors = corridor_sensors[start_idx : start_idx + max_sensors]
        else:
            selected_sensors = corridor_sensors

        # Parse timestamp
        try:
            target_ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            if target_ts.tzinfo is None:
                target_ts = target_ts.replace(tzinfo=UTC)
            else:
                target_ts = target_ts.astimezone(UTC)
        except Exception:
            target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)

        target_ts = align_to_sampling_grid(target_ts)

        # Query actual speeds and model predictions for these sensors
        sensor_ids = [s["sensor_id"] for s in selected_sensors]
        actual_speeds: Dict[int, Optional[float]] = {}
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT sensor_id, speed 
                    FROM observations 
                    WHERE observed_at = %s AND sensor_id = ANY(%s);
                    """,
                    (target_ts, sensor_ids),
                )
                for sid, spd in cur.fetchall():
                    actual_speeds[int(sid)] = valid_speed(spd)
        except Exception as e:
            LOGGER.warning("Could not fetch observations from DB: %s", e)

        # Get ML predictions via heatmap service or direct models
        predictions_map: Dict[int, Dict[str, Any]] = {}
        if self.heatmap_service:
            try:
                heatmap_data = self.heatmap_service.get_traffic_heatmap(
                    target_ts.isoformat(),
                    model_name=model_name,
                    freeway_filter=freeway,
                )
                for s_item in heatmap_data.get("sensors", []):
                    sid = s_item["sensor_id"]
                    if sid in sensor_ids:
                        predictions_map[sid] = s_item
            except Exception as e:
                LOGGER.warning("Heatmap service query failed for simulator: %s", e)

        # Assemble detailed sensor telemetry and highway segments
        sensors_output: List[Dict[str, Any]] = []
        segments_output: List[Dict[str, Any]] = []

        # Reference speed per road type (freeway = 65 mph)
        FREE_FLOW_SPEED = 65.0
        SPEED_LIMIT = 65.0

        for i, s in enumerate(selected_sensors):
            sid = s["sensor_id"]
            pred_item = predictions_map.get(sid, {})
            
            actual_spd = actual_speeds.get(sid, pred_item.get("actual_speed"))
            pred_spd = pred_item.get("predicted_speed")
            
            # If both missing, use baseline realistic speed (e.g. 58.5 mph)
            if actual_spd is None and pred_spd is None:
                effective_spd = 58.5
                source = "simulated"
            elif pred_spd is not None and model_name != "actual":
                effective_spd = pred_spd
                source = "predicted"
            elif actual_spd is not None:
                effective_spd = actual_spd
                source = "actual"
            else:
                effective_spd = pred_spd or 60.0
                source = "predicted"

            category, ratio, _ = classify_congestion_ratio(
                effective_spd,
                free_flow_speed=FREE_FLOW_SPEED,
                ratio_thresholds=DEFAULT_RATIO_THRESHOLDS,
            )
            color = get_congestion_color(category)

            # Greenshields model:
            # v = v_f * (1 - k / k_jam)  ==>  k = k_jam * (1 - v / v_f)
            # Jam density: ~120 vehicles/km/lane; free flow density: ~15 vehicles/km/lane
            jam_density = 120.0  # veh / km / lane
            v_ratio = min(1.0, max(0.05, effective_spd / FREE_FLOW_SPEED))
            density_per_km_lane = jam_density * (1.0 - v_ratio) + 12.0
            total_density = density_per_km_lane * s["lanes"]
            flow_veh_per_hr = total_density * effective_spd * 1.60934  # flow q = k * v

            sensor_data = {
                "sensor_id": sid,
                "name": s["name"],
                "freeway": s["freeway"],
                "direction": s["direction"],
                "postmile": round(s["postmile"], 3),
                "latitude": s["latitude"],
                "longitude": s["longitude"],
                "lanes": s["lanes"],
                "speed_limit": SPEED_LIMIT,
                "free_flow_speed": FREE_FLOW_SPEED,
                "actual_speed": round(actual_spd, 1) if actual_spd is not None else None,
                "predicted_speed": round(pred_spd, 1) if pred_spd is not None else None,
                "effective_speed": round(effective_spd, 1),
                "congestion_ratio": round(ratio or (effective_spd / FREE_FLOW_SPEED), 3),
                "congestion_category": "FREE_FLOW" if category == CongestionCategory.FREE_FLOW else ("MODERATE" if category == CongestionCategory.MODERATE_TRAFFIC else "HEAVY"),
                "congestion_label": category,
                "color": color,
                "source": source,
                "health_status": "ONLINE" if actual_spd is not None else "DELAYED",
                "traffic_density_veh_km": round(total_density, 1),
                "flow_rate_veh_hr": round(flow_veh_per_hr),
                "model": model_name,
            }
            sensors_output.append(sensor_data)

        # Build highway road segments between consecutive sensors
        for i in range(len(sensors_output) - 1):
            s_from = sensors_output[i]
            s_to = sensors_output[i + 1]

            pm_dist = max(0.2, s_to["postmile"] - s_from["postmile"])
            length_m = pm_dist * 1609.34
            lanes = max(s_from["lanes"], s_to["lanes"])
            avg_speed = (s_from["effective_speed"] + s_to["effective_speed"]) / 2.0
            seg_cat, seg_ratio, _ = classify_congestion_ratio(
                avg_speed,
                free_flow_speed=FREE_FLOW_SPEED,
                ratio_thresholds=DEFAULT_RATIO_THRESHOLDS,
            )
            seg_color = get_congestion_color(seg_cat)

            # Recommend spawn count along this segment in 3D scene (scale 1 vehicle per ~40m free flow, 1 per ~15m heavy)
            spacing_m = 15.0 if seg_cat == CongestionCategory.HEAVY_CONGESTION else (25.0 if seg_cat == CongestionCategory.MODERATE_TRAFFIC else 45.0)
            target_veh_count = max(3, min(24, int((length_m / spacing_m) * (lanes / 3.0))))

            segment = {
                "segment_index": i,
                "from_sensor_id": s_from["sensor_id"],
                "to_sensor_id": s_to["sensor_id"],
                "start_postmile": s_from["postmile"],
                "end_postmile": s_to["postmile"],
                "length_m": round(length_m, 1),
                "length_miles": round(pm_dist, 2),
                "lanes": lanes,
                "speed_mph": round(avg_speed, 1),
                "congestion_category": "FREE_FLOW" if seg_cat == CongestionCategory.FREE_FLOW else ("MODERATE" if seg_cat == CongestionCategory.MODERATE_TRAFFIC else "HEAVY"),
                "congestion_label": seg_cat,
                "color": seg_color,
                "target_vehicle_count": target_veh_count,
                "from_sensor_name": s_from["name"],
                "to_sensor_name": s_to["name"],
            }
            segments_output.append(segment)

        total_km = sum(seg["length_m"] for seg in segments_output) / 1000.0 if segments_output else 0.0

        return {
            "freeway": freeway,
            "direction": direction,
            "corridor_key": key,
            "corridor_name": f"Freeway {freeway} {direction} Corridor",
            "timestamp": target_ts.isoformat(),
            "model": model_name,
            "total_sensors": len(sensors_output),
            "total_segments": len(segments_output),
            "total_length_km": round(total_km, 2),
            "sensors": sensors_output,
            "segments": segments_output,
            "available_corridors": self.get_available_corridors(),
            "models": ["ensemble", "xgboost", "catboost", "lightgbm", "actual"],
        }
