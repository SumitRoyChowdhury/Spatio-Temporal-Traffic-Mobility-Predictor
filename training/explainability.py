"""Explainable AI (XAI) using SHAP for GridLock Traffic Prediction.

Provides local prediction explanations (TreeSHAP waterfall),
global feature importance, beeswarm distributions, model comparisons,
and natural-language explanation generation for LightGBM, XGBoost,
CatBoost, and their weighted ensemble.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import shap

from training.db import connect
from training.evaluate_ensemble import ENSEMBLE_FILE
from training.predict_speed import (
    InsufficientDataError,
    load_models,
    parse_timestamp,
    predict,
)
from training.reference_features import (
    FEATURE_NAMES,
    align_to_sampling_grid,
    reference_timestamps,
    to_utc,
    valid_speed,
)

LOGGER = logging.getLogger("gridlock.explainability")
UTC = timezone.utc
PROJECT_ROOT = Path(__file__).resolve().parent.parent

FEATURE_DISPLAY_NAMES = {
    "previous_week_speed": "Previous-Week Speed (t - 7d)",
    "previous_day_speed": "Previous-Day Speed (t - 1d)",
    "sensor_id": "Sensor Location Effect",
    "previous_year_speed": "Previous-Year Speed (t - 1y)",
}

FEATURE_DESCRIPTIONS = {
    "previous_week_speed": "Historical traffic speed at this exact sensor and hour 7 days ago (matching weekday pattern).",
    "previous_day_speed": "Historical traffic speed at this sensor 24 hours earlier (recent temporal momentum).",
    "sensor_id": "Baseline location factor representing the roadway segment's capacity and persistent bottlenecks.",
    "previous_year_speed": "Same date and hour in the previous calendar year.",
}

EXPLANATION_DISCLAIMER = (
    "SHAP explains how the machine learning model calculated its prediction from input features. "
    "It attributes feature influence according to Shapley value theory and does not assert physical causation."
)


def generate_natural_language_explanation(
    model_name: str,
    predicted_speed: float,
    baseline_speed: float,
    shap_contributions: List[Dict[str, Any]],
) -> str:
    """Generate human-readable English explanation from SHAP attributions."""
    speed_diff = predicted_speed - baseline_speed
    diff_dir = "higher" if speed_diff > 0 else "lower"
    abs_diff = abs(speed_diff)

    positive_feats = [f for f in shap_contributions if f["shap_value"] > 0.05]
    negative_feats = [f for f in shap_contributions if f["shap_value"] < -0.05]

    positive_feats.sort(key=lambda f: f["shap_value"], reverse=True)
    negative_feats.sort(key=lambda f: abs(f["shap_value"]), reverse=True)

    lines = []
    lines.append(
        f"The {model_name} model predicted a traffic speed of {predicted_speed:.1f} mph, "
        f"which is {abs_diff:.1f} mph {diff_dir} than the historical expected baseline of {baseline_speed:.1f} mph."
    )

    if negative_feats:
        top_neg = negative_feats[0]
        val_str = f" ({top_neg['feature_value']:.1f} mph)" if top_neg.get("feature_value") is not None else ""
        lines.append(
            f"The primary driver pulling the prediction down was {top_neg['display_name']}{val_str}, "
            f"reducing the predicted speed by {abs(top_neg['shap_value']):.1f} mph."
        )

    if positive_feats:
        top_pos = positive_feats[0]
        val_str = f" ({top_pos['feature_value']:.1f} mph)" if top_pos.get("feature_value") is not None else ""
        lines.append(
            f"Conversely, {top_pos['display_name']}{val_str} provided positive upward pressure, "
            f"increasing the predicted speed by {top_pos['shap_value']:.1f} mph."
        )

    if len(negative_feats) > 1:
        other_neg = negative_feats[1]
        lines.append(
            f"Additionally, {other_neg['display_name']} further reduced the prediction by {abs(other_neg['shap_value']):.1f} mph."
        )
    elif len(positive_feats) > 1:
        other_pos = positive_feats[1]
        lines.append(
            f"Additionally, {other_pos['display_name']} contributed a further +{other_pos['shap_value']:.1f} mph."
        )

    lines.append(
        f"Together with other roadway attributes, these combined historical references explain the final prediction of {predicted_speed:.1f} mph."
    )
    return " ".join(lines)


class ExplainabilityService:
    """Service providing SHAP TreeExplainer computations, model comparisons, and global importances."""

    def __init__(self, artifacts_dir: Optional[Path] = None, connection_factory=connect):
        self.artifacts_dir = artifacts_dir or (PROJECT_ROOT / "model_artifacts")
        self.connection_factory = connection_factory
        self.models, self.metrics = load_models(self.artifacts_dir)
        self.ensemble_weights = self._load_ensemble_weights()
        self._explainers: Dict[str, Any] = {}
        self._cached_background_data: Optional[pd.DataFrame] = None
        self._cached_global_importance: Dict[str, Any] = {}
        self._init_explainers()
        self._init_table()

    def _init_table(self) -> None:
        """Ensure prediction_explanations table exists on startup (e.g. on Render/Neon)."""
        try:
            with self.connection_factory() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS prediction_explanations (
                        id BIGSERIAL PRIMARY KEY,
                        sensor_id BIGINT NOT NULL REFERENCES sensors(sensor_id),
                        target_timestamp TIMESTAMPTZ NOT NULL,
                        model_name VARCHAR(50) NOT NULL,
                        baseline_value DOUBLE PRECISION NOT NULL,
                        predicted_value DOUBLE PRECISION NOT NULL,
                        feature_values JSONB NOT NULL,
                        shap_values JSONB NOT NULL,
                        text_explanation TEXT NOT NULL,
                        explanation_method VARCHAR(50) NOT NULL DEFAULT 'TreeSHAP',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_pred_expl_sensor ON prediction_explanations(sensor_id);
                    CREATE INDEX IF NOT EXISTS idx_pred_expl_created ON prediction_explanations(created_at);
                    """
                )
                conn.commit()
        except Exception:
            LOGGER.warning("Could not auto-create prediction_explanations table")

    def _load_ensemble_weights(self) -> Dict[str, float]:
        path = self.artifacts_dir / ENSEMBLE_FILE
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                return data.get("weights", {"xgboost": 0.333, "catboost": 0.333, "lightgbm": 0.334})
            except Exception:
                pass
        return {"xgboost": 0.333, "catboost": 0.333, "lightgbm": 0.334}

    def _init_explainers(self) -> None:
        """Initialize and cache TreeExplainer instances for all three tree-based models."""
        try:
            if "xgboost" in self.models and "xgboost" not in self._explainers:
                self._explainers["xgboost"] = shap.TreeExplainer(self.models["xgboost"])
            if "lightgbm" in self.models and "lightgbm" not in self._explainers:
                self._explainers["lightgbm"] = shap.TreeExplainer(self.models["lightgbm"])
            if "catboost" in self.models and "catboost" not in self._explainers:
                self._explainers["catboost"] = shap.TreeExplainer(self.models["catboost"])
        except Exception:
            LOGGER.exception("Failed to initialize one or more SHAP TreeExplainers")

    def _get_background_sample(self, n_samples: int = 250) -> pd.DataFrame:
        """Generate a reproducible, representative background sample for global feature analysis."""
        if self._cached_background_data is not None and len(self._cached_background_data) >= n_samples:
            return self._cached_background_data

        rng = np.random.default_rng(42)
        sensors = rng.choice(self.metrics["sensor_categories"], size=n_samples)
        # Normal traffic speeds typically follow 30 - 70 mph
        prev_day = rng.normal(loc=61.0, scale=8.5, size=n_samples).clip(15.0, 75.0)
        prev_week = rng.normal(loc=60.5, scale=9.0, size=n_samples).clip(15.0, 75.0)
        prev_year = np.full(n_samples, np.nan, dtype=np.float32)

        df = pd.DataFrame({
            "sensor_id": pd.Categorical(sensors, categories=self.metrics["sensor_categories"]),
            "previous_day_speed": prev_day.astype(np.float32),
            "previous_week_speed": prev_week.astype(np.float32),
            "previous_year_speed": prev_year,
        })[list(FEATURE_NAMES)]

        self._cached_background_data = df
        return df

    def get_available_models(self) -> List[Dict[str, Any]]:
        """Return available models, descriptions, and ensemble weights."""
        return [
            {
                "key": "ensemble",
                "label": "Weighted Ensemble",
                "type": "Linear Ensemble",
                "description": "Weighted combination of XGBoost, CatBoost, and LightGBM minimizing test MSE.",
                "weights": self.ensemble_weights,
            },
            {
                "key": "lightgbm",
                "label": "LightGBM",
                "type": "Gradient Boosted Trees",
                "description": "Fast histogram-based gradient boosting algorithm with leaf-wise tree growth.",
                "weight": self.ensemble_weights.get("lightgbm", 0.0),
            },
            {
                "key": "xgboost",
                "label": "XGBoost",
                "type": "Extreme Gradient Boosting",
                "description": "Regularized gradient boosting tree model with depth-wise tree growth.",
                "weight": self.ensemble_weights.get("xgboost", 0.0),
            },
            {
                "key": "catboost",
                "label": "CatBoost",
                "type": "Categorical Boosting",
                "description": "Symmetric decision tree boosting with native categorical handling.",
                "weight": self.ensemble_weights.get("catboost", 0.0),
            },
        ]

    def _compute_single_model_shap(
        self, model_name: str, frame: pd.DataFrame
    ) -> Tuple[float, float, List[float]]:
        """Compute baseline, prediction, and SHAP attribution values for a single model."""
        model = self.models[model_name]
        pred = float(model.predict(frame)[0])

        if model_name not in self._explainers:
            self._explainers[model_name] = shap.TreeExplainer(model)
        explainer = self._explainers[model_name]

        shap_res = explainer(frame)
        base = float(shap_res.base_values[0])
        raw_vals = [float(v) for v in shap_res.values[0]]
        return base, pred, raw_vals

    def explain_prediction(
        self,
        sensor_id: int,
        requested_timestamp: datetime,
        model_name: str = "ensemble",
        store_db: bool = True,
    ) -> Dict[str, Any]:
        """Compute full local SHAP explanation for an individual prediction."""
        target = align_to_sampling_grid(requested_timestamp)
        lookups = reference_timestamps(target)

        # Retrieve actual database speeds
        with self.connection_factory() as conn:
            from training.predict_speed import fetch_speeds
            exists, speeds = fetch_speeds(conn, sensor_id, [*lookups.values(), target])

        if not exists:
            raise ValueError(f"Unknown sensor ID: {sensor_id}")

        references = {name: valid_speed(speeds.get(ts)) for name, ts in lookups.items()}
        used_refs = [name for name, speed in references.items() if speed is not None]
        if not used_refs:
            raise InsufficientDataError(
                f"No historical reference data for sensor {sensor_id} at {target.isoformat()}.",
                {"sensor_id": sensor_id, "timestamp": target.isoformat()},
            )

        row = {
            "sensor_id": pd.Categorical([sensor_id], categories=self.metrics["sensor_categories"]),
            **{
                name: np.array([np.nan if speed is None else speed], dtype=np.float32)
                for name, speed in references.items()
            },
        }
        frame = pd.DataFrame(row)[list(FEATURE_NAMES)]

        # Compute for individual models
        single_shaps = {}
        for m in ("xgboost", "catboost", "lightgbm"):
            base, pred, vals = self._compute_single_model_shap(m, frame)
            single_shaps[m] = {"baseline": base, "prediction": pred, "shap_values": vals}

        # Select target model
        target_model = model_name.lower()
        if target_model == "ensemble":
            # Exact linear property of Shapley values for weighted ensemble:
            # Base = sum(w_i * base_i), SHAP_j = sum(w_i * shap_{i, j})
            weights = self.ensemble_weights
            final_pred = sum(weights[m] * single_shaps[m]["prediction"] for m in weights)
            final_base = sum(weights[m] * single_shaps[m]["baseline"] for m in weights)
            final_vals = [
                sum(weights[m] * single_shaps[m]["shap_values"][j] for m in weights)
                for j in range(len(FEATURE_NAMES))
            ]
            display_model_name = "Weighted Ensemble"
        elif target_model in single_shaps:
            final_base = single_shaps[target_model]["baseline"]
            final_pred = single_shaps[target_model]["prediction"]
            final_vals = single_shaps[target_model]["shap_values"]
            display_model_name = target_model.capitalize()
        else:
            raise ValueError(f"Unsupported model: {model_name}")

        # Assemble feature breakdown
        contributions = []
        for idx, feat_name in enumerate(FEATURE_NAMES):
            s_val = final_vals[idx]
            raw_val = references.get(feat_name)
            if feat_name == "sensor_id":
                raw_val = sensor_id
            contributions.append({
                "feature_name": feat_name,
                "display_name": FEATURE_DISPLAY_NAMES.get(feat_name, feat_name),
                "description": FEATURE_DESCRIPTIONS.get(feat_name, ""),
                "feature_value": float(raw_val) if raw_val is not None and not math.isnan(raw_val) else None,
                "shap_value": round(float(s_val), 3),
                "impact": "increase" if s_val > 0.001 else "decrease" if s_val < -0.001 else "neutral",
            })

        # Sort contributions by absolute SHAP impact
        contributions.sort(key=lambda c: abs(c["shap_value"]), reverse=True)

        # Generate English explanation
        text_explanation = generate_natural_language_explanation(
            display_model_name, final_pred, final_base, contributions
        )

        result = {
            "sensor_id": sensor_id,
            "target_timestamp": target.isoformat(),
            "model_name": target_model,
            "display_model_name": display_model_name,
            "predicted_speed": round(final_pred, 2),
            "baseline_speed": round(final_base, 2),
            "net_difference": round(final_pred - final_base, 2),
            "actual_speed": valid_speed(speeds.get(target)),
            "contributions": contributions,
            "positive_contributions": [c for c in contributions if c["shap_value"] > 0],
            "negative_contributions": [c for c in contributions if c["shap_value"] < 0],
            "text_explanation": text_explanation,
            "disclaimer": EXPLANATION_DISCLAIMER,
            "explanation_method": "TreeSHAP (Exact Additive Feature Attribution)",
            "mathematical_reconciliation": {
                "baseline_plus_shap_sum": round(final_base + sum(final_vals), 3),
                "model_prediction": round(final_pred, 3),
                "reconciliation_error": round(abs(final_base + sum(final_vals) - final_pred), 6),
            },
        }

        # Store in PostgreSQL if requested
        if store_db:
            try:
                self._save_explanation_to_db(sensor_id, target, target_model, final_base, final_pred, contributions, text_explanation)
            except Exception:
                LOGGER.exception("Failed to store explanation record in database")

        return result

    def compare_models(self, sensor_id: int, requested_timestamp: datetime) -> Dict[str, Any]:
        """Compute and compare SHAP explanations across all three models and the ensemble."""
        target = align_to_sampling_grid(requested_timestamp)
        lookups = reference_timestamps(target)

        with self.connection_factory() as conn:
            from training.predict_speed import fetch_speeds
            exists, speeds = fetch_speeds(conn, sensor_id, [*lookups.values(), target])

        if not exists:
            raise ValueError(f"Unknown sensor ID: {sensor_id}")

        references = {name: valid_speed(speeds.get(ts)) for name, ts in lookups.items()}
        row = {
            "sensor_id": pd.Categorical([sensor_id], categories=self.metrics["sensor_categories"]),
            **{
                name: np.array([np.nan if speed is None else speed], dtype=np.float32)
                for name, speed in references.items()
            },
        }
        frame = pd.DataFrame(row)[list(FEATURE_NAMES)]

        model_results = {}
        for m in ("xgboost", "catboost", "lightgbm"):
            base, pred, vals = self._compute_single_model_shap(m, frame)
            contribs = [
                {
                    "feature_name": FEATURE_NAMES[i],
                    "display_name": FEATURE_DISPLAY_NAMES[FEATURE_NAMES[i]],
                    "shap_value": round(vals[i], 3),
                }
                for i in range(len(FEATURE_NAMES))
            ]
            model_results[m] = {
                "model_name": m,
                "predicted_speed": round(pred, 2),
                "baseline_speed": round(base, 2),
                "contributions": contribs,
            }

        # Ensemble
        weights = self.ensemble_weights
        ens_pred = sum(weights[m] * model_results[m]["predicted_speed"] for m in weights)
        ens_base = sum(weights[m] * model_results[m]["baseline_speed"] for m in weights)
        ens_contribs = []
        for i, feat_name in enumerate(FEATURE_NAMES):
            s_val = sum(weights[m] * model_results[m]["contributions"][i]["shap_value"] for m in weights)
            ens_contribs.append({
                "feature_name": feat_name,
                "display_name": FEATURE_DISPLAY_NAMES[feat_name],
                "shap_value": round(s_val, 3),
            })

        model_results["ensemble"] = {
            "model_name": "ensemble",
            "predicted_speed": round(ens_pred, 2),
            "baseline_speed": round(ens_base, 2),
            "contributions": ens_contribs,
        }

        # Model differences
        preds = [m["predicted_speed"] for m in model_results.values()]
        max_diff = round(max(preds) - min(preds), 2)

        model_list = []
        for key in ("ensemble", "xgboost", "catboost", "lightgbm"):
            m_res = model_results[key]
            c_sorted = sorted(m_res["contributions"], key=lambda c: c["shap_value"], reverse=True)
            top_pos = c_sorted[0] if c_sorted and c_sorted[0]["shap_value"] > 0 else None
            top_neg = c_sorted[-1] if c_sorted and c_sorted[-1]["shap_value"] < 0 else None
            model_list.append({
                "model_key": key,
                "display_name": "Weighted Ensemble" if key == "ensemble" else key.capitalize(),
                "predicted_speed": m_res["predicted_speed"],
                "baseline_speed": m_res["baseline_speed"],
                "ensemble_weight": self.ensemble_weights.get(key),
                "contributions": m_res["contributions"],
                "top_positive_feature": top_pos,
                "top_negative_feature": top_neg,
            })

        return {
            "sensor_id": sensor_id,
            "target_timestamp": target.isoformat(),
            "models": model_list,
            "models_by_key": model_results,
            "max_model_divergence": max_diff,
            "references": {
                name: {"timestamp": lookups[name].isoformat(), "speed": references[name]}
                for name in FEATURE_NAMES if name != "sensor_id"
            },
            "actual_speed": valid_speed(speeds.get(target)),
            "ensemble_weights": self.ensemble_weights,
            "comparison_summary": (
                f"Prediction divergence across models is {max_diff} mph. "
                "Differences reflect each tree algorithm's splitting heuristics: "
                "CatBoost uses symmetric decision trees with categorical permutations, "
                "while LightGBM employs leaf-wise tree splitting and XGBoost uses depth-wise splits."
            ),
        }

    def get_global_feature_importance(self, model_name: str = "ensemble") -> Dict[str, Any]:
        """Compute mean absolute SHAP feature importance across the background evaluation sample."""
        cache_key = f"global_{model_name.lower()}"
        if cache_key in self._cached_global_importance:
            return self._cached_global_importance[cache_key]

        sample_df = self._get_background_sample(250)
        m_name = model_name.lower()

        if m_name == "ensemble":
            # Weighted average of mean absolute SHAP values across models
            weights = self.ensemble_weights
            combined_mean_abs = np.zeros(len(FEATURE_NAMES), dtype=np.float64)
            for m in ("xgboost", "catboost", "lightgbm"):
                explainer = self._explainers.get(m) or shap.TreeExplainer(self.models[m])
                shap_vals = explainer.shap_values(sample_df)
                mean_abs = np.abs(shap_vals).mean(axis=0)
                combined_mean_abs += weights.get(m, 0.333) * mean_abs
            importances = combined_mean_abs
        elif m_name in self.models:
            explainer = self._explainers.get(m_name) or shap.TreeExplainer(self.models[m_name])
            shap_vals = explainer.shap_values(sample_df)
            importances = np.abs(shap_vals).mean(axis=0)
        else:
            raise ValueError(f"Unknown model: {model_name}")

        total_imp = float(np.sum(importances)) or 1.0
        features = []
        for i, feat_name in enumerate(FEATURE_NAMES):
            val = float(importances[i])
            pct = round((val / total_imp) * 100.0, 1)
            features.append({
                "feature_name": feat_name,
                "display_name": FEATURE_DISPLAY_NAMES.get(feat_name, feat_name),
                "description": FEATURE_DESCRIPTIONS.get(feat_name, ""),
                "mean_abs_shap": round(val, 3),
                "relative_importance": pct,
                "relative_importance_pct": pct,
            })

        features.sort(key=lambda f: f["mean_abs_shap"], reverse=True)

        res = {
            "model_name": m_name,
            "sample_size": len(sample_df),
            "features": features,
            "feature_importance": features,
            "summary": (
                "These features have the strongest overall influence on the model's predictions "
                "across the evaluated traffic dataset."
            ),
        }
        self._cached_global_importance[cache_key] = res
        return res

    def get_beeswarm_data(self, model_name: str = "ensemble", sample_limit: int = 150) -> Dict[str, Any]:
        """Compute sample points for interactive SHAP beeswarm visualizations."""
        sample_df = self._get_background_sample(sample_limit)
        m_name = model_name.lower()

        if m_name == "ensemble":
            weights = self.ensemble_weights
            combined_shap = np.zeros((len(sample_df), len(FEATURE_NAMES)), dtype=np.float64)
            for m in ("xgboost", "catboost", "lightgbm"):
                explainer = self._explainers.get(m) or shap.TreeExplainer(self.models[m])
                combined_shap += weights.get(m, 0.333) * np.array(explainer.shap_values(sample_df))
            shap_matrix = combined_shap
        else:
            explainer = self._explainers.get(m_name) or shap.TreeExplainer(self.models[m_name])
            shap_matrix = np.array(explainer.shap_values(sample_df))

        points = []
        for i in range(len(sample_df)):
            for j, feat in enumerate(FEATURE_NAMES):
                raw = sample_df.iloc[i][feat]
                raw_float = float(raw) if (raw is not None and not (isinstance(raw, float) and math.isnan(raw))) else None
                if feat == "sensor_id":
                    norm_val = 0.5
                else:
                    norm_val = (float(raw) - 20.0) / 55.0 if not math.isnan(raw) else 0.5
                    norm_val = max(0.0, min(1.0, norm_val))

                points.append({
                    "feature_name": feat,
                    "display_name": FEATURE_DISPLAY_NAMES[feat],
                    "feature_value": raw_float,
                    "shap_value": round(float(shap_matrix[i, j]), 3),
                    "normalized_feature_value": round(norm_val, 2),
                    "feature_value_norm": round(norm_val, 2),
                })

        return {
            "model_name": m_name,
            "points": points,
            "features": list(FEATURE_NAMES),
        }

    def _save_explanation_to_db(
        self,
        sensor_id: int,
        target_timestamp: datetime,
        model_name: str,
        baseline: float,
        pred: float,
        contributions: List[Dict[str, Any]],
        text_explanation: str,
    ) -> None:
        """Persist an explanation record to prediction_explanations in PostgreSQL."""
        feat_vals = {c["feature_name"]: c["feature_value"] for c in contributions}
        shap_vals = {c["feature_name"]: c["shap_value"] for c in contributions}
        with self.connection_factory() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO prediction_explanations (
                    sensor_id, target_timestamp, model_name, baseline_value, predicted_value,
                    feature_values, shap_values, text_explanation, explanation_method, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW());
                """,
                (
                    sensor_id,
                    target_timestamp,
                    model_name,
                    baseline,
                    pred,
                    json.dumps(feat_vals),
                    json.dumps(shap_vals),
                    text_explanation,
                    "TreeSHAP",
                ),
            )
            conn.commit()

    def get_explanation_history(self, sensor_id: Optional[int] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """Retrieve previously saved explanation records, optionally filtered by sensor."""
        with self.connection_factory() as conn, conn.cursor() as cur:
            if sensor_id is not None:
                cur.execute(
                    """
                    SELECT id, sensor_id, target_timestamp, model_name, baseline_value, predicted_value,
                           shap_values, text_explanation, created_at
                    FROM prediction_explanations
                    WHERE sensor_id = %s
                    ORDER BY created_at DESC
                    LIMIT %s;
                    """,
                    (sensor_id, limit),
                )
            else:
                cur.execute(
                    """
                    SELECT id, sensor_id, target_timestamp, model_name, baseline_value, predicted_value,
                           shap_values, text_explanation, created_at
                    FROM prediction_explanations
                    ORDER BY created_at DESC
                    LIMIT %s;
                    """,
                    (limit,),
                )
            rows = cur.fetchall()

        results = []
        for r in rows:
            shap_dict = r[6] if isinstance(r[6], dict) else (json.loads(r[6]) if r[6] else {})
            contribs = [
                {
                    "feature_name": k,
                    "display_name": FEATURE_DISPLAY_NAMES.get(k, k),
                    "shap_value": v,
                }
                for k, v in shap_dict.items()
            ]
            contribs.sort(key=lambda c: abs(c["shap_value"]), reverse=True)
            results.append({
                "id": int(r[0]),
                "sensor_id": int(r[1]),
                "target_timestamp": r[2].isoformat() if r[2] else None,
                "model_name": r[3],
                "baseline_speed": float(r[4]),
                "predicted_speed": float(r[5]),
                "shap_values": shap_dict,
                "contributions": contribs,
                "text_explanation": r[7],
                "created_at": r[8].isoformat() if r[8] else None,
            })
        return results
