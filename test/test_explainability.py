import math
import unittest
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd

from training.reference_features import FEATURE_NAMES, align_to_sampling_grid, reference_timestamps
from training.predict_speed import InsufficientDataError
from training.explainability import (
    ExplainabilityService,
    generate_natural_language_explanation,
    EXPLANATION_DISCLAIMER,
)

UTC = timezone.utc


class FakeCursor:
    def __init__(self, database, explanation_store=None):
        self.database = database
        self.explanation_store = explanation_store if explanation_store is not None else []
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        if params is None:
            params = []
        if "FROM sensors" in query:
            sensor_id = params[0]
            self.rows = [(1,)] if sensor_id in self.database else []
        elif "FROM observations" in query:
            sensor_id = params[0]
            stored = self.database.get(sensor_id, {})
            self.rows = [(ts, stored[ts]) for ts in params[1] if ts in stored]
        elif "INSERT INTO prediction_explanations" in query:
            self.explanation_store.append(params)
            self.rows = []
        elif "SELECT id, sensor_id" in query and "FROM prediction_explanations" in query:
            # mock history query
            self.rows = []
            for item in reversed(self.explanation_store):
                self.rows.append((
                    item[0],  # id
                    item[1],  # sensor_id
                    item[2],  # target_timestamp
                    item[3],  # model_name
                    item[4],  # predicted_speed
                    item[5],  # baseline_speed
                    item[6],  # net_difference
                    item[7],  # shap_values (json)
                    item[8],  # text_explanation
                    item[9],  # created_at
                ))
        else:
            self.rows = []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, database, explanation_store=None):
        self.database = database
        self.explanation_store = explanation_store if explanation_store is not None else []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.database, self.explanation_store)

    def commit(self):
        pass


