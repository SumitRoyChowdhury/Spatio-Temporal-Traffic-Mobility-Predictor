import React, { useEffect, useRef, useState } from "react";
import { HighwaySceneEngine } from "./simulator/HighwayScene.js";
import SimulationControls from "./simulator/SimulationControls.jsx";
import SensorInfoPanel from "./simulator/SensorInfoPanel.jsx";
import { checkWebXRSupport, getWebXRDiagnosticSummary } from "./simulator/webXRSupport.js";

export default function TrafficSimulator({ meta, groups, defaultSensorId, onSelectSensor }) {
  // State
  const [corridors, setCorridors] = useState([]);
  const [selectedCorridor, setSelectedCorridor] = useState("85-N");
  const [selectedModel, setSelectedModel] = useState("ensemble");
  const [timestamp, setTimestamp] = useState("2017-05-15T08:30");
  const [congestionFilter, setCongestionFilter] = useState("ALL");
  const [isPaused, setIsPaused] = useState(false);
  const [simSpeed, setSimSpeed] = useState(1.0);
  const [cameraMode, setCameraMode] = useState("aerial");
  const [selectedSensor, setSelectedSensor] = useState(null);
  const [sceneData, setSceneData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [xrSupport, setXrSupport] = useState({ vrSupported: false, arSupported: false });
  const [xrModal, setXrModal] = useState(null); // { type: 'vr'|'ar', title, message }

  const mountRef = useRef(null);
  const engineRef = useRef(null);

  // Check WebXR capabilities
  useEffect(() => {
    checkWebXRSupport().then(setXrSupport);
  }, []);

  // Fetch available corridors
  useEffect(() => {
    fetch("/api/simulator/corridors")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (data.corridors && data.corridors.length > 0) {
          setCorridors(data.corridors);
        }
      })
      .catch(() => {
        // Fallback default corridors
        setCorridors([
          { key: "85-N", freeway: "85", direction: "N", name: "CA-85 North (Silicon Valley)", sensor_count: 35 },
          { key: "101-N", freeway: "101", direction: "N", name: "US-101 North (Bayshore)", sensor_count: 52 },
          { key: "880-N", freeway: "880", direction: "N", name: "I-880 North (Nimitz)", sensor_count: 42 },
          { key: "280-N", freeway: "280", direction: "N", name: "I-280 North (Junipero Serra)", sensor_count: 38 },
        ]);
      });
  }, []);

  // Fetch highway scene data
  useEffect(() => {
    setLoading(true);
    setError("");

    const [fwy, dir] = selectedCorridor.split("-");
    const query = new URLSearchParams({
      freeway: fwy,
      direction: dir,
      timestamp: timestamp,
      model: selectedModel,
      max_sensors: "8",
    });

    fetch(`/api/simulator/highway?${query.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error("Simulator API unavailable");
        return res.json();
      })
      .then((data) => {
        setSceneData(data);
        if (data.sensors && data.sensors.length > 0) {
          // Keep current selected sensor if present in new corridor, or select first
          const existing = data.sensors.find((s) => s.sensor_id === selectedSensor?.sensor_id);
          setSelectedSensor(existing || data.sensors[0]);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError("Failed to load highway simulation data. Check backend connection.");
        setLoading(false);
      });
  }, [selectedCorridor, selectedModel, timestamp]);

  // Initialize Three.js Engine once mountRef is ready
  useEffect(() => {
    if (!mountRef.current) return;

    const engine = new HighwaySceneEngine(mountRef.current, {
      onSelectSensor: (sensor) => {
        setSelectedSensor(sensor);
        if (onSelectSensor) onSelectSensor(sensor.sensor_id);
      },
      onXRStateChange: (state) => {
        // Handled in WebXR
      },
    });

    engineRef.current = engine;

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Feed scene data into 3D engine whenever sceneData updates
  useEffect(() => {
    if (engineRef.current && sceneData) {
      engineRef.current.loadHighwayData(sceneData);
      if (selectedSensor) {
        engineRef.current.selectSensor(selectedSensor.sensor_id);
      }
    }
  }, [sceneData]);

  // Handle Play/Pause
  const handleTogglePause = () => {
    if (engineRef.current) {
      const paused = engineRef.current.togglePause();
      setIsPaused(paused);
    }
  };

  // Handle Sim Speed
  const handleSimSpeedChange = (speed) => {
    setSimSpeed(speed);
    if (engineRef.current) {
      engineRef.current.setSimSpeed(speed);
    }
  };

  // Handle Camera Mode
  const handleCameraModeChange = (mode) => {
    setCameraMode(mode);
    if (engineRef.current) {
      engineRef.current.setCameraPreset(mode);
    }
  };

  // Handle Reset Camera
  const handleResetCamera = () => {
    setCameraMode("aerial");
    if (engineRef.current) {
      engineRef.current.setCameraPreset("aerial");
    }
  };

  // WebXR VR Trigger
  const handleEnterVR = async () => {
    if (!xrSupport.vrSupported) {
      setXrModal({
        type: "vr",
        title: "WebXR VR Hardware Required",
        message:
          "WebXR Virtual Reality requires a compatible headset (such as Meta Quest 2/3/Pro running Meta Quest Browser, HTC Vive, or a PC VR headset connected via SteamVR/Oculus Link in Google Chrome). On standard desktop computers, the simulator runs in full interactive 3D simulation with 360° OrbitControls and Driver Dashcam camera views.",
      });
      return;
    }

    try {
      if (engineRef.current) {
        await engineRef.current.enterVR();
      }
    } catch (err) {
      setXrModal({
        type: "vr",
        title: "Failed to Start VR Session",
        message: `Could not launch immersive-vr session: ${err.message}. Ensure your headset is awake and permissions are granted.`,
      });
    }
  };

  // WebXR AR Trigger
  const handleEnterAR = async () => {
    if (!xrSupport.arSupported) {
      setXrModal({
        type: "ar",
        title: "WebXR AR Hardware Required",
        message:
          "WebXR Augmented Reality tabletop placement requires an AR-capable device (such as Google Chrome on Android with Google Play Services for AR / ARCore, or an AR-enabled WebXR headset). When active, you can detect tables or floor surfaces and place a miniature 3D highway in your real-world room.",
      });
      return;
    }

    try {
      if (engineRef.current) {
        await engineRef.current.enterAR();
      }
    } catch (err) {
      setXrModal({
        type: "ar",
        title: "Failed to Start AR Session",
        message: `Could not launch immersive-ar session: ${err.message}. Verify camera permissions and surface detection.`,
      });
    }
  };

  const diag = getWebXRDiagnosticSummary(xrSupport);

  return (
    <div className="sim-layout-container">
      {/* 3D Canvas Mount Point */}
      <div className="sim-viewport-wrapper">
        <div ref={mountRef} className="sim-canvas-viewport" />

        {/* Top HUD overlay */}
        <div className="sim-hud-top">
          <div className="sim-hud-badge">
            <span className="sim-hud-pulse" />
            <span className="sim-hud-title">
              {sceneData?.corridor_name || "Highway Corridor"}
            </span>
          </div>

          <div className="sim-hud-pills">
            <span className="sim-hud-pill">
              Length: <strong>{sceneData?.total_length_km || 0} km</strong>
            </span>
            <span className="sim-hud-pill">
              Sensors: <strong>{sceneData?.total_sensors || 0}</strong>
            </span>
            <span className="sim-hud-pill">
              Active Model: <strong className="text-blue">{selectedModel.toUpperCase()}</strong>
            </span>
            <span
              className="sim-hud-pill"
              style={{ borderColor: diag.color, color: diag.color }}
              title={diag.description}
            >
              {diag.badge}
            </span>
          </div>
        </div>

        {/* Bottom Instructions pill */}
        <div className="sim-hud-bottom">
          <span>
            🖱️ <strong>Left Click + Drag</strong> to rotate · <strong>Scroll</strong> to zoom · <strong>Right Click</strong> to pan · <strong>Click Sensor Pods</strong> to inspect telemetry
          </span>
        </div>

        {/* Floating Sensor Info Panel when sensor is selected */}
        {selectedSensor && (
          <SensorInfoPanel
            sensor={selectedSensor}
            onClose={() => setSelectedSensor(null)}
            onModelChange={setSelectedModel}
            activeModel={selectedModel}
          />
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="sim-loading-overlay">
            <div className="sim-spinner" />
            <p>Generating 3D highway corridor & calculating ML speed fields…</p>
          </div>
        )}

        {/* Error overlay */}
        {error && (
          <div className="sim-error-banner">
            <p>⚠️ {error}</p>
          </div>
        )}
      </div>

      {/* Control Sidebar */}
      <SimulationControls
        corridors={corridors}
        selectedCorridor={selectedCorridor}
        onSelectCorridor={setSelectedCorridor}
        models={["ensemble", "xgboost", "catboost", "lightgbm", "actual"]}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        timestamp={timestamp}
        onTimestampChange={setTimestamp}
        congestionFilter={congestionFilter}
        onCongestionFilterChange={setCongestionFilter}
        isPaused={isPaused}
        onTogglePause={handleTogglePause}
        simSpeed={simSpeed}
        onSimSpeedChange={handleSimSpeedChange}
        cameraMode={cameraMode}
        onCameraModeChange={handleCameraModeChange}
        onResetCamera={handleResetCamera}
        onEnterVR={handleEnterVR}
        onEnterAR={handleEnterAR}
        xrSupport={xrSupport}
        onReturnToDashboard={() => {
          if (typeof window !== "undefined") window.location.hash = "";
        }}
      />

      {/* WebXR Guidance Modal */}
      {xrModal && (
        <div className="sim-modal-backdrop" onClick={() => setXrModal(null)}>
          <div className="sim-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="sim-modal-icon">
              {xrModal.type === "vr" ? "🥽" : "📱"}
            </div>
            <h3>{xrModal.title}</h3>
            <p className="sim-modal-text">{xrModal.message}</p>
            <div className="sim-modal-footer">
              <button
                type="button"
                className="sim-modal-confirm-btn"
                onClick={() => setXrModal(null)}
              >
                Continue in 3D Desktop Mode
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
