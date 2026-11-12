#!/usr/bin/env python3
"""HTTP API for the traffic-speed dashboard.

Endpoints:
  GET /api/meta     sensors (locations), dataset range and model accuracy
  GET /api/predict  ?sensor_id=<id>&timestamp=<ISO-8601>; one prediction per model,
                    plus the weighted ensemble when weights have been fitted
  GET /api/evaluation  held-out test results and ensemble weights
                    (written by ``python -m training.evaluate_ensemble <csv>``)

The three models are loaded once at startup. If ``dashboard/dist`` exists
(after ``npm run build`` in ``dashboard/``), the built app is served at ``/``.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import re
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from training.db import connect
from training.evaluate_ensemble import ENSEMBLE_FILE
from training.predict_speed import (
    InsufficientDataError,
    load_models,
    parse_timestamp,
    predict,
)
from training.sensor_health import SensorHealthService

LOGGER = logging.getLogger("gridlock.api")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = PROJECT_ROOT / "dashboard" / "dist"


def _float(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def load_meta(metrics: dict[str, Any]) -> dict[str, Any]:
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT sensor_id, metadata FROM sensors ORDER BY sensor_id")
        sensors = [
            {
                "sensor_id": int(sensor_id),
                "freeway": str(meta.get("Fwy", "")).strip(),
                "direction": str(meta.get("Dir", "")).strip(),
                "name": str(meta.get("Name", "")).strip(),
                "latitude": _float(meta.get("Latitude")),
                "longitude": _float(meta.get("Longitude")),
                "postmile": _float(meta.get("Abs_PM")),
            }
            for sensor_id, meta in cursor.fetchall()
        ]
        cursor.execute("SELECT MIN(observed_at), MAX(observed_at) FROM observations")
        start, end = cursor.fetchone()
    return {
        "sensors": sensors,
        "data_start": start.isoformat() if start else None,
        "data_end": end.isoformat() if end else None,
        "models": {
            name: {"mae": metrics["models"][name]["mae"], "rmse": metrics["models"][name]["rmse"]}
            for name in ("xgboost", "catboost", "lightgbm")
        },
    }


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, artifacts_dir: Path):
        super().__init__(address, DashboardHandler)
        self.artifacts_dir = artifacts_dir
        self.models, self.metrics = load_models(artifacts_dir)
        self.model_lock = threading.Lock()
        self._meta: dict[str, Any] | None = None
        self.health_service = SensorHealthService()
        ensemble_path = artifacts_dir / ENSEMBLE_FILE
        self.evaluation: dict[str, Any] | None = (
            json.loads(ensemble_path.read_text(encoding="utf-8"))
            if ensemble_path.is_file()
            else None
        )
        self._stop_monitor = threading.Event()
        self._monitor_thread = threading.Thread(target=self._background_monitor_loop, daemon=True)
        self._monitor_thread.start()

    def _background_monitor_loop(self) -> None:
        # Run periodic monitoring cycle every 60s
        while not self._stop_monitor.wait(60):
            try:
                self.health_service.run_monitoring_cycle()
            except Exception:
                LOGGER.exception("Error in background health monitor loop")

    def server_close(self) -> None:
        self._stop_monitor.set()
        super().server_close()

    @property
    def meta(self) -> dict[str, Any]:
        if self._meta is None:
            self._meta = load_meta(self.metrics)
        return self._meta


class DashboardHandler(BaseHTTPRequestHandler):
    server: DashboardServer

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        LOGGER.info("%s %s", self.address_string(), format % args)

    def _json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        payload = json.dumps(body, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            return {}
        raw = self.rfile.read(content_length).decode("utf-8")
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def do_GET(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        path = url.path.rstrip("/")
        query = parse_qs(url.query)
        try:
            if path == "/api/meta":
                self._json(HTTPStatus.OK, self.server.meta)
            elif path == "/api/evaluation":
                if self.server.evaluation is None:
                    self._json(HTTPStatus.NOT_FOUND, {"error": "No evaluation has been run yet."})
                else:
                    self._json(HTTPStatus.OK, self.server.evaluation)
            elif path == "/api/predict":
                self._predict(query)
            # --- Sensor Health Monitoring APIs ---
            elif path in ("/api/sensors/health", "/api/sensors/health/summary"):
                ref_time = (query.get("ref_time") or [None])[0]
                summary = self.server.health_service.get_sensor_health_summary(ref_time)
                self._json(HTTPStatus.OK, summary)
            elif path == "/api/sensors/alerts":
                sev = (query.get("severity") or [None])[0]
                res_str = (query.get("resolved") or [None])[0]
                resolved = None
                if res_str is not None:
                    resolved = res_str.lower() in ("true", "1", "yes")
                sensor_id_str = (query.get("sensor_id") or [None])[0]
                sensor_id = int(sensor_id_str) if sensor_id_str and sensor_id_str.isdigit() else None
                page = int((query.get("page") or ["1"])[0])
                limit = int((query.get("limit") or ["50"])[0])
                alerts = self.server.health_service.get_alerts(
                    severity=sev, is_resolved=resolved, sensor_id=sensor_id, page=page, limit=limit
                )
                self._json(HTTPStatus.OK, alerts)
            elif path == "/api/sensors":
                ref_time = (query.get("ref_time") or [None])[0]
                status_filter = (query.get("status") or [None])[0]
                location_filter = (query.get("location") or [None])[0]
                search = (query.get("search") or [None])[0]
                sort_by = (query.get("sort_by") or [None])[0]
                order = (query.get("order") or ["asc"])[0]
                page = int((query.get("page") or ["1"])[0])
                limit = int((query.get("limit") or ["50"])[0])
                result = self.server.health_service.get_all_sensors(
                    reference_time_str=ref_time,
                    status_filter=status_filter,
                    location_filter=location_filter,
                    search=search,
                    sort_by=sort_by,
                    order=order,
                    page=page,
                    limit=limit,
                )
                self._json(HTTPStatus.OK, result)
            elif re.match(r"^/api/sensors/\d+/history$", path):
                match = re.match(r"^/api/sensors/(\d+)/history$", path)
                sid = int(match.group(1))
                days = int((query.get("days") or ["7"])[0])
                ref_time = (query.get("ref_time") or [None])[0]
                history = self.server.health_service.get_sensor_history(sid, days=days, reference_time_str=ref_time)
                self._json(HTTPStatus.OK, {"sensor_id": sid, "history": history})
            elif re.match(r"^/api/sensors/\d+/readings$", path):
                match = re.match(r"^/api/sensors/(\d+)/readings$", path)
                sid = int(match.group(1))
                limit = int((query.get("limit") or ["50"])[0])
                ref_time = (query.get("ref_time") or [None])[0]
                readings = self.server.health_service.get_sensor_readings(sid, limit=limit, reference_time_str=ref_time)
                self._json(HTTPStatus.OK, {"sensor_id": sid, "readings": readings})
            elif re.match(r"^/api/sensors/\d+$", path):
                match = re.match(r"^/api/sensors/(\d+)$", path)
                sid = int(match.group(1))
                ref_time = (query.get("ref_time") or [None])[0]
                detail = self.server.health_service.get_sensor_details(sid, reference_time_str=ref_time)
                if not detail:
                    self._json(HTTPStatus.NOT_FOUND, {"error": f"Sensor {sid} not found."})
                else:
                    self._json(HTTPStatus.OK, detail)
            elif path.startswith("/api/"):
                self._json(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint."})
            else:
                self._static(url.path)
        except Exception:  # pragma: no cover - last-resort error response
            LOGGER.exception("Request failed: %s", self.path)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Internal server error."})

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle_mutation()

    def do_POST(self) -> None:  # noqa: N802
        self._handle_mutation()

    def _handle_mutation(self) -> None:
        url = urlsplit(self.path)
        path = url.path.rstrip("/")
        body = self._read_json_body()
        try:
            # Resolve alert: /api/sensors/alerts/<id>/resolve
            resolve_match = re.match(r"^/api/sensors/alerts/(\d+)/resolve$", path)
            if resolve_match:
                alert_id = int(resolve_match.group(1))
                resolved = self.server.health_service.resolve_alert(alert_id)
                if not resolved:
                    self._json(HTTPStatus.NOT_FOUND, {"error": f"Alert {alert_id} not found."})
                else:
                    self._json(HTTPStatus.OK, resolved)
                return

            # Update sensor config: /api/sensors/<id>/config
            config_match = re.match(r"^/api/sensors/(\d+)/config$", path)
            if config_match:
                sensor_id = int(config_match.group(1))
                updated = self.server.health_service.update_sensor_config(sensor_id, **body)
                if not updated:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid configuration payload."})
                else:
                    self._json(HTTPStatus.OK, updated)
                return

            # Trigger manual monitoring check: /api/sensors/health/check
            if path == "/api/sensors/health/check":
                ref_time = body.get("ref_time")
                result = self.server.health_service.run_monitoring_cycle(ref_time)
                self._json(HTTPStatus.OK, result)
                return

            self._json(HTTPStatus.NOT_FOUND, {"error": f"Unknown endpoint: {path}"})
        except Exception:
            LOGGER.exception("Mutation request failed: %s", self.path)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Internal server error."})

    def _predict(self, query: dict[str, list[str]]) -> None:
        sensor_text = (query.get("sensor_id") or [""])[0]
        timestamp_text = (query.get("timestamp") or [""])[0]
        if not sensor_text.isdigit():
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Choose a location (sensor)."})
            return
        try:
            timestamp = parse_timestamp(timestamp_text)
        except ValueError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Enter a valid date and time."})
            return
        try:
            with self.server.model_lock:
                result = predict(
                    int(sensor_text),
                    timestamp,
                    self.server.artifacts_dir,
                    model_loader=lambda _: (self.server.models, self.server.metrics),
                )
        except InsufficientDataError as error:
            self._json(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"error": str(error), "insufficient_data": True, **error.result},
            )
            return
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if self.server.evaluation is not None:
            weights = self.server.evaluation["weights"]
            by_model = result["predicted_speed_by_model"]
            result["ensemble_weights"] = weights
            result["weighted_predicted_speed"] = sum(
                weights[name] * by_model[name] for name in weights
            )
        self._json(HTTPStatus.OK, result)

    def _static(self, path: str) -> None:
        if not STATIC_DIR.is_dir():
            self._json(
                HTTPStatus.NOT_FOUND,
                {"error": "Dashboard is not built. Run `npm run build` in dashboard/, "
                          "or use `npm run dev` there during development."},
            )
            return
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            target = STATIC_DIR / "index.html"  # single-page app fallback
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the traffic-speed dashboard API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--artifacts-dir", type=Path, default=PROJECT_ROOT / "model_artifacts")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    server = DashboardServer((args.host, args.port), args.artifacts_dir.resolve())
    LOGGER.info("Dashboard API on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
