import { useEffect, useMemo, useRef, useState } from "react";
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

export default function TrafficHeatmap({ meta, groups, onSelectSensor }) {
  // Timeline and filter states
  const [timestamp, setTimestamp] = useState("2017-05-15T08:30");
  const [model, setModel] = useState("ensemble");
  const [dataType, setDataType] = useState("both"); // "both" | "actual" | "predicted"
  const [congestionFilter, setCongestionFilter] = useState("ALL");
  const [freewayFilter, setFreewayFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);

  // Data states
  const [trafficData, setTrafficData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedSensorId, setSelectedSensorId] = useState(400001);
  const [sensorDetail, setSensorDetail] = useState(null);
  const [comparisonData, setComparisonData] = useState(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [timelineInfo, setTimelineInfo] = useState(null);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Load timeline metadata
  useEffect(() => {
    fetch("/api/heatmap/timeline")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setTimelineInfo(data);
      })
      .catch((err) => console.error("Failed to load timeline metadata", err));
  }, []);

  // Fetch traffic heatmap data
  const fetchTraffic = async (ts = timestamp, m = model, dt = dataType, cong = congestionFilter, srch = debouncedSearch, fwy = freewayFilter) => {
    setLoading(true);
    try {
      const targetTs = ts.length === 16 ? `${ts}:00` : ts;
      const params = new URLSearchParams({
        timestamp: targetTs,
        model: m,
        data_type: dt,
        congestion_level: cong,
      });
      if (srch) params.set("search", srch);
      if (fwy && fwy !== "ALL") params.set("freeway", fwy);

      const res = await fetch(`/api/heatmap/traffic?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load traffic heatmap.");
      const data = await res.json();
      setTrafficData(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTraffic(timestamp, model, dataType, congestionFilter, debouncedSearch, freewayFilter);
  }, [timestamp, model, dataType, congestionFilter, debouncedSearch, freewayFilter]);

  // Fetch detailed info and 24h comparison when selected sensor changes
  useEffect(() => {
    if (!selectedSensorId) return;
    const targetTs = timestamp.length === 16 ? `${timestamp}:00` : timestamp;

    fetch(`/api/heatmap/sensor/${selectedSensorId}?timestamp=${encodeURIComponent(targetTs)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setSensorDetail(data);
      })
      .catch(console.error);

    setComparisonLoading(true);
    fetch(`/api/heatmap/comparison/${selectedSensorId}?timestamp=${encodeURIComponent(targetTs)}&hours=12&model=${model}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setComparisonData(data);
      })
      .catch(console.error)
      .finally(() => setComparisonLoading(false));
  }, [selectedSensorId, timestamp, model]);

  // Timeline step navigation (-5m / +5m)
  const stepTime = (minutes) => {
    try {
      const current = new Date(timestamp.length === 16 ? `${timestamp}:00Z` : timestamp);
      const updated = new Date(current.getTime() + minutes * 60 * 1000);
      setTimestamp(updated.toISOString().slice(0, 16));
    } catch (e) {
      console.error(e);
    }
  };

  // Playback timer loop
  const playTimerRef = useRef(null);
  useEffect(() => {
    if (isPlaying) {
      playTimerRef.current = setInterval(() => {
        stepTime(5);
      }, 1800);
    } else {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
    }
    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
    };
  }, [isPlaying, timestamp]);

  const clearAllFilters = () => {
    setTimestamp("2017-05-15T08:30");
    setModel("ensemble");
    setDataType("both");
    setCongestionFilter("ALL");
    setFreewayFilter("ALL");
    setSearch("");
    setIsPlaying(false);
  };

  // Extract unique freeway options
  const freeways = useMemo(() => {
    if (!meta?.sensors) return [];
    const set = new Set(meta.sensors.map((s) => s.freeway).filter(Boolean));
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, [meta]);

  const stats = trafficData?.statistics || {
    total_sensors: 325,
    matched_sensors: 0,
    free_flow_count: 0,
    moderate_count: 0,
    heavy_count: 0,
    no_data_count: 0,
    average_actual_speed: null,
    average_predicted_speed: null,
    average_congestion_ratio: null,
  };

  return (
    <div className="heatmap-container">
      {/* ─── Top Header Section ─── */}
      <header className="heatmap-header card">
        <div className="heatmap-header-titles">
          <div className="heatmap-title-row">
            <h2>Traffic Intelligence Heatmap</h2>
            <span className="live-pill">
              <span className="live-dot" /> {formatTime(trafficData?.target_timestamp || `${timestamp}:00Z`)}
            </span>
          </div>
          <p className="subtle">
            Interactive spatio-temporal traffic mobility monitoring, congestion classification, and multi-model forecast intelligence across California highway corridors.
          </p>
        </div>
        <div className="heatmap-header-badge">
          <span className="source-tag">Source: PeMS-Bay Caltrans Highway Sensor Network</span>
        </div>
      </header>

      {/* ─── Summary KPI Cards ─── */}
      <section className="heatmap-kpi-grid">
        <div className="card kpi-card">
          <span className="kpi-label">Total Sensors</span>
          <div className="kpi-val primary">
            {stats.matched_sensors} <span className="kpi-sub">/ {stats.total_sensors}</span>
          </div>
          <span className="subtle small">Monitored Stations</span>
        </div>

        <div className="card kpi-card">
          <span className="kpi-label">Free Flow</span>
          <div className="kpi-val free-flow-text">
            {stats.free_flow_count}
          </div>
          <span className="subtle small">Ratio ≥ 70% (Speed &gt; 45 mph)</span>
        </div>

        <div className="card kpi-card">
          <span className="kpi-label">Moderate Traffic</span>
          <div className="kpi-val moderate-text">
            {stats.moderate_count}
          </div>
          <span className="subtle small">Ratio 40% – 70% (26–45 mph)</span>
        </div>

        <div className="card kpi-card">
          <span className="kpi-label">Heavy Congestion</span>
          <div className="kpi-val heavy-text">
            {stats.heavy_count}
          </div>
          <span className="subtle small">Ratio &lt; 40% (&lt; 26 mph)</span>
        </div>

        <div className="card kpi-card">
          <span className="kpi-label">Avg Actual Speed</span>
          <div className="kpi-val">
            {formatSpeed(stats.average_actual_speed)} <span className="unit">mph</span>
          </div>
          <span className="subtle small">
            Avg Ratio: {stats.average_congestion_ratio ? `${(stats.average_congestion_ratio * 100).toFixed(0)}%` : "—"}
          </span>
        </div>

        <div className="card kpi-card">
          <span className="kpi-label">Avg Predicted Speed</span>
          <div className="kpi-val">
            {formatSpeed(stats.average_predicted_speed)} <span className="unit">mph</span>
          </div>
          <span className="subtle small">{model.toUpperCase()} Forecast</span>
        </div>
      </section>

      {/* ─── Advanced Filter & Timeline Controls ─── */}
      <section className="card heatmap-filter-card">
        <div className="filter-header-row">
          <h3>Advanced Map Filters & Temporal Navigation</h3>
          <button type="button" className="secondary-btn small-btn" onClick={clearAllFilters}>
            Clear All Filters
          </button>
        </div>

        <div className="heatmap-filter-grid">
          {/* Date & Time Input */}
          <label className="field">
            <span>Observation Date & Time (UTC)</span>
            <input
              type="datetime-local"
              step="300"
              value={timestamp}
              onChange={(e) => setTimestamp(e.target.value)}
              required
            />
          </label>

          {/* Quick Preset Selector */}
          <label className="field">
            <span>Historical Traffic Presets</span>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) setTimestamp(e.target.value.slice(0, 16));
              }}
            >
              <option value="">Choose a traffic scenario…</option>
              {timelineInfo?.presets?.map((p) => (
                <option key={p.label} value={p.timestamp}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {/* Congestion Filter */}
          <label className="field">
            <span>Congestion Classification</span>
            <select value={congestionFilter} onChange={(e) => setCongestionFilter(e.target.value)}>
              <option value="ALL">All Sensors</option>
              <option value="FREE_FLOW">Free Flow (Green)</option>
              <option value="MODERATE">Moderate Traffic (Yellow)</option>
              <option value="HEAVY">Heavy Congestion (Red)</option>
              <option value="NO_DATA">No Data (Gray)</option>
            </select>
          </label>

          {/* Data Type */}
          <label className="field">
            <span>Display Data Type</span>
            <select value={dataType} onChange={(e) => setDataType(e.target.value)}>
              <option value="both">Actual &amp; Predicted</option>
              <option value="actual">Actual Observations Only</option>
              <option value="predicted">Model Predictions Only</option>
            </select>
          </label>

          {/* Model Selector */}
          <label className="field">
            <span>Machine Learning Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="ensemble">Weighted Ensemble (Best MSE)</option>
              <option value="lightgbm">LightGBM</option>
              <option value="xgboost">XGBoost</option>
              <option value="catboost">CatBoost</option>
            </select>
          </label>

          {/* Freeway Filter */}
          <label className="field">
            <span>Highway Corridor</span>
            <select value={freewayFilter} onChange={(e) => setFreewayFilter(e.target.value)}>
              <option value="ALL">All Corridors</option>
              {freeways.map((fwy) => (
                <option key={fwy} value={fwy}>
                  Freeway {fwy}
                </option>
              ))}
            </select>
          </label>

          {/* Location / Sensor Search */}
          <label className="field search-field">
            <span>Search Sensor ID / Name</span>
            <input
              type="text"
              placeholder="e.g. 400001, Main St, 101 N…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>

        {/* Timeline Slider & Playback Toolbar */}
        <div className="timeline-playback-row">
          <div className="playback-btns">
            <button
              type="button"
              className="timeline-btn"
              title="Step back 5 minutes"
              onClick={() => stepTime(-5)}
            >
              ◀ -5m
            </button>
            <button
              type="button"
              className={`timeline-btn play-btn ${isPlaying ? "active-play" : ""}`}
              onClick={() => setIsPlaying(!isPlaying)}
            >
              {isPlaying ? "❚❚ Pause Playback" : "▶ Play Historical Flow"}
            </button>
            <button
              type="button"
              className="timeline-btn"
              title="Step forward 5 minutes"
              onClick={() => stepTime(5)}
            >
              +5m ▶
            </button>
          </div>

          <div className="playback-status">
            {loading ? (
              <span className="subtle small">Fetching traffic matrix…</span>
            ) : (
              <span className="subtle small">
                Showing traffic observations &amp; forecasts for <strong>{formatTime(trafficData?.target_timestamp)}</strong>
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ─── Main Map & Sensor Side Inspector Split View ─── */}
      <section className="heatmap-main-layout">
        {/* Left Side: Interactive Map */}
        <div className="card heatmap-map-container">
          <div className="map-title-bar">
            <h4>Geographical Highway Sensor Network</h4>
            <span className="subtle small">Click any sensor marker to inspect live telemetry</span>
          </div>

          <div className="map-view-box">
            <SensorMap
              sensors={trafficData?.sensors || []}
              selectedId={selectedSensorId}
              onSelect={(id) => {
                setSelectedSensorId(id);
                if (onSelectSensor) onSelectSensor(id);
              }}
              interactive={true}
              clustering={true}
              showLegend={true}
              searchHighlightId={debouncedSearch ? trafficData?.sensors?.map((s) => s.sensor_id) : undefined}
            />
          </div>
        </div>

        {/* Right Side: Selected Sensor Inspector Panel */}
        <div className="card heatmap-inspector-card">
          <div className="inspector-header">
            <h4>Selected Sensor Details</h4>
            {sensorDetail && (
              <span className="badge corridor-badge">
                Fwy {sensorDetail.freeway} {sensorDetail.direction}
              </span>
            )}
          </div>

          {sensorDetail ? (
            <div className="inspector-body">
              <div className="inspector-sensor-title">
                <h3>{sensorDetail.name || `Sensor ${sensorDetail.sensor_id}`}</h3>
                <span className="subtle small">
                  Sensor ID: <strong>{sensorDetail.sensor_id}</strong> · Postmile: {sensorDetail.postmile ?? "—"}
                </span>
                <span className="subtle small">
                  Coordinates: {sensorDetail.latitude?.toFixed(4)}, {sensorDetail.longitude?.toFixed(4)}
                </span>
              </div>

              {/* Congestion Status Card */}
              <div
                className="inspector-status-box"
                style={{
                  borderLeft: `5px solid ${
                    sensorDetail.congestion_category === "FREE FLOW"
                      ? "var(--congestion-free-flow)"
                      : sensorDetail.congestion_category === "MODERATE TRAFFIC"
                      ? "var(--congestion-moderate)"
                      : sensorDetail.congestion_category === "HEAVY CONGESTION"
                      ? "var(--congestion-heavy)"
                      : "var(--muted)"
                  }`,
                }}
              >
                <div className="status-box-header">
                  <span className="status-box-label">Congestion Status</span>
                  <span
                    className={`badge ${
                      sensorDetail.congestion_category === "FREE FLOW"
                        ? "impact-pos"
                        : sensorDetail.congestion_category === "MODERATE TRAFFIC"
                        ? "impact-moderate"
                        : sensorDetail.congestion_category === "HEAVY CONGESTION"
                        ? "impact-neg"
                        : "impact-neutral"
                    }`}
                  >
                    {sensorDetail.congestion_category}
                  </span>
                </div>
                <div className="status-ratio-text">
                  Congestion Ratio:{" "}
                  <strong>
                    {sensorDetail.congestion_ratio != null
                      ? `${(sensorDetail.congestion_ratio * 100).toFixed(0)}%`
                      : "—"}
                  </strong>{" "}
                  <span className="subtle small">
                    (Speed / Reference Free-Flow {sensorDetail.free_flow_speed} mph)
                  </span>
                </div>
              </div>

              {/* Speed Comparison Table */}
              <div className="inspector-speeds-grid">
                <div className="speed-tile">
                  <span className="speed-tile-label">Recorded Speed</span>
                  <span className="speed-tile-num">{formatSpeed(sensorDetail.actual_speed)}</span>
                  <span className="speed-tile-unit">mph</span>
                </div>

                <div className="speed-tile">
                  <span className="speed-tile-label">Predicted Speed</span>
                  <span className="speed-tile-num">{formatSpeed(sensorDetail.predicted_speed)}</span>
                  <span className="speed-tile-unit">mph ({model})</span>
                </div>
              </div>

              {/* Speed Difference & Error */}
              {sensorDetail.actual_speed != null && sensorDetail.predicted_speed != null && (
                <div className="speed-diff-banner">
                  <span>Prediction Difference: </span>
                  <strong>
                    {sensorDetail.predicted_speed - sensorDetail.actual_speed >= 0 ? "+" : ""}
                    {(sensorDetail.predicted_speed - sensorDetail.actual_speed).toFixed(1)} mph
                  </strong>
                  <span className="subtle small">
                    {" "}
                    (Error:{" "}
                    {(
                      (Math.abs(sensorDetail.predicted_speed - sensorDetail.actual_speed) /
                        sensorDetail.actual_speed) *
                      100
                    ).toFixed(1)}
                    %)
                  </span>
                </div>
              )}

              {/* Historical Reference Speeds */}
              <div className="inspector-refs-section">
                <h5>Historical Temporal Speeds</h5>
                <div className="ref-items-list">
                  <div className="ref-item">
                    <span className="ref-name">Previous Day (t - 1d):</span>
                    <span className="ref-val">
                      {formatSpeed(sensorDetail.references?.previous_day_speed?.speed)} mph
                    </span>
                  </div>
                  <div className="ref-item">
                    <span className="ref-name">Previous Week (t - 7d):</span>
                    <span className="ref-val">
                      {formatSpeed(sensorDetail.references?.previous_week_speed?.speed)} mph
                    </span>
                  </div>
                  <div className="ref-item">
                    <span className="ref-name">Previous Year (t - 1y):</span>
                    <span className="ref-val">
                      {formatSpeed(sensorDetail.references?.previous_year_speed?.speed)} mph
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="inspector-actions">
                <a
                  href={`#explainability?sensor=${sensorDetail.sensor_id}&timestamp=${encodeURIComponent(
                    timestamp,
                  )}`}
                  className="secondary-btn small-btn"
                  onClick={() => {
                    window.location.hash = "#explainability";
                  }}
                >
                  ✦ Explain with XAI
                </a>
                <a
                  href={`#forecast`}
                  className="secondary-btn small-btn"
                  onClick={() => {
                    window.location.hash = "#forecast";
                  }}
                >
                  View Forecast
                </a>
              </div>
            </div>
          ) : (
            <p className="subtle inspector-placeholder">Select a sensor marker on the map to inspect telemetry.</p>
          )}
        </div>
      </section>

      {/* ─── Bottom Section: 24-Hour Comparison Line Chart ─── */}
      <section className="card heatmap-chart-card">
        <div className="chart-header-row">
          <div>
            <h3>24-Hour Actual vs. Predicted Traffic Speed Timeline</h3>
            <p className="subtle">
              Sensor {selectedSensorId} speed profile spanning ±12 hours around {formatTime(`${timestamp}:00Z`)}.
            </p>
          </div>
          {comparisonData?.metrics && (
            <div className="chart-metrics-pills">
              <span className="badge metric-pill">
                MAE: <strong>{comparisonData.metrics.mae ?? "—"} mph</strong>
              </span>
              <span className="badge metric-pill">
                MAPE: <strong>{comparisonData.metrics.mape ?? "—"}%</strong>
              </span>
              <span className="badge metric-pill">
                Max Error: <strong>{comparisonData.metrics.max_error ?? "—"} mph</strong>
              </span>
            </div>
          )}
        </div>

        {comparisonLoading ? (
          <p className="subtle chart-loading">Loading timeline comparison…</p>
        ) : comparisonData?.points?.length ? (
          <TimelineComparisonChart points={comparisonData.points} />
        ) : (
          <p className="subtle chart-empty">No comparison points available for this sensor.</p>
        )}
      </section>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   SVG 24-Hour Timeline Comparison Chart Component
   ───────────────────────────────────────────────────────── */
