import { useEffect, useMemo, useState } from "react";
import SensorMap from "./SensorMap.jsx";
import Evaluation from "./Evaluation.jsx";

const MODELS = [
  { key: "xgboost", label: "XGBoost" },
  { key: "catboost", label: "CatBoost" },
  { key: "lightgbm", label: "LightGBM" },
];
const REFERENCES = [
  { key: "previous_day_speed", label: "Previous day" },
  { key: "previous_week_speed", label: "Previous week" },
  { key: "previous_year_speed", label: "Previous year" },
];
const DEFAULT_SENSOR = 400001;
const DEFAULT_TIMESTAMP = "2017-06-01T08:30";

const utcFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const formatTime = (iso) => (iso ? `${utcFormat.format(new Date(iso))} UTC` : "");
const formatSpeed = (value) => (value == null ? "—" : value.toFixed(1));

function sensorLabel(sensor) {
  return `${sensor.name || "Unnamed"} · ${sensor.sensor_id}`;
}

function groupSensors(sensors) {
  const groups = new Map();
  for (const sensor of sensors) {
    const key = `Fwy ${sensor.freeway} ${sensor.direction}`;
    if (!groups.has(key)) groups.set(key, { key, freeway: Number(sensor.freeway), sensors: [] });
    groups.get(key).sensors.push(sensor);
  }
  return [...groups.values()]
    .sort((a, b) => a.freeway - b.freeway || a.key.localeCompare(b.key))
    .map((group) => ({
      ...group,
      sensors: group.sensors.sort((a, b) => (a.postmile ?? 0) - (b.postmile ?? 0)),
    }));
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState("");
  const [sensorId, setSensorId] = useState(DEFAULT_SENSOR);
  const [timestamp, setTimestamp] = useState(DEFAULT_TIMESTAMP);
  const [state, setState] = useState({ status: "idle" });

  useEffect(() => {
    fetch("/api/meta")
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then(setMeta)
      .catch(() =>
        setMetaError("Could not reach the prediction API. Start it with `python -m training.api`."),
      );
  }, []);

  const sensorsById = useMemo(
    () => new Map((meta?.sensors ?? []).map((sensor) => [sensor.sensor_id, sensor])),
    [meta],
  );
  const groups = useMemo(() => groupSensors(meta?.sensors ?? []), [meta]);
  const selected = sensorsById.get(sensorId);

  async function runPrediction(event) {
    event.preventDefault();
    setState({ status: "loading" });
    const query = new URLSearchParams({ sensor_id: String(sensorId), timestamp });
    try {
      const response = await fetch(`/api/predict?${query}`);
      const body = await response.json();
      if (response.ok) setState({ status: "done", result: body });
      else if (body.insufficient_data) setState({ status: "insufficient", result: body });
      else setState({ status: "error", message: body.error ?? "Prediction failed." });
    } catch {
      setState({ status: "error", message: "Could not reach the prediction API." });
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Traffic speed forecast</h1>
        <p className="subtle">
          Predicted from the speed at the same place and time one day, one week and one
          year earlier.
        </p>
      </header>

      {metaError && <p className="banner">{metaError}</p>}

      <main className="layout">
        <form className="card controls" onSubmit={runPrediction}>
          <label className="field">
            <span>Location</span>
            <select
              value={sensorId}
              onChange={(event) => setSensorId(Number(event.target.value))}
              disabled={!meta}
            >
              {!meta && <option>Loading sensors…</option>}
              {groups.map((group) => (
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
              onChange={(event) => setTimestamp(event.target.value)}
              required
            />
          </label>
          {meta?.data_start && (
            <p className="subtle small">
              Recorded data covers {formatTime(meta.data_start)} to {formatTime(meta.data_end)}.
            </p>
          )}

          <button type="submit" disabled={!meta || state.status === "loading"}>
            {state.status === "loading" ? "Predicting…" : "Predict speed"}
          </button>
        </form>

        <section className="results" aria-live="polite">
          <Results state={state} meta={meta} sensor={selected} />
        </section>
      </main>

      <Evaluation />
    </div>
  );
}

function Results({ state, meta, sensor }) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="card empty">
        <p className="subtle">
          {state.status === "loading"
            ? "Running the three models…"
            : "Choose a location and time, then select Predict speed."}
        </p>
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="card notice">{state.message}</div>;
  }

  const { result } = state;
  const heading = (
    <div className="result-heading">
      <h2>{sensor ? `${sensor.name || "Unnamed"} · Fwy ${sensor.freeway} ${sensor.direction}` : `Sensor ${result.sensor_id}`}</h2>
      <p className="subtle">{formatTime(result.target_timestamp)}</p>
    </div>
  );

  if (state.status === "insufficient") {
    return (
      <>
        {heading}
        <div className="card notice">
          <strong>Current data is not sufficient to predict the traffic speed.</strong>
          <p>No previous-day, previous-week or previous-year reading exists for this location and time.</p>
        </div>
        <References result={result} />
      </>
    );
  }

  return (
    <>
      {heading}
      <div className="tiles">
        {MODELS.map((model, index) => (
          <article className="card tile" key={model.key}>
            <p className="tile-label">
              <span className={`swatch series-${index + 1}`} aria-hidden="true" />
              {model.label}
            </p>
            <p className="tile-value">
              {formatSpeed(result.predicted_speed_by_model[model.key])}
              <span className="unit">mph</span>
            </p>
            {meta?.models?.[model.key] && (
              <p className="subtle small">
                Typical error ±{meta.models[model.key].mae.toFixed(1)} mph
              </p>
            )}
          </article>
        ))}
      </div>
      <p className="subtle small summary">
        {result.weighted_predicted_speed != null && (
          <>
            Weighted ensemble: <strong>{formatSpeed(result.weighted_predicted_speed)} mph</strong> ·{" "}
          </>
        )}
        Simple average: <strong>{formatSpeed(result.mean_predicted_speed)} mph</strong>
        {result.actual_speed != null && (
          <>
            {" "}· Recorded speed at this time: <strong>{formatSpeed(result.actual_speed)} mph</strong>
          </>
        )}
      </p>
      <References result={result} />
    </>
  );
}

function References({ result }) {
  return (
    <div className="card">
      <h3>Data used</h3>
      <table className="references">
        <tbody>
          {REFERENCES.map((reference) => {
            const item = result.references[reference.key];
            return (
              <tr key={reference.key}>
                <th scope="row">{reference.label}</th>
                <td className="subtle">{formatTime(item.timestamp)}</td>
                <td className="speed">
                  {item.speed == null ? <span className="subtle">No reading</span> : `${formatSpeed(item.speed)} mph`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