class TestExplainability(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        artifacts = Path("model_artifacts")
        if not (
            (artifacts / "reference_xgboost.json").exists()
            and (artifacts / "reference_catboost.cbm").exists()
            and (artifacts / "reference_lightgbm.txt").exists()
            and (artifacts / "reference_metrics.json").exists()
        ):
            raise unittest.SkipTest("Model artifacts not present.")

        cls.target_ts = datetime(2017, 5, 15, 8, 30, tzinfo=UTC)
        lookups = reference_timestamps(cls.target_ts)

        cls.db_store = {
            400001: {
                cls.target_ts: 62.0,
                lookups["previous_day_speed"]: 58.5,
                lookups["previous_week_speed"]: 61.2,
                lookups["previous_year_speed"]: 63.0,
            }
        }
        cls.explanation_store = []
        cls.conn_factory = lambda: FakeConnection(cls.db_store, cls.explanation_store)
        cls.service = ExplainabilityService(artifacts_dir=artifacts, connection_factory=cls.conn_factory)

    def test_available_models(self):
        models = self.service.get_available_models()
        self.assertEqual(len(models), 4)
        keys = [m["key"] for m in models]
        self.assertIn("ensemble", keys)
        self.assertIn("lightgbm", keys)
        self.assertIn("xgboost", keys)
        self.assertIn("catboost", keys)

    def test_tree_shap_additivity_xgboost(self):
        """Verify baseline + sum(SHAP) == prediction for XGBoost."""
        res = self.service.explain_prediction(
            sensor_id=400001,
            requested_timestamp=self.target_ts,
            model_name="xgboost",
            store_db=False,
        )
        base = res["baseline_speed"]
        pred = res["predicted_speed"]
        shap_sum = sum(c["shap_value"] for c in res["contributions"])
        self.assertAlmostEqual(base + shap_sum, pred, places=1)
        self.assertLess(res["mathematical_reconciliation"]["reconciliation_error"], 0.05)

    def test_tree_shap_additivity_lightgbm(self):
        """Verify baseline + sum(SHAP) == prediction for LightGBM."""
        res = self.service.explain_prediction(
            sensor_id=400001,
            requested_timestamp=self.target_ts,
            model_name="lightgbm",
            store_db=False,
        )
        base = res["baseline_speed"]
        pred = res["predicted_speed"]
        shap_sum = sum(c["shap_value"] for c in res["contributions"])
        self.assertAlmostEqual(base + shap_sum, pred, places=1)

    def test_tree_shap_additivity_catboost(self):
        """Verify baseline + sum(SHAP) == prediction for CatBoost."""
        res = self.service.explain_prediction(
            sensor_id=400001,
            requested_timestamp=self.target_ts,
            model_name="catboost",
            store_db=False,
        )
        base = res["baseline_speed"]
        pred = res["predicted_speed"]
        shap_sum = sum(c["shap_value"] for c in res["contributions"])
        self.assertAlmostEqual(base + shap_sum, pred, places=1)

    def test_tree_shap_additivity_ensemble(self):
        """Verify exact additive property of weighted linear ensemble."""
        res = self.service.explain_prediction(
            sensor_id=400001,
            requested_timestamp=self.target_ts,
            model_name="ensemble",
            store_db=False,
        )
        base = res["baseline_speed"]
        pred = res["predicted_speed"]
        shap_sum = sum(c["shap_value"] for c in res["contributions"])
        self.assertAlmostEqual(base + shap_sum, pred, places=1)
        self.assertIn("TreeSHAP", res["explanation_method"])
        self.assertIn("disclaimer", res)

    def test_natural_language_explanation_generation(self):
        contributions = [
            {"display_name": "Previous-Day Speed", "shap_value": -4.2, "feature_value": 48.0},
            {"display_name": "Previous-Week Speed", "shap_value": 1.5, "feature_value": 64.0},
            {"display_name": "Sensor Baseline", "shap_value": 0.3, "feature_value": 400001},
        ]
        text = generate_natural_language_explanation("Weighted Ensemble", 58.6, 61.0, contributions)
        self.assertIn("Weighted Ensemble", text)
        self.assertIn("Previous-Day Speed", text)
        self.assertIn("58.6 mph", text)

    def test_global_feature_importance(self):
        global_imp = self.service.get_global_feature_importance(model_name="ensemble")
        self.assertIn("feature_importance", global_imp)
        items = global_imp["feature_importance"]
        self.assertEqual(len(items), len(FEATURE_NAMES))
        # Total relative importance should sum to ~100%
        total_rel = sum(i["relative_importance"] for i in items)
        self.assertAlmostEqual(total_rel, 100.0, places=1)

    def test_beeswarm_data_generation(self):
        beeswarm = self.service.get_beeswarm_data(model_name="ensemble", sample_limit=50)
        self.assertIn("points", beeswarm)
        points = beeswarm["points"]
        self.assertGreater(len(points), 0)
        p0 = points[0]
        self.assertIn("feature_name", p0)
        self.assertIn("shap_value", p0)
        self.assertIn("feature_value_norm", p0)

    def test_model_comparison(self):
        comparison = self.service.compare_models(
            sensor_id=400001,
            requested_timestamp=self.target_ts,
        )
        self.assertIn("models", comparison)
        self.assertEqual(len(comparison["models"]), 4)
        m_keys = [m["model_key"] for m in comparison["models"]]
        self.assertEqual(set(m_keys), {"ensemble", "xgboost", "catboost", "lightgbm"})

    def test_insufficient_data_error(self):
        with self.assertRaises(InsufficientDataError):
            self.service.explain_prediction(
                sensor_id=400001,
                requested_timestamp=datetime(2010, 1, 1, 0, 0, tzinfo=UTC),
                model_name="ensemble",
                store_db=False,
            )

    def test_unknown_sensor_error(self):
        with self.assertRaises(ValueError):
            self.service.explain_prediction(
                sensor_id=999999,
                requested_timestamp=self.target_ts,
                model_name="ensemble",
                store_db=False,
            )


if __name__ == "__main__":
    unittest.main()
