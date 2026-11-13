import React from "react";

export default function SimulationControls({
  corridors = [],
  selectedCorridor = "85-N",
  onSelectCorridor,
  models = ["ensemble", "xgboost", "catboost", "lightgbm", "actual"],
  selectedModel = "ensemble",
  onSelectModel,
  timestamp = "2017-05-15T08:30",
  onTimestampChange,
  congestionFilter = "ALL",
  onCongestionFilterChange,
  isPaused = false,
  onTogglePause,
  simSpeed = 1.0,
  onSimSpeedChange,
  cameraMode = "aerial",
  onCameraModeChange,
  onResetCamera,
  onEnterVR,
  onEnterAR,
  xrSupport = {},
  onReturnToDashboard,
}) {
  return (
    <aside className="sim-controls-sidebar">
      <div className="sim-controls-header">
        <div className="sim-title-group">
          <h3>Traffic Intelligence Simulator</h3>
          <span className="sim-mode-tag">WebXR Immersive 3D</span>
        </div>
      </div>

      <div className="sim-control-group">
        <label className="sim-label" htmlFor="sim-corridor-select">Highway Corridor</label>
        <select
          id="sim-corridor-select"
          className="sim-select"
          value={selectedCorridor}
          onChange={(e) => onSelectCorridor(e.target.value)}
        >
          {corridors.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name} ({c.sensor_count} sensors)
            </option>
          ))}
        </select>
      </div>

      <div className="sim-control-group">
        <label className="sim-label" htmlFor="sim-model-select">ML Prediction Engine</label>
        <select
          id="sim-model-select"
          className="sim-select"
          value={selectedModel}
          onChange={(e) => onSelectModel(e.target.value)}
        >
          <option value="ensemble">Weighted Ensemble (Best MAE: 2.37 mph)</option>
          <option value="catboost">CatBoost Regressor</option>
          <option value="lightgbm">LightGBM Regressor</option>
          <option value="xgboost">XGBoost Regressor</option>
          <option value="actual">Ground Truth Sensor Observations</option>
        </select>
      </div>

      <div className="sim-control-group">
        <label className="sim-label" htmlFor="sim-timestamp-input">Simulation Date & Time (UTC)</label>
        <input
          id="sim-timestamp-input"
          type="datetime-local"
          className="sim-input"
          value={timestamp}
          onChange={(e) => onTimestampChange(e.target.value)}
        />
      </div>

      <div className="sim-control-group">
        <label className="sim-label">Congestion Filter</label>
        <div className="sim-btn-grid-4">
          {["ALL", "FREE_FLOW", "MODERATE", "HEAVY"].map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`sim-mini-btn${congestionFilter === lvl ? " sim-mini-btn-active" : ""}`}
              onClick={() => onCongestionFilterChange(lvl)}
            >
              {lvl.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      <div className="sim-control-group">
        <label className="sim-label">Camera Navigation View</label>
        <div className="sim-btn-grid-2">
          <button
            type="button"
            className={`sim-view-btn${cameraMode === "aerial" ? " sim-view-btn-active" : ""}`}
            onClick={() => onCameraModeChange("aerial")}
          >
            🛰️ Drone Aerial
          </button>
          <button
            type="button"
            className={`sim-view-btn${cameraMode === "driver" ? " sim-view-btn-active" : ""}`}
            onClick={() => onCameraModeChange("driver")}
          >
            🚗 Driver View
          </button>
          <button
            type="button"
            className={`sim-view-btn${cameraMode === "roadside" ? " sim-view-btn-active" : ""}`}
            onClick={() => onCameraModeChange("roadside")}
          >
            🔭 Roadside Tower
          </button>
          <button
            type="button"
            className={`sim-view-btn${cameraMode === "sensor" ? " sim-view-btn-active" : ""}`}
            onClick={() => onCameraModeChange("sensor")}
          >
            📍 Sensor Focus
          </button>
        </div>
      </div>

      <div className="sim-control-group">
        <label className="sim-label">Vehicle Kinematics & Playback</label>
        <div className="sim-playback-row">
          <button
            type="button"
            className={`sim-play-btn${isPaused ? " sim-play-btn-paused" : ""}`}
            onClick={onTogglePause}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <div className="sim-speed-pills">
            {[0.5, 1.0, 2.0, 5.0].map((s) => (
              <button
                key={s}
                type="button"
                className={`sim-speed-pill${simSpeed === s ? " sim-speed-active" : ""}`}
                onClick={() => onSimSpeedChange(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* WebXR Immersive AR / VR Section */}
      <div className="sim-xr-section">
        <label className="sim-label">WebXR Immersive Modes</label>
        <div className="sim-xr-buttons">
          <button
            type="button"
            className={`sim-xr-btn sim-vr-btn${xrSupport.vrSupported ? " sim-xr-ready" : ""}`}
            onClick={onEnterVR}
          >
            <span className="sim-xr-icon">🥽</span>
            <span className="sim-xr-text">
              <strong>Enter VR</strong>
              <small>{xrSupport.vrSupported ? "Headset Ready" : "Meta Quest / OpenXR"}</small>
            </span>
          </button>

          <button
            type="button"
            className={`sim-xr-btn sim-ar-btn${xrSupport.arSupported ? " sim-xr-ready" : ""}`}
            onClick={onEnterAR}
          >
            <span className="sim-xr-icon">📱</span>
            <span className="sim-xr-text">
              <strong>Enter AR</strong>
              <small>{xrSupport.arSupported ? "Surface Hit-Test" : "Tabletop Placement"}</small>
            </span>
          </button>
        </div>

        <div className="sim-xr-diag">
          <span
            className="sim-diag-dot"
            style={{
              backgroundColor:
                xrSupport.vrSupported || xrSupport.arSupported ? "#10b981" : "#64748b",
            }}
          />
          <span className="sim-diag-text">
            {xrSupport.vrSupported && xrSupport.arSupported
              ? "VR & AR hardware supported"
              : xrSupport.vrSupported
              ? "VR Headset mode supported"
              : xrSupport.arSupported
              ? "AR mobile surface placement supported"
              : "Desktop 3D mode (Hardware fallback)"}
          </span>
        </div>
      </div>

      <div className="sim-footer-actions">
        <button type="button" className="sim-action-btn" onClick={onResetCamera}>
          🔄 Reset Camera
        </button>
        {onReturnToDashboard && (
          <button type="button" className="sim-return-btn" onClick={onReturnToDashboard}>
            ← Return to Dashboard
          </button>
        )}
      </div>
    </aside>
  );
}