function TimelineComparisonChart({ points }) {
  const width = 960;
  const height = 240;
  const padding = { top: 20, right: 30, bottom: 35, left: 50 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Speed domain: 0 to 80 mph
  const minSpeed = 0;
  const maxSpeed = 80;

  const scaleY = (speed) => {
    if (speed == null) return null;
    const clamped = Math.max(minSpeed, Math.min(maxSpeed, speed));
    return padding.top + chartH - ((clamped - minSpeed) / (maxSpeed - minSpeed)) * chartH;
  };

  const scaleX = (index) => {
    return padding.left + (index / (points.length - 1 || 1)) * chartW;
  };

  // Build SVG path strings
  let actualPath = "";
  let predictedPath = "";

  points.forEach((pt, idx) => {
    const x = scaleX(idx);
    if (pt.actual_speed != null) {
      const y = scaleY(pt.actual_speed);
      actualPath += `${actualPath ? " L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    if (pt.predicted_speed != null) {
      const y = scaleY(pt.predicted_speed);
      predictedPath += `${predictedPath ? " L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
  });

  return (
    <div className="timeline-svg-wrapper">
      {/* Chart Legend */}
      <div className="chart-legend-row">
        <div className="chart-legend-item">
          <span className="legend-line actual-line" />
          <span>Actual Recorded Speed</span>
        </div>
        <div className="chart-legend-item">
          <span className="legend-line predicted-line" />
          <span>Predicted Forecast Speed</span>
        </div>
        <div className="chart-legend-item">
          <span className="legend-box free-flow-zone" />
          <span>Free Flow (&gt;45 mph)</span>
        </div>
        <div className="chart-legend-item">
          <span className="legend-box moderate-zone" />
          <span>Moderate (26-45 mph)</span>
        </div>
        <div className="chart-legend-item">
          <span className="legend-box heavy-zone" />
          <span>Heavy (&lt;26 mph)</span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="timeline-comparison-svg" aria-label="Speed Comparison Timeline">
        {/* Congestion Zone Background Shading */}
        {/* Free flow zone: 45.5 to 80 mph */}
        <rect
          x={padding.left}
          y={scaleY(80)}
          width={chartW}
          height={scaleY(45.5) - scaleY(80)}
          fill="rgba(34, 197, 94, 0.05)"
        />
        {/* Moderate zone: 26 to 45.5 mph */}
        <rect
          x={padding.left}
          y={scaleY(45.5)}
          width={chartW}
          height={scaleY(26) - scaleY(45.5)}
          fill="rgba(234, 179, 8, 0.05)"
        />
        {/* Heavy zone: 0 to 26 mph */}
        <rect
          x={padding.left}
          y={scaleY(26)}
          width={chartW}
          height={scaleY(0) - scaleY(26)}
          fill="rgba(239, 68, 68, 0.05)"
        />

        {/* Speed Gridlines (0, 20, 40, 60, 80 mph) */}
        {[0, 20, 40, 60, 80].map((spd) => {
          const y = scaleY(spd);
          return (
            <g key={spd}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="var(--gridline)"
                strokeDasharray="2 2"
                strokeWidth="1"
              />
              <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize="10" fill="var(--text-secondary)">
                {spd} mph
              </text>
            </g>
          );
        })}

        {/* Time Axis Labels */}
        {points.map((pt, idx) => {
          // Label every 8th point (e.g. every 2 hours)
          if (idx % 8 !== 0 && idx !== points.length - 1) return null;
          const x = scaleX(idx);
          const timeStr = pt.timestamp ? pt.timestamp.slice(11, 16) : "";
          return (
            <text key={idx} x={x} y={height - 12} textAnchor="middle" fontSize="10" fill="var(--text-secondary)">
              {timeStr}
            </text>
          );
        })}

        {/* Actual Speed Line */}
        {actualPath && (
          <path
            d={actualPath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Predicted Speed Line (Dashed) */}
        {predictedPath && (
          <path
            d={predictedPath}
            fill="none"
            stroke="var(--series-weighted)"
            strokeWidth="2.5"
            strokeDasharray="4 3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </div>
  );
}
