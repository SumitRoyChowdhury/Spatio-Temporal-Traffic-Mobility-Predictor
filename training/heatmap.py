"""Traffic Heatmap Service for Spatio-Temporal Traffic Mobility Predictor.

Provides geographical sensor monitoring, configurable congestion classification
using Congestion Ratio (S / F), batch multi-model predictions, time-series comparison,
and spatial filtering for the Interactive Traffic Intelligence Heatmap.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from training.congestion import (
    CongestionCategory,
    CongestionRatioThresholds,
    DEFAULT_RATIO_THRESHOLDS,
    ROAD_TYPE_FREE_FLOW_SPEEDS,
    classify_congestion_ratio,
)
from training.db import connect
from training.predict_speed import load_models
from training.reference_features import (
    FEATURE_NAMES,
    SAMPLING_INTERVAL,
    align_to_sampling_grid,
    reference_timestamps,
    valid_speed,
)

LOGGER = logging.getLogger("gridlock.heatmap")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
UTC = timezone.utc
ENSEMBLE_FILE = "reference_ensemble_evaluation.json"


class HeatmapService:
    """Service powering the Interactive Traffic Intelligence Heatmap."""

    def __init__(
        self,
        artifacts_dir: Optional[Path] = None,
        connection_factory=connect,
        models: Optional[Dict[str, Any]] = None,
        metrics: Optional[Dict[str, Any]] = None,
    ):
        self.artifacts_dir = artifacts_dir or (PROJECT_ROOT / "model_artifacts")
        self.connection_factory = connection_factory

        if models is not None and metrics is not None:
            self.models = models
            self.metrics = metrics
        else:
            self.models, self.metrics = load_models(self.artifacts_dir)

        self.ensemble_weights = self._load_ensemble_weights()
        self._ensure_config_columns()
        self._cached_sensor_meta: Dict[int, Dict[str, Any]] = {}
        self._load_sensor_metadata()

    def _load_ensemble_weights(self) -> Dict[str, float]:
        path = self.artifacts_dir / ENSEMBLE_FILE
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return data.get("weights", {"xgboost": 0.333, "catboost": 0.333, "lightgbm": 0.334})
            except Exception:
                pass
        return {"xgboost": 0.333, "catboost": 0.333, "lightgbm": 0.334}

    def _ensure_config_columns(self) -> None:
        """Guarantee free_flow_speed, road_category, speed_unit exist in sensor_configurations."""
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    ALTER TABLE sensor_configurations 
                    ADD COLUMN IF NOT EXISTS free_flow_speed DOUBLE PRECISION DEFAULT 65.0,
                    ADD COLUMN IF NOT EXISTS road_category VARCHAR(50) DEFAULT 'Freeway',
                    ADD COLUMN IF NOT EXISTS speed_unit VARCHAR(10) DEFAULT 'mph';
                    """
                )
                conn.commit()
        except Exception:
            LOGGER.warning("Could not auto-verify sensor_configurations schema extensions.")

    def _load_sensor_metadata(self) -> None:
        """Cache static sensor metadata, locations, and configured free-flow thresholds."""
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT s.sensor_id, s.metadata, 
                           COALESCE(c.free_flow_speed, 65.0),
                           COALESCE(c.road_category, 'Freeway'),
                           COALESCE(c.speed_unit, 'mph')
                    FROM sensors s
                    LEFT JOIN sensor_configurations c ON s.sensor_id = c.sensor_id
                    ORDER BY s.sensor_id;
                    """
                )
                rows = cur.fetchall()

            for sid, meta_json, f_speed, r_cat, unit in rows:
                meta = meta_json if isinstance(meta_json, dict) else json.loads(meta_json or "{}")
                lat = meta.get("Latitude")
                lon = meta.get("Longitude")
                fwy = meta.get("Fwy")
                direction = meta.get("Dir")
                name = meta.get("Name")
                postmile = meta.get("Abs_PM")

                self._cached_sensor_meta[int(sid)] = {
                    "sensor_id": int(sid),
                    "name": name or f"Sensor {sid}",
                    "freeway": fwy,
                    "direction": direction,
                    "latitude": float(lat) if lat is not None else None,
                    "longitude": float(lon) if lon is not None else None,
                    "postmile": float(postmile) if postmile is not None else None,
                    "free_flow_speed": float(f_speed or 65.0),
                    "road_category": str(r_cat or "Freeway"),
                    "speed_unit": str(unit or "mph"),
                }
        except Exception:
            LOGGER.exception("Failed to load sensor metadata cache.")

    def get_available_models(self) -> List[Dict[str, Any]]:
        """Return available prediction models and weights."""
        return [
            {
                "key": "ensemble",
                "label": "Weighted Ensemble",
                "type": "Multi-Model Ensemble",
                "weights": self.ensemble_weights,
            },
            {
                "key": "lightgbm",
                "label": "LightGBM",
                "type": "Histogram Gradient Boosted Trees",
            },
            {
                "key": "xgboost",
                "label": "XGBoost",
                "type": "Extreme Gradient Boosting",
            },
            {
                "key": "catboost",
                "label": "CatBoost",
                "type": "Symmetric Decision Trees",
            },
        ]

    def get_timeline(self) -> Dict[str, Any]:
        """Return dataset timeline bounds, default timestamp, and representative traffic presets."""
        data_start = None
        data_end = None
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute("SELECT min(observed_at), max(observed_at) FROM observations;")
                row = cur.fetchone()
                if row and row[0] and row[1]:
                    data_start = row[0].isoformat()
                    data_end = row[1].isoformat()
        except Exception:
            LOGGER.exception("Failed to query observation bounds for timeline.")

        default_ts = "2017-05-15T08:30:00+00:00"

        presets = [
            {
                "label": "Morning Rush Hour (Peak Commute)",
                "timestamp": "2017-05-15T08:30:00+00:00",
                "description": "Heavy inbound commute towards Silicon Valley / SF Bay Area corridors.",
            },
            {
                "label": "Midday Normal Flow",
                "timestamp": "2017-05-15T13:00:00+00:00",
                "description": "Typical midday free-flow and moderate movement across freeways.",
            },
            {
                "label": "Evening Rush Hour (Congested)",
                "timestamp": "2017-05-15T17:30:00+00:00",
                "description": "High-volume outbound evening commute with bottleneck slowdowns.",
            },
            {
                "label": "Late Night Free Flow",
                "timestamp": "2017-05-15T02:00:00+00:00",
                "description": "Low-density nocturnal traffic near free-flow maximum speeds.",
            },
            {
                "label": "Weekend Recreational Traffic",
                "timestamp": "2017-05-20T14:00:00+00:00",
                "description": "Saturday travel pattern across US-101 and I-880.",
            },
        ]

        return {
            "start": data_start or "2017-01-01T00:00:00+00:00",
            "end": data_end or "2017-06-30T23:55:00+00:00",
            "step_seconds": int(SAMPLING_INTERVAL.total_seconds()),
            "default_timestamp": default_ts,
            "presets": presets,
        }

    def get_sensors_list(self) -> List[Dict[str, Any]]:
        """Return list of all registered sensors with geographic coordinates."""
        if not self._cached_sensor_meta:
            self._load_sensor_metadata()
        return list(self._cached_sensor_meta.values())

    def _predict_batch_speeds(
        self,
        sensor_ids: List[int],
        target_timestamp: datetime,
        model_name: str = "ensemble",
    ) -> Dict[int, Optional[float]]:
        """Compute batch model predictions for all sensors in a single matrix pass."""
        target = align_to_sampling_grid(target_timestamp)
        lookups = reference_timestamps(target)

        # Batch query reference observations
        ref_rows = []
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT sensor_id, observed_at, speed 
                    FROM observations 
                    WHERE observed_at IN (%s, %s, %s);
                    """,
                    (
                        lookups["previous_day_speed"],
                        lookups["previous_week_speed"],
                        lookups["previous_year_speed"],
                    ),
                )
                ref_rows = cur.fetchall()
        except Exception:
            LOGGER.exception("Failed to query batch references for heatmap prediction.")

        ref_map: Dict[int, Dict[datetime, float]] = {}
        for sid, obs_ts, spd in ref_rows:
            v = valid_speed(spd)
            if v is not None:
                ref_map.setdefault(int(sid), {})[obs_ts] = v

        # Construct dataframe
        day_ref = lookups["previous_day_speed"]
        week_ref = lookups["previous_week_speed"]
        year_ref = lookups["previous_year_speed"]

        categories = list(self.metrics["sensor_categories"])
        fallback_cat = categories[0] if categories else 400001
        safe_sensor_ids = [s if s in categories else fallback_cat for s in sensor_ids]

        row_data = {
            "sensor_id": pd.Categorical(safe_sensor_ids, categories=categories),
            "previous_day_speed": np.array([ref_map.get(s, {}).get(day_ref, np.nan) for s in sensor_ids], dtype=np.float32),
            "previous_week_speed": np.array([ref_map.get(s, {}).get(week_ref, np.nan) for s in sensor_ids], dtype=np.float32),
            "previous_year_speed": np.array([ref_map.get(s, {}).get(year_ref, np.nan) for s in sensor_ids], dtype=np.float32),
        }
        frame = pd.DataFrame(row_data)[list(FEATURE_NAMES)]

        # Check which sensors have at least 1 valid reference
        has_any_ref = ~np.isnan(row_data["previous_day_speed"]) | ~np.isnan(row_data["previous_week_speed"]) | ~np.isnan(row_data["previous_year_speed"])

        # Predict
        m_key = model_name.lower()
        predictions: Dict[int, Optional[float]] = {}

        if m_key == "ensemble":
            weights = self.ensemble_weights
            ens_preds = np.zeros(len(sensor_ids), dtype=np.float64)
            for m in ("xgboost", "catboost", "lightgbm"):
                p = self.models[m].predict(frame)
                ens_preds += weights.get(m, 0.333) * np.array(p, dtype=np.float64)
            final_p = ens_preds
        elif m_key in self.models:
            final_p = self.models[m_key].predict(frame)
        else:
            raise ValueError(f"Unknown prediction model: {model_name}")

        for i, sid in enumerate(sensor_ids):
            if has_any_ref[i]:
                predictions[sid] = round(float(final_p[i]), 1)
            else:
                predictions[sid] = None

        return predictions

    def get_traffic_heatmap(
        self,
        timestamp_str: str,
        model_name: str = "ensemble",
        data_type: str = "both",
        congestion_filter: str = "ALL",
        search: Optional[str] = None,
        freeway_filter: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Compute complete geographical traffic heatmap for all sensors at the specified timestamp."""
        if not self._cached_sensor_meta:
            self._load_sensor_metadata()

        try:
            target_ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            if target_ts.tzinfo is None:
                target_ts = target_ts.replace(tzinfo=UTC)
            else:
                target_ts = target_ts.astimezone(UTC)
        except Exception:
            target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)

        target_ts = align_to_sampling_grid(target_ts)
        all_sensor_ids = sorted(self._cached_sensor_meta.keys())

        # 1. Fetch actual observations at target_ts
        actual_speeds: Dict[int, Optional[float]] = {}
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT sensor_id, speed 
                    FROM observations 
                    WHERE observed_at = %s;
                    """,
                    (target_ts,),
                )
                for sid, spd in cur.fetchall():
                    actual_speeds[int(sid)] = valid_speed(spd)
        except Exception:
            LOGGER.exception("Failed to query actual speeds for heatmap.")

        # 2. Compute model predictions if requested
        need_predictions = data_type.lower() in ("predicted", "both", "comparison")
        predicted_speeds: Dict[int, Optional[float]] = {}
        if need_predictions:
            predicted_speeds = self._predict_batch_speeds(all_sensor_ids, target_ts, model_name=model_name)

        # 3. Assemble and classify each sensor
        sensor_results = []
        free_flow_count = 0
        moderate_count = 0
        heavy_count = 0
        no_data_count = 0
        sum_actual = 0.0
        n_actual = 0
        sum_predicted = 0.0
        n_predicted = 0
        sum_ratio = 0.0
        n_ratio = 0

        dtype = data_type.lower()
        search_term = search.strip().lower() if search and search.strip() else None

        for sid in all_sensor_ids:
            meta = self._cached_sensor_meta[sid]
            act = actual_speeds.get(sid)
            pred = predicted_speeds.get(sid)
            f_speed = meta["free_flow_speed"]
            road_cat = meta["road_category"]

            # Decide primary speed for congestion classification
            if dtype == "actual":
                speed_for_class = act
            elif dtype == "predicted":
                speed_for_class = pred
            else:  # "both" / "comparison"
                speed_for_class = act if act is not None else pred

            category, ratio, ref_f = classify_congestion_ratio(
                speed_for_class,
                free_flow_speed=f_speed,
                road_category=road_cat,
                ratio_thresholds=DEFAULT_RATIO_THRESHOLDS,
            )

            # Colors matching GridLock standard design system
            if category == CongestionCategory.FREE_FLOW:
                color = "#15803d"  # Green
                status_key = "FREE_FLOW"
                free_flow_count += 1
            elif category == CongestionCategory.MODERATE_TRAFFIC:
                color = "#eab308"  # Yellow / Amber
                status_key = "MODERATE"
                moderate_count += 1
            elif category == CongestionCategory.HEAVY_CONGESTION:
                color = "#dc2626"  # Red
                status_key = "HEAVY"
                heavy_count += 1
            else:
                color = "#6b7280"  # Gray
                status_key = "NO_DATA"
                no_data_count += 1

            if act is not None:
                sum_actual += act
                n_actual += 1
            if pred is not None:
                sum_predicted += pred
                n_predicted += 1
            if ratio is not None:
                sum_ratio += ratio
                n_ratio += 1

            diff = round(pred - act, 1) if (act is not None and pred is not None) else None
            abs_err_pct = round((abs(pred - act) / act) * 100.0, 1) if (act is not None and pred is not None and act > 0) else None

            # Filters
            if congestion_filter != "ALL" and status_key != congestion_filter.upper():
                continue

            if freeway_filter and str(meta.get("freeway")) != str(freeway_filter):
                continue

            if search_term:
                match_id = str(sid).startswith(search_term)
                match_name = search_term in (meta.get("name") or "").lower()
                match_fwy = search_term in f"fwy {meta.get('freeway')} {meta.get('direction')}".lower()
                if not (match_id or match_name or match_fwy):
                    continue

            sensor_results.append({
                "sensor_id": sid,
                "name": meta["name"],
                "freeway": meta["freeway"],
                "direction": meta["direction"],
                "latitude": meta["latitude"],
                "longitude": meta["longitude"],
                "postmile": meta["postmile"],
                "road_category": road_cat,
                "free_flow_speed": f_speed,
                "speed_unit": meta["speed_unit"],
                "actual_speed": act,
                "predicted_speed": pred,
                "speed_difference": diff,
                "absolute_percentage_error": abs_err_pct,
                "primary_speed": speed_for_class,
                "congestion_category": category,
                "congestion_status": status_key,
                "congestion_ratio": ratio,
                "color": color,
            })

        avg_act = round(sum_actual / n_actual, 1) if n_actual > 0 else None
        avg_pred = round(sum_predicted / n_predicted, 1) if n_predicted > 0 else None
        avg_ratio = round(sum_ratio / n_ratio, 2) if n_ratio > 0 else None

        return {
            "target_timestamp": target_ts.isoformat(),
            "model_name": model_name,
            "data_type": data_type,
            "statistics": {
                "total_sensors": len(all_sensor_ids),
                "matched_sensors": len(sensor_results),
                "free_flow_count": free_flow_count,
                "moderate_count": moderate_count,
                "heavy_count": heavy_count,
                "no_data_count": no_data_count,
                "average_actual_speed": avg_act,
                "average_predicted_speed": avg_pred,
                "average_congestion_ratio": avg_ratio,
            },
            "sensors": sensor_results,
            "summary": (
                f"At {target_ts.strftime('%H:%M UTC')}, {free_flow_count} sensors are in Free-Flow, "
                f"{moderate_count} are Moderate, and {heavy_count} are experiencing Heavy Congestion."
            ),
        }

    def get_sensor_detail(self, sensor_id: int, target_timestamp_str: Optional[str] = None) -> Dict[str, Any]:
        """Return comprehensive sensor information, health, road configuration, and readings."""
        if not self._cached_sensor_meta:
            self._load_sensor_metadata()

        if sensor_id not in self._cached_sensor_meta:
            raise ValueError(f"Sensor {sensor_id} not found.")

        meta = self._cached_sensor_meta[sensor_id]

        if target_timestamp_str:
            try:
                target_ts = datetime.fromisoformat(target_timestamp_str.replace("Z", "+00:00"))
            except Exception:
                target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)
        else:
            target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)

        target_ts = align_to_sampling_grid(target_ts)
        lookups = reference_timestamps(target_ts)

        # Fetch readings around target_ts
        with self.connection_factory() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT observed_at, speed 
                FROM observations 
                WHERE sensor_id = %s AND observed_at IN (%s, %s, %s, %s)
                ORDER BY observed_at DESC;
                """,
                (
                    sensor_id,
                    target_ts,
                    lookups["previous_day_speed"],
                    lookups["previous_week_speed"],
                    lookups["previous_year_speed"],
                ),
            )
            speed_map = {row[0]: valid_speed(row[1]) for row in cur.fetchall()}

        curr_act = speed_map.get(target_ts)
        prev_day = speed_map.get(lookups["previous_day_speed"])
        prev_week = speed_map.get(lookups["previous_week_speed"])
        prev_year = speed_map.get(lookups["previous_year_speed"])

        # Predict
        preds = self._predict_batch_speeds([sensor_id], target_ts, model_name="ensemble")
        ens_pred = preds.get(sensor_id)

        cat, ratio, _ = classify_congestion_ratio(
            curr_act if curr_act is not None else ens_pred,
            free_flow_speed=meta["free_flow_speed"],
            road_category=meta["road_category"],
        )

        return {
            "sensor_id": sensor_id,
            "name": meta["name"],
            "freeway": meta["freeway"],
            "direction": meta["direction"],
            "latitude": meta["latitude"],
            "longitude": meta["longitude"],
            "postmile": meta["postmile"],
            "road_category": meta["road_category"],
            "free_flow_speed": meta["free_flow_speed"],
            "speed_unit": meta["speed_unit"],
            "target_timestamp": target_ts.isoformat(),
            "actual_speed": curr_act,
            "predicted_speed": ens_pred,
            "congestion_category": cat,
            "congestion_ratio": ratio,
            "references": {
                "previous_day_speed": {"timestamp": lookups["previous_day_speed"].isoformat(), "speed": prev_day},
                "previous_week_speed": {"timestamp": lookups["previous_week_speed"].isoformat(), "speed": prev_week},
                "previous_year_speed": {"timestamp": lookups["previous_year_speed"].isoformat(), "speed": prev_year},
            },
        }

    def get_sensor_comparison(
        self,
        sensor_id: int,
        target_timestamp_str: str,
        hours: int = 12,
        model_name: str = "ensemble",
    ) -> Dict[str, Any]:
        """Generate actual vs predicted speed timeline comparison for a single sensor."""
        if not self._cached_sensor_meta:
            self._load_sensor_metadata()

        if sensor_id not in self._cached_sensor_meta:
            raise ValueError(f"Sensor {sensor_id} not found.")

        meta = self._cached_sensor_meta[sensor_id]
        f_speed = meta["free_flow_speed"]
        road_cat = meta["road_category"]

        try:
            target_ts = datetime.fromisoformat(target_timestamp_str.replace("Z", "+00:00"))
        except Exception:
            target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)

        target_ts = align_to_sampling_grid(target_ts)
        start_ts = target_ts - timedelta(hours=hours)
        end_ts = target_ts + timedelta(hours=hours)

        # Fetch actual speeds in range
        with self.connection_factory() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT observed_at, speed 
                FROM observations 
                WHERE sensor_id = %s AND observed_at >= %s AND observed_at <= %s
                ORDER BY observed_at ASC;
                """,
                (sensor_id, start_ts, end_ts),
            )
            act_rows = cur.fetchall()

        actual_map = {r[0]: valid_speed(r[1]) for r in act_rows}

        # Generate timestamps for every 15-minute slot across window
        step_minutes = 15
        current = start_ts
        slot_timestamps = []
        while current <= end_ts:
            slot_timestamps.append(current)
            current += timedelta(minutes=step_minutes)

        # Batch predict for these slots
        points = []
        errors = []
        abs_pct_errors = []

        for ts in slot_timestamps:
            act_val = actual_map.get(ts)
            # Fetch lookups for this ts
            lookups = reference_timestamps(ts)
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT observed_at, speed 
                    FROM observations 
                    WHERE sensor_id = %s AND observed_at IN (%s, %s, %s);
                    """,
                    (sensor_id, lookups["previous_day_speed"], lookups["previous_week_speed"], lookups["previous_year_speed"]),
                )
                r_map = {r[0]: valid_speed(r[1]) for r in cur.fetchall()}

            d_ref = r_map.get(lookups["previous_day_speed"])
            w_ref = r_map.get(lookups["previous_week_speed"])
            y_ref = r_map.get(lookups["previous_year_speed"])

            pred_val = None
            if d_ref is not None or w_ref is not None or y_ref is not None:
                categories = list(self.metrics["sensor_categories"])
                fallback_cat = categories[0] if categories else 400001
                safe_sid = sensor_id if sensor_id in categories else fallback_cat
                row_data = {
                    "sensor_id": pd.Categorical([safe_sid], categories=categories),
                    "previous_day_speed": np.array([np.nan if d_ref is None else d_ref], dtype=np.float32),
                    "previous_week_speed": np.array([np.nan if w_ref is None else w_ref], dtype=np.float32),
                    "previous_year_speed": np.array([np.nan if y_ref is None else y_ref], dtype=np.float32),
                }
                df = pd.DataFrame(row_data)[list(FEATURE_NAMES)]
                if model_name.lower() == "ensemble":
                    weights = self.ensemble_weights
                    p_val = sum(weights[m] * float(self.models[m].predict(df)[0]) for m in weights)
                elif model_name.lower() in self.models:
                    p_val = float(self.models[model_name.lower()].predict(df)[0])
                else:
                    p_val = None
                if p_val is not None:
                    pred_val = round(p_val, 1)

            err = round(pred_val - act_val, 1) if (act_val is not None and pred_val is not None) else None
            ape = round((abs(err) / act_val) * 100.0, 1) if (err is not None and act_val > 0) else None

            if err is not None:
                errors.append(abs(err))
            if ape is not None:
                abs_pct_errors.append(ape)

            cat, rat, _ = classify_congestion_ratio(
                act_val if act_val is not None else pred_val,
                free_flow_speed=f_speed,
                road_category=road_cat,
            )

            points.append({
                "timestamp": ts.isoformat(),
                "actual_speed": act_val,
                "predicted_speed": pred_val,
                "error": err,
                "absolute_percentage_error": ape,
                "congestion_category": cat,
                "congestion_ratio": rat,
            })

        mae = round(float(np.mean(errors)), 1) if errors else None
        mape = round(float(np.mean(abs_pct_errors)), 1) if abs_pct_errors else None
        max_err = round(float(np.max(errors)), 1) if errors else None

        return {
            "sensor_id": sensor_id,
            "target_timestamp": target_ts.isoformat(),
            "window_hours": hours,
            "model_name": model_name,
            "metrics": {
                "mae": mae,
                "mape": mape,
                "max_error": max_err,
                "data_points": len(points),
            },
            "points": points,
        }

    def update_sensor_config(
        self,
        sensor_id: int,
        free_flow_speed: Optional[float] = None,
        road_category: Optional[str] = None,
        speed_unit: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update configurable free-flow speed or road category for a sensor."""
        with self.connection_factory() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO sensor_configurations (sensor_id, free_flow_speed, road_category, speed_unit, updated_at)
                VALUES (%s, COALESCE(%s, 65.0), COALESCE(%s, 'Freeway'), COALESCE(%s, 'mph'), NOW())
                ON CONFLICT (sensor_id) DO UPDATE SET
                    free_flow_speed = COALESCE(EXCLUDED.free_flow_speed, sensor_configurations.free_flow_speed),
                    road_category = COALESCE(EXCLUDED.road_category, sensor_configurations.road_category),
                    speed_unit = COALESCE(EXCLUDED.speed_unit, sensor_configurations.speed_unit),
                    updated_at = NOW();
                """,
                (sensor_id, free_flow_speed, road_category, speed_unit),
            )
            conn.commit()

        # Update cache
        if sensor_id in self._cached_sensor_meta:
            if free_flow_speed is not None:
                self._cached_sensor_meta[sensor_id]["free_flow_speed"] = float(free_flow_speed)
            if road_category is not None:
                self._cached_sensor_meta[sensor_id]["road_category"] = str(road_category)
            if speed_unit is not None:
                self._cached_sensor_meta[sensor_id]["speed_unit"] = str(speed_unit)

        return self._cached_sensor_meta.get(sensor_id, {})
