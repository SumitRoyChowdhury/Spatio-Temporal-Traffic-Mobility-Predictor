import { useState } from "react";
import SensorMap from "./SensorMap.jsx";

const formatSpeed = (v) => (v == null ? "—" : Number(v).toFixed(1));

export default function AnomalyDetection({ meta, groups, sensorsById }) {
  const defaultSensor = meta?.sensors?.[0]?.sensor_id ?? 400001;
  const [sensorId, setSensorId] = useState(defaultSensor);
  const [timestamp, setTimestamp] = useState("2017-06-01T08:30");
  const [state, setState] = useState({ status: "idle" });

  const selected = sensorsById?.get(sensorId);

  function sensorLabel(s) {
    return `${s.name || "Unnamed"} · ${s.sensor_id}`;
  }

  async function runAnalysis(event) {
    event.preventDefault();
    setState({ status: "loading" });
    const query = new URLSearchParams({ sensor_id: String(sensorId), timestamp });
    try {
      const response = await fetch(`/api/predict?${query}`);
      const body = await response.json();
      if (response.ok) {
        setState({ status: "done", result: body });
      } else if (body.insufficient_data) {
        setState({ status: "insufficient", result: body });
      } else {
        setState({ status: "error", message: body.error ?? "Analysis failed." });
      }
    } catch {
      setState({ status: "error", message: "Could not reach the prediction API." });
    }
  }

  return (
    <div className="anomaly-page">
      <div className="anomaly-page-header">
        <h2>Traffic Anomaly Detection</h2>
        <p className="subtle">
          Monitor unusual traffic behaviour and identify abnormal speed variations
          using historical traffic observations.
        </p>
      </div>

      <div className="anomaly-layout">
        {/* Left: controls */}
        <form className="card controls" onSubmit={runAnalysis}>
          <label className="field">
            <span>Sensor</span>
            <select
              value={sensorId}
              onChange={(e) => setSensorId(Number(e.target.value))}
              disabled={!meta}
            >
              {!meta && <option>Loading sensors…</option>}
              {(groups ?? []).map((group) => (
                <optgroup key={group.key} label={group.key}>
                  {group.sensors.map((sensor) => (
                    <option key={sensor.sensor_id} value={sensor.sensor_id}>
                      {sensorLabel(sensor)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {meta && (
            <SensorMap sensors={meta.sensors} selectedId={sensorId} onSelect={setSensorId} />
          )}

          {selected && (
            <p className="subtle small">
              Fwy {selected.freeway} {selected.direction} · {selected.name || "Unnamed"} ·{" "}
              {selected.latitude?.toFixed(4)}, {selected.longitude?.toFixed(4)}
            </p>
          )}

          <label className="field">
            <span>Date and time (UTC)</span>
            <input
              type="datetime-local"
              step="300"
              value={timestamp}
              onChange={(e) => setTimestamp(e.target.value)}
              required
            />
          </label>
          {meta?.data_start && (
            <p className="subtle small">
              Recorded data covers {meta.data_start.slice(0, 10)} to {meta.data_end.slice(0, 10)}.
            </p>
          )}

          <button type="submit" disabled={!meta || state.status === "loading"}>
            {state.status === "loading" ? "Analysing…" : "Run anomaly analysis"}
          </button>
        </form>

        {/* Right: results */}
        <div className="anomaly-results">
          <AnomalyResults state={state} sensor={selected} />
        </div>
      </div>
    </div>
  );
}

function AnomalyResults({ state, sensor }) {
  if (state.status === "idle") {
    return (
      <div className="card empty">
        <p className="subtle">
          Select a sensor and time, then run the anomaly analysis.
        </p>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="card empty">
        <p className="subtle">Analysing traffic data…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="card notice">{state.message}</div>;
  }
  if (state.status === "insufficient") {
    return <InsufficientState result={state.result} sensor={sensor} />;
  }

  const { result } = state;
  const detected = result.anomaly_detected;
  const severity = result.anomaly_severity;
  const anomalyType = result.anomaly_type;
  const explanation = result.anomaly_explanation;
  const currentSpeed = result.anomaly_current_speed ?? result.mean_predicted_speed;
  const historicalMedian = result.anomaly_historical_median;
  const deviation = result.anomaly_deviation;
  const mad = result.anomaly_mad;

  if (detected) {
    return <AnomalyState severity={severity} anomalyType={anomalyType} explanation={explanation}
      currentSpeed={currentSpeed} historicalMedian={historicalMedian} deviation={deviation} mad={mad}
      sensor={sensor} result={result} />;
  }

  return <NormalState explanation={explanation} currentSpeed={currentSpeed}
    historicalMedian={historicalMedian} sensor={sensor} result={result} />;
}

/* ─── NORMAL STATE ─── */
function NormalState({ explanation, currentSpeed, historicalMedian, sensor, result }) {
  return (
    <>
      <SensorHeading sensor={sensor} result={result} />
      {/* Status cards */}
      <div className="anomaly-status-cards">
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Detection Status</span>
          <span className="anomaly-badge anomaly-badge-normal">NORMAL TRAFFIC</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Severity</span>
          <span className="anomaly-stat-value">None</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Current Speed</span>
          <span className="anomaly-stat-value">{formatSpeed(currentSpeed)} <span className="unit">mph</span></span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Historical Median</span>
          <span className="anomaly-stat-value">{formatSpeed(historicalMedian)} <span className="unit">mph</span></span>
        </div>
      </div>
      {/* Detail */}
      <div className="card anomaly-detail-card anomaly-detail-normal">
        <div className="anomaly-detail-icon">✓</div>
        <h3>No Anomaly Detected</h3>
        <p className="subtle">{explanation || "No unusual speed variation detected."}</p>
      </div>
    </>
  );
}

/* ─── ANOMALY STATE ─── */
function AnomalyState({ severity, anomalyType, explanation, currentSpeed, historicalMedian, deviation, mad, sensor, result }) {
  const sevClass = severity === "HIGH" ? "high" : severity === "MEDIUM" ? "medium" : "low";
  const typeLabel = anomalyType === "speed_drop" ? "Speed Drop" : anomalyType === "speed_spike" ? "Speed Spike" : anomalyType;

  return (
    <>
      <SensorHeading sensor={sensor} result={result} />
      <div className="anomaly-status-cards">
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Detection Status</span>
          <span className={`anomaly-badge anomaly-badge-${sevClass}`}>ANOMALY DETECTED</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Severity</span>
          <span className={`anomaly-badge anomaly-badge-${sevClass}`}>{severity}</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Current Speed</span>
          <span className="anomaly-stat-value">{formatSpeed(currentSpeed)} <span className="unit">mph</span></span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Historical Median</span>
          <span className="anomaly-stat-value">{formatSpeed(historicalMedian)} <span className="unit">mph</span></span>
        </div>
      </div>

      {/* Alert card */}
      <div className={`card anomaly-detail-card anomaly-detail-${sevClass}`}>
        <div className="anomaly-detail-icon">⚠</div>
        <h3>Anomaly Detected — {typeLabel}</h3>
        <p className="subtle">{explanation}</p>
      </div>

      {/* Analysis breakdown */}
      <div className="card">
        <h3>Anomaly Analysis</h3>
        <table className="anomaly-analysis-table">
          <tbody>
            <tr><th>Current Predicted Speed</th><td>{formatSpeed(currentSpeed)} mph</td></tr>
            <tr><th>Historical Median</th><td>{formatSpeed(historicalMedian)} mph</td></tr>
            <tr><th>Median Absolute Deviation</th><td>{formatSpeed(mad)} mph</td></tr>
            <tr><th>Speed Deviation</th><td>{formatSpeed(deviation)} mph</td></tr>
            <tr><th>Anomaly Severity</th><td><span className={`anomaly-badge anomaly-badge-${sevClass}`}>{severity}</span></td></tr>
            <tr><th>Anomaly Type</th><td>{typeLabel}</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ─── INSUFFICIENT DATA STATE ─── */
function InsufficientState({ result, sensor }) {
  return (
    <>
      <SensorHeading sensor={sensor} result={result} />
      <div className="anomaly-status-cards">
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Detection Status</span>
          <span className="anomaly-badge anomaly-badge-insufficient">INSUFFICIENT DATA</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Severity</span>
          <span className="anomaly-stat-value">—</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Current Speed</span>
          <span className="anomaly-stat-value">—</span>
        </div>
        <div className="card anomaly-stat-card">
          <span className="anomaly-stat-label">Historical Median</span>
          <span className="anomaly-stat-value">—</span>
        </div>
      </div>
      <div className="card anomaly-detail-card anomaly-detail-insufficient">
        <div className="anomaly-detail-icon">ⓘ</div>
        <h3>Insufficient Historical Data</h3>
        <p className="subtle">
          There are not enough historical speed observations for this sensor and time
          to evaluate anomalies. This does not mean traffic is normal — it means the
          system cannot make a determination.
        </p>
      </div>
    </>
  );
}

function SensorHeading({ sensor, result }) {
  const utcFormat = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
  const ts = result?.target_timestamp || result?.requested_timestamp;
  return (
    <div className="result-heading">
      <h2>
        {sensor
          ? `${sensor.name || "Unnamed"} · Fwy ${sensor.freeway} ${sensor.direction}`
          : `Sensor ${result?.sensor_id ?? ""}`}
      </h2>
      {ts && <p className="subtle">{utcFormat.format(new Date(ts))} UTC</p>}
    </div>
  );
}
