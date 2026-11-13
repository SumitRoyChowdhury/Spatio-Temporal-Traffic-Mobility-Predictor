import React from "react";

export default function SensorInfoPanel({ sensor, onClose, onModelChange, activeModel = "ensemble" }) {
  if (!sensor) return null;

  const freeFlow = sensor.free_flow_speed || 65.0;
  const actualSpd = sensor.actual_speed;
  const predSpd = sensor.predicted_speed;
  const effSpd = sensor.effective_speed;
  const ratio = sensor.congestion_ratio != null ? (sensor.congestion_ratio * 100).toFixed(0) : "—";
  const delta = (predSpd != null && actualSpd != null) ? (predSpd - actualSpd).toFixed(1) : null;

  const categoryColor =
    sensor.color ||
    (sensor.congestion_category === "FREE_FLOW"
      ? "#10b981"
      : sensor.congestion_category === "MODERATE"
      ? "#f59e0b"
      : sensor.congestion_category === "HEAVY"
      ? "#ef4444"
      : "#6b7280");

  return (
    <div className="sim-sensor-panel">
      <div className="sim-sensor-header">
        <div className="sim-sensor-title">
          <span className="sim-sensor-badge" style={{ backgroundColor: categoryColor }}>
            {sensor.congestion_label || sensor.congestion_category}
          </span>
          <h4>{sensor.name || `Sensor ${sensor.sensor_id}`}</h4>
          <span className="sim-sensor-fwy">
            Fwy {sensor.freeway} {sensor.direction} · MP {sensor.postmile}
          </span>
        </div>
        <button type="button" className="sim-close-btn" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>

      <div className="sim-metrics-grid">
        <div className="sim-metric-card">
          <span className="sim-metric-label">Effective Speed</span>
          <span className="sim-metric-value" style={{ color: categoryColor }}>
            {effSpd ? `${effSpd.toFixed(1)}` : "—"}
            <span className="sim-metric-unit">mph</span>
          </span>
          <span className="sim-metric-sub">
            Source: <strong>{sensor.source || "model"}</strong>
          </span>
        </div>

        <div className="sim-metric-card">
          <span className="sim-metric-label">Actual Speed</span>
          <span className="sim-metric-value">
            {actualSpd != null ? `${actualSpd.toFixed(1)}` : "—"}
            <span className="sim-metric-unit">mph</span>
          </span>
          <span className="sim-metric-sub">
            Health: <span className={sensor.health_status === "ONLINE" ? "text-green" : "text-amber"}>{sensor.health_status || "ONLINE"}</span>
          </span>
        </div>

        <div className="sim-metric-card">
          <span className="sim-metric-label">ML Prediction</span>
          <span className="sim-metric-value text-blue">
            {predSpd != null ? `${predSpd.toFixed(1)}` : "—"}
            <span className="sim-metric-unit">mph</span>
          </span>
          <span className="sim-metric-sub">
            {delta != null ? (
              <span>
                Residual: {delta > 0 ? `+${delta}` : delta} mph
              </span>
            ) : (
              "Live inference"
            )}
          </span>
        </div>

        <div className="sim-metric-card">
          <span className="sim-metric-label">Congestion Ratio</span>
          <span className="sim-metric-value" style={{ color: categoryColor }}>
            {ratio}%
          </span>
          <span className="sim-metric-sub">Ref: {freeFlow} mph</span>
        </div>
      </div>

      <div className="sim-physics-strip">
        <div className="sim-physics-col">
          <span className="sim-physics-title">Traffic Density (k)</span>
          <span className="sim-physics-val">{sensor.traffic_density_veh_km || 35} veh/km</span>
        </div>
        <div className="sim-physics-col">
          <span className="sim-physics-title">Flow Rate (q = k · v)</span>
          <span className="sim-physics-val">{sensor.flow_rate_veh_hr || 2150} veh/hr</span>
        </div>
        <div className="sim-physics-col">
          <span className="sim-physics-title">Lanes</span>
          <span className="sim-physics-val">{sensor.lanes || 3} lanes</span>
        </div>
        <div className="sim-physics-col">
          <span className="sim-physics-title">Coordinates</span>
          <span className="sim-physics-val">
            {sensor.latitude?.toFixed(3)}, {sensor.longitude?.toFixed(3)}
          </span>
        </div>
      </div>

      {onModelChange && (
        <div className="sim-model-selector-row">
          <span className="subtle small">Select Active Model:</span>
          <div className="sim-model-pills">
            {["ensemble", "xgboost", "catboost", "lightgbm", "actual"].map((m) => (
              <button
                key={m}
                type="button"
                className={`sim-pill-btn${activeModel === m ? " sim-pill-active" : ""}`}
                onClick={() => onModelChange(m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
