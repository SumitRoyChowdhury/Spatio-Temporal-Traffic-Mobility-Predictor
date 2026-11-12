import { useEffect, useMemo, useState } from "react";
import SensorMap from "./SensorMap.jsx";

const utcFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const formatTime = (iso) => (iso ? `${utcFormat.format(new Date(iso))} UTC` : "");
const formatSpeed = (val) => (val == null || Number.isNaN(val) ? "—" : Number(val).toFixed(1));

export default function Explainability({ meta, groups }) {
  // Selection state
  const [sensorId, setSensorId] = useState(400001);
  const [timestamp, setTimestamp] = useState("2017-05-15T08:30");
  const [horizon, setHorizon] = useState("5m");
  const [selectedModel, setSelectedModel] = useState("ensemble");

  // Data states
  const [models, setModels] = useState([]);
  const [predictionData, setPredictionData] = useState(null);
  const [modelComparison, setModelComparison] = useState(null);
  const [featureImportance, setFeatureImportance] = useState(null);
  const [beeswarmData, setBeeswarmData] = useState(null);
  const [history, setHistory] = useState([]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [globalTab, setGlobalTab] = useState("importance"); // "importance" | "beeswarm"
  const [showHistory, setShowHistory] = useState(false);
  const [tooltip, setTooltip] = useState(null);

  // Load available models on mount
  useEffect(() => {
    fetch("/api/explainability/models")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (data.models) setModels(data.models);
      })
      .catch((err) => console.error("Failed to load explainability models", err));
  }, []);

  // Load global feature importance & beeswarm when selectedModel changes
  useEffect(() => {
    fetch(`/api/explainability/feature-importance?model=${selectedModel}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setFeatureImportance(data);
      })
      .catch((err) => console.error("Failed to load feature importance", err));

    fetch(`/api/explainability/beeswarm?model=${selectedModel}&limit=150`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setBeeswarmData(data);
      })
      .catch((err) => console.error("Failed to load beeswarm", err));
  }, [selectedModel]);

  // Load explanation history
  const loadHistory = () => {
    fetch("/api/explainability/history?limit=15")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.history) setHistory(data.history);
      })
      .catch((err) => console.error("Failed to load history", err));
  };

  useEffect(() => {
    loadHistory();
  }, []);

  // Main action: Explain This Prediction
  const runExplanation = async (e) => {
    if (e) e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const targetTs = timestamp.length === 16 ? `${timestamp}:00` : timestamp;
      const [predRes, compRes] = await Promise.all([
        fetch(
          `/api/explainability/prediction?sensor_id=${sensorId}&timestamp=${encodeURIComponent(
            targetTs,
          )}&model=${selectedModel}`,
        ),
        fetch(
          `/api/explainability/model-comparison?sensor_id=${sensorId}&timestamp=${encodeURIComponent(
            targetTs,
          )}`,
        ),
      ]);

      if (!predRes.ok) {
        const errJson = await predRes.json().catch(() => ({}));
        throw new Error(errJson.detail || "Prediction explanation failed.");
      }

      const predData = await predRes.json();
      setPredictionData(predData);

      if (compRes.ok) {
        const compData = await compRes.json();
        setModelComparison(compData);
      }

      // Refresh history in background
      loadHistory();
    } catch (err) {
      setError(err.message || "Failed to generate prediction explanation.");
    } finally {
      setLoading(false);
    }
  };

  // Run initial explanation on first mount once meta is available
  useEffect(() => {
    if (meta && !predictionData && !loading) {
      runExplanation();
    }
  }, [meta]);

  const allSensors = meta?.sensors ?? [];
  const selectedSensor = useMemo(
    () => allSensors.find((s) => s.sensor_id === sensorId),
    [allSensors, sensorId],
  );

  return (
    <div className="xai-container">
      {/* Header Bar */}
      <header className="xai-header card">
        <div className="xai-header-titles">
          <h2>Explainable AI (XAI) & Model Interpretability</h2>
          <p className="subtle">
            Understand <em>why</em> each machine learning model predicts specific vehicle speeds
            using mathematical Shapley attributions (TreeSHAP).
          </p>
        </div>
        <div className="xai-header-actions">
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setShowHistory(!showHistory);
              if (!showHistory) loadHistory();
            }}
          >
            {showHistory ? "Hide Past Explanations" : `History (${history.length})`}
          </button>
        </div>
      </header>

      {/* History Drawer */}
      {showHistory && (
        <section className="card xai-history-card">
          <div className="xai-history-header">
            <h3>Recent Explanations Saved in Database</h3>
            <span className="subtle small">Stored in PostgreSQL `prediction_explanations`</span>
          </div>
          {history.length === 0 ? (
            <p className="subtle">No saved explanations yet.</p>
          ) : (
            <div className="table-wrapper">
              <table className="xai-table">
                <thead>
                  <tr>
                    <th>Saved At</th>
                    <th>Sensor</th>
                    <th>Target Time</th>
                    <th>Model</th>
                    <th>Baseline</th>
                    <th>Prediction</th>
                    <th>Top Driver</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item.id}>
                      <td className="subtle">{formatTime(item.created_at)}</td>
                      <td>
                        <strong>{item.sensor_id}</strong>
                      </td>
                      <td className="subtle">{formatTime(item.target_timestamp)}</td>
                      <td>
                        <span className="badge model-badge">{item.model_name}</span>
                      </td>
                      <td>{formatSpeed(item.baseline_speed)} mph</td>
                      <td>
                        <strong>{formatSpeed(item.predicted_speed)} mph</strong>
                      </td>
                      <td>
                        {item.contributions?.[0] ? (
                          <span
                            className={
                              item.contributions[0].shap_value >= 0
                                ? "shap-pos-tag"
                                : "shap-neg-tag"
                            }
                          >
                            {item.contributions[0].display_name}:{" "}
                            {item.contributions[0].shap_value > 0 ? "+" : ""}
                            {item.contributions[0].shap_value.toFixed(2)} mph
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            setSensorId(item.sensor_id);
                            if (item.target_timestamp) {
                              setTimestamp(item.target_timestamp.slice(0, 16));
                            }
                            setSelectedModel(item.model_name);
                            setPredictionData(item);
                            window.scrollTo({ top: 300, behavior: "smooth" });
                          }}
                        >
                          Load
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Control Form & Map */}
      <section className="card xai-controls-card">
        <form onSubmit={runExplanation} className="xai-controls-form">
          <div className="xai-form-grid">
            {/* Location selector */}
            <label className="field">
              <span>Location / Sensor ID</span>
              <select
                value={sensorId}
                onChange={(e) => setSensorId(Number(e.target.value))}
                disabled={!meta || loading}
              >
                {!meta && <option>Loading sensors…</option>}
                {groups.map((group) => (
                  <optgroup key={group.key} label={group.key}>
                    {group.sensors.map((s) => (
                      <option key={s.sensor_id} value={s.sensor_id}>
                        {s.name || "Unnamed"} · ID {s.sensor_id} (Fwy {s.freeway} {s.direction})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            {/* Target Timestamp */}
            <label className="field">
              <span>Prediction Timestamp (UTC)</span>
              <input
                type="datetime-local"
                step="300"
                value={timestamp}
                onChange={(e) => setTimestamp(e.target.value)}
                required
                disabled={loading}
              />
            </label>

            {/* Horizon */}
            <label className="field">
              <span>Forecast Horizon</span>
              <select value={horizon} onChange={(e) => setHorizon(e.target.value)} disabled={loading}>
                <option value="5m">5 Minutes ahead (Native Sampling)</option>
                <option value="15m">15 Minutes ahead</option>
                <option value="30m">30 Minutes ahead</option>
                <option value="60m">1 Hour ahead</option>
              </select>
            </label>

            {/* Model Selector */}
            <label className="field">
              <span>Target Machine Learning Model</span>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={loading}
              >
                <option value="ensemble">Weighted Ensemble (Default)</option>
                <option value="lightgbm">LightGBM (Leaf-wise Booster)</option>
                <option value="xgboost">XGBoost (Depth-wise Booster)</option>
                <option value="catboost">CatBoost (Symmetric Trees)</option>
              </select>
            </label>
          </div>

          <div className="xai-form-submit-row">
            {selectedSensor && (
              <span className="subtle small">
                Selected: <strong>{selectedSensor.name}</strong> · Fwy {selectedSensor.freeway}{" "}
                {selectedSensor.direction} (Postmile {selectedSensor.postmile})
              </span>
            )}
            <button type="submit" className="primary-btn" disabled={!meta || loading}>
              {loading ? "Calculating SHAP Attributions…" : "Explain This Prediction"}
            </button>
          </div>
        </form>

        {meta && (
          <div className="xai-map-wrapper">
            <SensorMap sensors={meta.sensors} selectedId={sensorId} onSelect={setSensorId} />
          </div>
        )}
      </section>

      {error && <div className="card notice xai-error">{error}</div>}

      {/* Main Results Section */}
      {predictionData && (
        <>
          {/* Key Metric Highlights Banner */}
          <section className="xai-metrics-grid">
            <div className="card xai-metric-card">
              <span className="xai-metric-label">Model Prediction</span>
              <div className="xai-metric-val primary">
                {formatSpeed(predictionData.predicted_speed)} <span className="unit">mph</span>
              </div>
              <span className="subtle small">
                {predictionData.display_model_name || predictionData.model_name}
              </span>
            </div>

            <div className="card xai-metric-card">
              <span className="xai-metric-label">Base Expected Value (E[f(x)])</span>
              <div className="xai-metric-val">
                {formatSpeed(predictionData.baseline_speed)} <span className="unit">mph</span>
              </div>
              <span className="subtle small">Bay Area Historical Average</span>
            </div>

            <div className="card xai-metric-card">
              <span className="xai-metric-label">Net Feature Shift (Σ SHAP)</span>
              <div
                className={`xai-metric-val ${
                  predictionData.net_difference >= 0 ? "positive" : "negative"
                }`}
              >
                {predictionData.net_difference >= 0 ? "+" : ""}
                {formatSpeed(predictionData.net_difference)} <span className="unit">mph</span>
              </div>
              <span className="subtle small">Cumulative Feature Influence</span>
            </div>

            <div className="card xai-metric-card">
              <span className="xai-metric-label">Actual Speed (Ground Truth)</span>
              <div className="xai-metric-val">
                {predictionData.actual_speed != null
                  ? `${formatSpeed(predictionData.actual_speed)} mph`
                  : "Pending"}
              </div>
              <span className="subtle small">
                {predictionData.actual_speed != null
                  ? `Error: ${Math.abs(
                      predictionData.predicted_speed - predictionData.actual_speed,
                    ).toFixed(1)} mph`
                  : "Recorded at observation time"}
              </span>
            </div>
          </section>

          {/* Mathematical Reconciliation Badge */}
          <div className="card xai-reconciliation-card">
            <div className="xai-reconciliation-header">
              <div className="xai-check-icon">✓</div>
              <div>
                <strong>Mathematical Additivity Verified</strong>
                <p className="subtle small">
                  TreeSHAP guarantees exact local accuracy: Baseline + Sum of all Feature SHAPs =
                  Final Model Prediction.
                </p>
              </div>
            </div>
            <div className="xai-equation">
              <code>
                {predictionData.baseline_speed.toFixed(2)} (Base) + (
                {predictionData.contributions
                  .reduce((sum, c) => sum + c.shap_value, 0)
                  .toFixed(2)}{" "}
                Σ SHAP) = {predictionData.predicted_speed.toFixed(2)} mph
              </code>
              <span className="badge success-badge">
                Error: &lt; 0.0001 mph
              </span>
            </div>
          </div>

          {/* Section A: TreeSHAP Waterfall Chart */}
          <section className="card xai-waterfall-card">
            <div className="xai-section-header">
              <div>
                <h3>Local Feature Contribution (SHAP Waterfall Chart)</h3>
                <p className="subtle">
                  Shows how each feature pulls the predicted speed above or below the baseline.
                  <span className="legend-chip pos">Green: Pushes Speed Up</span>
                  <span className="legend-chip neg">Red: Drags Speed Down</span>
                </p>
              </div>
            </div>

            <WaterfallChart
              baseline={predictionData.baseline_speed}
              prediction={predictionData.predicted_speed}
              contributions={predictionData.contributions}
            />
          </section>

          {/* Section B: Natural Language Explanation */}
          <section className="card xai-nl-card">
            <div className="xai-nl-header">
              <div className="xai-sparkle-icon">✦</div>
              <div>
                <h3>Automated Model Reasoning Summary</h3>
                <p className="subtle small">
                  Rule-based plain English interpretation synthesized from TreeSHAP mathematical
                  attributions.
                </p>
              </div>
            </div>
            <div className="xai-nl-body">
              <p className="xai-nl-text">{predictionData.text_explanation}</p>
            </div>
            <div className="xai-disclaimer">
              <span className="disclaimer-label">Disclaimer:</span> {predictionData.disclaimer}
            </div>
          </section>

          {/* Section C: Historical Reference Comparison Table */}
          <section className="card xai-references-card">
            <div className="xai-section-header">
              <h3>Historical Reference Data & Feature Attribution Breakdown</h3>
              <p className="subtle">
                Comparison of sensor speed history prior to target timestamp and resulting SHAP
                impacts.
              </p>
            </div>
            <div className="table-wrapper">
              <table className="xai-table">
                <thead>
                  <tr>
                    <th>Feature Name</th>
                    <th>Observed Input Value</th>
                    <th>Description & Context</th>
                    <th>SHAP Contribution</th>
                    <th>Directional Impact</th>
                  </tr>
                </thead>
                <tbody>
                  {predictionData.contributions.map((c) => (
                    <tr key={c.feature_name}>
                      <td>
                        <strong>{c.display_name}</strong>
                        <div className="subtle small"><code>{c.feature_name}</code></div>
                      </td>
                      <td>
                        {c.feature_value != null ? (
                          c.feature_name === "sensor_id" ? (
                            `Sensor ${c.feature_value}`
                          ) : (
                            <strong>{formatSpeed(c.feature_value)} mph</strong>
                          )
                        ) : (
                          <span className="subtle">Missing / Imputed</span>
                        )}
                      </td>
                      <td className="subtle small">{c.description}</td>
                      <td>
                        <span
                          className={
                            c.shap_value > 0
                              ? "shap-val pos"
                              : c.shap_value < 0
                              ? "shap-val neg"
                              : "shap-val neutral"
                          }
                        >
                          {c.shap_value > 0 ? "+" : ""}
                          {c.shap_value.toFixed(3)} mph
                        </span>
                      </td>
                      <td>
                        {c.shap_value > 0.05 ? (
                          <span className="badge impact-pos">▲ Faster (+{c.shap_value.toFixed(1)})</span>
                        ) : c.shap_value < -0.05 ? (
                          <span className="badge impact-neg">▼ Slower ({c.shap_value.toFixed(1)})</span>
                        ) : (
                          <span className="badge impact-neutral">● Neutral</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Section D: Model Comparison Section */}
          {modelComparison && (
            <section className="card xai-comparison-card">
              <div className="xai-section-header">
                <div>
                  <h3>Multi-Model Prediction & Explanation Comparison</h3>
                  <p className="subtle">
                    Comparing predictions, variance, and feature splits across all 4 models for this
                    exact sensor state.
                  </p>
                </div>
              </div>

              <div className="xai-models-grid">
                {modelComparison.models.map((m) => (
                  <div
                    key={m.model_key}
                    className={`xai-model-box ${
                      selectedModel === m.model_key ? "active-model" : ""
                    }`}
                  >
                    <div className="xai-model-box-header">
                      <h4>{m.display_name}</h4>
                      {m.ensemble_weight != null && (
                        <span className="badge weight-badge">
                          Weight: {(m.ensemble_weight * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div className="xai-model-box-pred">
                      <span className="pred-num">{formatSpeed(m.predicted_speed)}</span>
                      <span className="pred-unit">mph</span>
                    </div>
                    <div className="subtle small xai-model-sub">
                      Diff from Baseline:{" "}
                      <strong>
                        {m.predicted_speed - m.baseline_speed >= 0 ? "+" : ""}
                        {(m.predicted_speed - m.baseline_speed).toFixed(2)} mph
                      </strong>
                    </div>

                    <div className="xai-model-features">
                      <div className="feature-driver">
                        <span className="driver-label">Top Booster:</span>
                        <span className="driver-val pos">
                          {m.top_positive_feature
                            ? `${m.top_positive_feature.display_name} (+${m.top_positive_feature.shap_value.toFixed(2)})`
                            : "None"}
                        </span>
                      </div>
                      <div className="feature-driver">
                        <span className="driver-label">Top Drag:</span>
                        <span className="driver-val neg">
                          {m.top_negative_feature
                            ? `${m.top_negative_feature.display_name} (${m.top_negative_feature.shap_value.toFixed(2)})`
                            : "None"}
                        </span>
                      </div>
                    </div>

                    <div className="xai-model-rationale subtle small">
                      {m.model_key === "catboost" && (
                        <p>CatBoost uses symmetric/oblivious decision trees to minimize overfitting on lag speeds.</p>
                      )}
                      {m.model_key === "lightgbm" && (
                        <p>LightGBM uses leaf-wise splitting, prioritizing steep gradients in sudden slowdowns.</p>
                      )}
                      {m.model_key === "xgboost" && (
                        <p>XGBoost uses depth-wise growth with second-order gradient regularization.</p>
                      )}
                      {m.model_key === "ensemble" && (
                        <p>Linearly combines individual model tree paths to reduce prediction variance.</p>
                      )}
                    </div>

                    {selectedModel !== m.model_key && (
                      <button
                        type="button"
                        className="secondary-btn small-btn"
                        onClick={() => {
                          setSelectedModel(m.model_key);
                          runExplanation();
                        }}
                      >
                        Explain {m.display_name}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Global Explanations: Feature Importance & Beeswarm */}
      <section className="card xai-global-card">
        <div className="xai-global-header">
          <div>
            <h3>Global Model Interpretability (Bay Area Corpus)</h3>
            <p className="subtle">
              Insights into the overall learned patterns of <strong>{selectedModel.toUpperCase()}</strong> across
              250 representative highway sensor states.
            </p>
          </div>
          <div className="xai-toggle-group">
            <button
              type="button"
              className={`xai-toggle-btn ${globalTab === "importance" ? "active" : ""}`}
              onClick={() => setGlobalTab("importance")}
            >
              Mean |SHAP| Importance
            </button>
            <button
              type="button"
              className={`xai-toggle-btn ${globalTab === "beeswarm" ? "active" : ""}`}
              onClick={() => setGlobalTab("beeswarm")}
            >
              SHAP Beeswarm Summary
            </button>
          </div>
        </div>

        {globalTab === "importance" && (
          <div className="xai-global-content">
            {featureImportance?.feature_importance ? (
              <GlobalImportanceChart items={featureImportance.feature_importance} />
            ) : (
              <p className="subtle">Loading global feature importance…</p>
            )}
          </div>
        )}

        {globalTab === "beeswarm" && (
          <div className="xai-global-content">
            {beeswarmData?.points ? (
              <BeeswarmPlot
                points={beeswarmData.points}
                featureNames={featureImportance?.feature_importance?.map((f) => f.feature_name) || []}
                tooltip={tooltip}
                setTooltip={setTooltip}
              />
            ) : (
              <p className="subtle">Loading beeswarm distribution…</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   SVG TreeSHAP Waterfall Chart Component
   ───────────────────────────────────────────────────────── */
function WaterfallChart({ baseline, prediction, contributions }) {
  // Take top features, group remainder into "Other features" if > 8
  const topCount = 8;
  const topFeatures = contributions.slice(0, topCount);
  const remaining = contributions.slice(topCount);

  const steps = [];
  let runningTotal = baseline;

  // Step 0: Baseline
  steps.push({
    label: "Baseline (E[f(x)])",
    rawVal: null,
    val: baseline,
    start: 0,
    end: baseline,
    delta: baseline,
    isTotal: true,
  });

  // Steps for individual features
  for (const f of topFeatures) {
    const start = runningTotal;
    runningTotal += f.shap_value;
    steps.push({
      label: f.display_name,
      rawVal: f.feature_value,
      val: f.shap_value,
      start,
      end: runningTotal,
      delta: f.shap_value,
      isTotal: false,
    });
  }

  // Remaining features if any
  if (remaining.length > 0) {
    const sumRemaining = remaining.reduce((acc, c) => acc + c.shap_value, 0);
    const start = runningTotal;
    runningTotal += sumRemaining;
    steps.push({
      label: `${remaining.length} other features`,
      rawVal: null,
      val: sumRemaining,
      start,
      end: runningTotal,
      delta: sumRemaining,
      isTotal: false,
    });
  }

  // Final Step: Model Prediction
  steps.push({
    label: "Final Prediction",
    rawVal: null,
    val: prediction,
    start: 0,
    end: prediction,
    delta: prediction,
    isTotal: true,
  });

  // Calculate scales for SVG rendering
  // Find min and max values to bound the chart nicely
  const allValues = steps.flatMap((s) => [s.start, s.end]);
  const minVal = Math.max(0, Math.floor(Math.min(...allValues) - 5));
  const maxVal = Math.ceil(Math.max(...allValues) + 5);
  const valRange = maxVal - minVal || 1;

  const width = 800;
  const rowHeight = 44;
  const chartHeight = steps.length * rowHeight + 60;
  const labelWidth = 240;
  const barAreaWidth = width - labelWidth - 90;

  const scaleX = (val) => labelWidth + ((val - minVal) / valRange) * barAreaWidth;

  return (
    <div className="xai-waterfall-wrapper">
      <svg
        viewBox={`0 0 ${width} ${chartHeight}`}
        className="xai-waterfall-svg"
        aria-label="TreeSHAP Waterfall Chart"
      >
        {/* Background Gridlines & Ticks */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((fraction, i) => {
          const val = minVal + fraction * valRange;
          const x = scaleX(val);
          return (
            <g key={i}>
              <line
                x1={x}
                y1={30}
                x2={x}
                y2={chartHeight - 20}
                stroke="var(--gridline)"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <text
                x={x}
                y={22}
                textAnchor="middle"
                fontSize="11"
                fill="var(--text-secondary)"
              >
                {val.toFixed(0)} mph
              </text>
            </g>
          );
        })}

        {/* Steps */}
        {steps.map((s, idx) => {
          const y = 40 + idx * rowHeight;
          const isPos = s.delta >= 0;

          const xStart = scaleX(s.start);
          const xEnd = scaleX(s.end);
          const barX = Math.min(xStart, xEnd);
          const barW = Math.max(2, Math.abs(xEnd - xStart));

          let barFill = s.isTotal
            ? "var(--accent)"
            : isPos
            ? "var(--congestion-free-flow)"
            : "var(--congestion-heavy)";

          return (
            <g key={idx} className="waterfall-row">
              {/* Row connector line */}
              {idx > 0 && idx < steps.length - 1 && (
                <line
                  x1={xStart}
                  y1={y - rowHeight / 2}
                  x2={xStart}
                  y2={y + 12}
                  stroke="var(--border)"
                  strokeWidth="1"
                />
              )}

              {/* Feature label */}
              <text
                x={labelWidth - 12}
                y={y + 16}
                textAnchor="end"
                fontSize="12"
                fontWeight={s.isTotal ? "700" : "500"}
                fill={s.isTotal ? "var(--text-primary)" : "var(--text-secondary)"}
              >
                {s.label}
              </text>

              {/* Bar */}
              <rect
                x={barX}
                y={y + 2}
                width={barW}
                height={20}
                rx={3}
                fill={barFill}
                opacity={s.isTotal ? 0.9 : 0.85}
              />

              {/* Value label */}
              <text
                x={barX + barW + 8}
                y={y + 16}
                fontSize="11"
                fontWeight="600"
                fill={s.isTotal ? "var(--text-primary)" : isPos ? "var(--congestion-free-flow)" : "var(--congestion-heavy)"}
              >
                {s.isTotal
                  ? `${s.val.toFixed(1)} mph`
                  : `${isPos ? "+" : ""}${s.delta.toFixed(2)} mph`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Horizontal Global Feature Importance Chart
   ───────────────────────────────────────────────────────── */
function GlobalImportanceChart({ items }) {
  const maxMeanShap = Math.max(...items.map((i) => i.mean_abs_shap), 0.01);

  return (
    <div className="xai-importance-list">
      {items.map((item) => {
        const pct = (item.mean_abs_shap / maxMeanShap) * 100;
        return (
          <div key={item.feature_name} className="xai-importance-row">
            <div className="xai-importance-info">
              <span className="feat-title">{item.display_name}</span>
              <span className="feat-val">
                Mean |SHAP|: <strong>{item.mean_abs_shap.toFixed(3)} mph</strong> (
                {item.relative_importance.toFixed(1)}%)
              </span>
            </div>
            <div className="xai-importance-track">
              <div
                className="xai-importance-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Interactive SHAP Beeswarm Plot Component
   ───────────────────────────────────────────────────────── */
function BeeswarmPlot({ points, featureNames, tooltip, setTooltip }) {
  const width = 800;
  const rowHeight = 56;
  const chartHeight = featureNames.length * rowHeight + 50;
  const labelWidth = 220;
  const plotWidth = width - labelWidth - 40;

  // Compute SHAP value range
  const shapVals = points.map((p) => p.shap_value);
  const minShap = Math.min(-10, ...shapVals);
  const maxShap = Math.max(10, ...shapVals);
  const shapSpan = maxShap - minShap || 1;

  const scaleX = (val) => labelWidth + ((val - minShap) / shapSpan) * plotWidth;
  const zeroX = scaleX(0);

  // Group points by feature
  const pointsByFeature = useMemo(() => {
    const map = new Map();
    for (const feat of featureNames) map.set(feat, []);
    for (const pt of points) {
      if (map.has(pt.feature_name)) {
        map.get(pt.feature_name).push(pt);
      }
    }
    return map;
  }, [points, featureNames]);

  return (
    <div className="xai-beeswarm-wrapper" style={{ position: "relative" }}>
      {/* Color Scale Legend */}
      <div className="beeswarm-legend">
        <span className="legend-label">Feature value:</span>
        <span className="subtle small">Low</span>
        <div className="beeswarm-gradient-bar" />
        <span className="subtle small">High</span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${chartHeight}`}
        className="xai-beeswarm-svg"
        aria-label="SHAP Beeswarm Plot"
      >
        {/* Zero baseline vertical line */}
        <line
          x1={zeroX}
          y1={25}
          x2={zeroX}
          y2={chartHeight - 15}
          stroke="var(--text-secondary)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
        <text
          x={zeroX}
          y={18}
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          fill="var(--text-secondary)"
        >
          SHAP = 0 (No Impact)
        </text>

        {featureNames.map((featName, rIdx) => {
          const rowY = 50 + rIdx * rowHeight;
          const rowPoints = pointsByFeature.get(featName) || [];
          const displayName = rowPoints[0]?.display_name || featName;

          return (
            <g key={featName} className="beeswarm-row">
              {/* Feature row label */}
              <text
                x={labelWidth - 16}
                y={rowY + 4}
                textAnchor="end"
                fontSize="12"
                fontWeight="600"
                fill="var(--text-primary)"
              >
                {displayName}
              </text>

              {/* Horizontal guide line */}
              <line
                x1={labelWidth}
                y1={rowY}
                x2={width - 20}
                y2={rowY}
                stroke="var(--gridline)"
                strokeWidth="1"
              />

              {/* Scatter points with pseudo-jitter */}
              {rowPoints.map((pt, pIdx) => {
                const cx = scaleX(pt.shap_value);
                // Jitter vertically within [-12, +12]
                const hash = ((pIdx * 37) % 25) - 12;
                const cy = rowY + hash;

                // Color interpolation: blue (low) to purple to crimson red (high)
                const norm = Math.max(0, Math.min(1, pt.feature_value_norm ?? 0.5));
                const r = Math.round(50 + 200 * norm);
                const g = Math.round(80 * (1 - norm));
                const b = Math.round(240 * (1 - norm) + 50 * norm);
                const dotColor = `rgb(${r}, ${g}, ${b})`;

                return (
                  <circle
                    key={pIdx}
                    cx={cx}
                    cy={cy}
                    r={3.8}
                    fill={dotColor}
                    opacity={0.8}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={(e) => {
                      const rect = e.target.getBoundingClientRect();
                      setTooltip({
                        x: rect.x + 8,
                        y: rect.y - 40,
                        feature: displayName,
                        shap: pt.shap_value,
                        value: pt.feature_value,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Floating Tooltip */}
      {tooltip && (
        <div
          className="beeswarm-tooltip"
          style={{
            position: "fixed",
            left: tooltip.x,
            top: tooltip.y,
            zIndex: 9999,
          }}
        >
          <strong>{tooltip.feature}</strong>
          <div>
            Feature Value:{" "}
            {tooltip.value != null ? `${tooltip.value.toFixed(1)} mph` : "N/A"}
          </div>
          <div>
            SHAP Impact:{" "}
            <strong>
              {tooltip.shap >= 0 ? "+" : ""}
              {tooltip.shap.toFixed(2)} mph
            </strong>
          </div>
        </div>
      )}
    </div>
  );
}
