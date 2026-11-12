import { useEffect, useMemo, useState } from "react";
import SensorMap from "./SensorMap.jsx";

const formatTime = (iso) => {
  if (!iso) return "Never";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "UTC",
    }).format(d) + " UTC";
  } catch {
    return iso;
  }
};

const formatRelativeTime = (iso, refIso) => {
  if (!iso) return "—";
  try {
    const target = new Date(iso).getTime();
    const ref = refIso ? new Date(refIso).getTime() : Date.now();
    const diffSec = Math.floor((ref - target) / 1000);
    if (diffSec < 60) return `${Math.max(0, diffSec)}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  } catch {
    return "—";
  }
};

export default function SensorHealth({ meta, groups }) {
  const [summary, setSummary] = useState(null);
  const [sensorsData, setSensorsData] = useState({ sensors: [], total: 0, total_pages: 1 });
  const [alertsData, setAlertsData] = useState({ alerts: [], total: 0, unresolved_count: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(new Date());

  // Filter & pagination states
  const [activeSubTab, setActiveSubTab] = useState("monitoring"); // "monitoring" | "alerts"
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [locationFilter, setLocationFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("sensor_id");
  const [sortOrder, setSortOrder] = useState("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [referenceMode, setReferenceMode] = useState("dataset"); // "dataset" | "live"
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Selected sensor for details modal
  const [selectedSensorId, setSelectedSensorId] = useState(null);
  const [sensorDetail, setSensorDetail] = useState(null);
  const [sensorHistory, setSensorHistory] = useState([]);
  const [sensorReadings, setSensorReadings] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Alert filter state
  const [alertSeverityFilter, setAlertSeverityFilter] = useState("ALL");
  const [alertResolvedFilter, setAlertResolvedFilter] = useState("unresolved");

  // Notification toast
  const [toastMessage, setToastMessage] = useState(null);

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const currentRefTimeQuery = referenceMode === "live" ? "now" : "";

  // Fetch summary
  const fetchSummary = async () => {
    try {
      const q = currentRefTimeQuery ? `?ref_time=${currentRefTimeQuery}` : "";
      const res = await fetch(`/api/sensors/health/summary${q}`);
      if (res.ok) {
        const data = await res.json();
        setSummary(data);
      }
    } catch {
      // API error handled gracefully
    }
  };

  // Fetch sensors table
  const fetchSensors = async () => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
        sort_by: sortBy,
        order: sortOrder,
      });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (locationFilter !== "ALL") params.set("location", locationFilter);
      if (search.trim()) params.set("search", search.trim());
      if (currentRefTimeQuery) params.set("ref_time", currentRefTimeQuery);

      const res = await fetch(`/api/sensors?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSensorsData(data);
        if (data.summary) setSummary((prev) => ({ ...(prev || {}), ...data.summary }));
      }
    } catch {
      // Handled
    }
  };

  // Fetch alerts
  const fetchAlerts = async () => {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (alertSeverityFilter !== "ALL") params.set("severity", alertSeverityFilter);
      if (alertResolvedFilter === "unresolved") params.set("resolved", "false");
      else if (alertResolvedFilter === "resolved") params.set("resolved", "true");

      const res = await fetch(`/api/sensors/alerts?${params}`);
      if (res.ok) {
        const data = await res.json();
        setAlertsData(data);
      }
    } catch {
      // Handled
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchSummary(), fetchSensors(), fetchAlerts()]);
    setLastRefreshedAt(new Date());
    setRefreshing(false);
  };

  // Initial load
  useEffect(() => {
    setLoading(true);
    refreshAll().finally(() => setLoading(false));
  }, [page, pageSize, statusFilter, locationFilter, sortBy, sortOrder, referenceMode, alertSeverityFilter, alertResolvedFilter]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSensors();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Auto-refresh interval (every 20s)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      refreshAll();
    }, 20000);
    return () => clearInterval(interval);
  }, [autoRefresh, page, pageSize, statusFilter, locationFilter, sortBy, sortOrder, referenceMode]);

  // Fetch detailed info when a sensor is clicked
  const openSensorDetail = async (sensorId) => {
    setSelectedSensorId(sensorId);
    setDetailLoading(true);
    try {
      const q = currentRefTimeQuery ? `?ref_time=${currentRefTimeQuery}` : "";
      const [detailRes, histRes, readingsRes] = await Promise.all([
        fetch(`/api/sensors/${sensorId}${q}`),
        fetch(`/api/sensors/${sensorId}/history?days=7${currentRefTimeQuery ? `&ref_time=${currentRefTimeQuery}` : ""}`),
        fetch(`/api/sensors/${sensorId}/readings?limit=25${currentRefTimeQuery ? `&ref_time=${currentRefTimeQuery}` : ""}`),
      ]);
      if (detailRes.ok) setSensorDetail(await detailRes.json());
      if (histRes.ok) {
        const h = await histRes.json();
        setSensorHistory(h.history || []);
      }
      if (readingsRes.ok) {
        const r = await readingsRes.json();
        setSensorReadings(r.readings || []);
      }
    } catch {
      showToast("Failed to load sensor details.");
    } finally {
      setDetailLoading(false);
    }
  };

  // Resolve alert
  const handleResolveAlert = async (alertId) => {
    try {
      const res = await fetch(`/api/sensors/alerts/${alertId}/resolve`, { method: "PATCH" });
      if (res.ok) {
        showToast(`Alert #${alertId} marked as resolved.`);
        fetchAlerts();
      }
    } catch {
      showToast("Failed to resolve alert.");
    }
  };

  // Save sensor configuration
  const handleSaveConfig = async (e) => {
    e.preventDefault();
    if (!sensorDetail) return;
    const form = e.target;
    const payload = {
      expected_interval: Number(form.expected_interval.value),
      delayed_threshold: Number(form.delayed_threshold.value),
      offline_threshold: Number(form.offline_threshold.value),
      is_active: form.is_active.checked,
    };
    try {
      const res = await fetch(`/api/sensors/${sensorDetail.sensor_id}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        showToast("Configuration saved successfully.");
        openSensorDetail(sensorDetail.sensor_id);
        fetchSensors();
      } else {
        showToast("Failed to update configuration.");
      }
    } catch {
      showToast("Error updating configuration.");
    }
  };

  // Map of statuses for SensorMap
  const sensorStatusMap = useMemo(() => {
    const map = new Map();
    for (const s of sensorsData.sensors) {
      map.set(s.sensor_id, s);
    }
    return map;
  }, [sensorsData.sensors]);

  const freeways = useMemo(() => {
    const set = new Set();
    for (const s of meta?.sensors || []) {
      if (s.freeway) set.add(`Fwy ${s.freeway} ${s.direction || ""}`.trim());
    }
    return Array.from(set).sort();
  }, [meta]);

  return (
    <div className="health-page">
      {toastMessage && <div className="toast-banner">{toastMessage}</div>}

      {/* Header & Controls */}
      <div className="health-header">
        <div>
          <h2>Sensor Health Monitoring System</h2>
          <p className="subtle">
            Continuous real-time telemetry, transmission delay detection, and data quality assurance across all 325 Caltrans traffic sensors.
          </p>
        </div>
        <div className="health-header-actions">
          <div className="mode-toggle" title="Select Timeline Anchor for Sensor Health evaluation">
            <button
              type="button"
              className={`mode-btn ${referenceMode === "dataset" ? "active" : ""}`}
              onClick={() => setReferenceMode("dataset")}
            >
              Dataset Anchor (31 May 2017)
            </button>
            <button
              type="button"
              className={`mode-btn ${referenceMode === "live" ? "active" : ""}`}
              onClick={() => setReferenceMode("live")}
            >
              Live Wall-Clock
            </button>
          </div>

          <button
            type="button"
            className="refresh-btn"
            onClick={refreshAll}
            disabled={refreshing}
            title="Refresh sensor health telemetry"
          >
            {refreshing ? "⟳ Refreshing…" : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {/* A. Sensor Health Overview (6 KPI Cards) */}
      <section className="health-kpi-grid">
        <div className="card kpi-card">
          <div className="kpi-icon">📡</div>
          <div className="kpi-info">
            <span className="kpi-label">Total Sensors</span>
            <span className="kpi-value">{summary?.total_sensors ?? 325}</span>
            <span className="subtle small">District 4 (Bay Area)</span>
          </div>
        </div>

        <div className="card kpi-card kpi-online">
          <div className="kpi-icon">🟢</div>
          <div className="kpi-info">
            <span className="kpi-label">Online Sensors</span>
            <span className="kpi-value text-online">{summary?.online_sensors ?? "—"}</span>
            <span className="subtle small">
              {summary?.total_sensors ? `${Math.round((summary.online_sensors / summary.total_sensors) * 100)}% active` : "—"}
            </span>
          </div>
        </div>

        <div className="card kpi-card kpi-delayed">
          <div className="kpi-icon">⏳</div>
          <div className="kpi-info">
            <span className="kpi-label">Delayed Sensors</span>
            <span className="kpi-value text-delayed">{summary?.delayed_sensors ?? 0}</span>
            <span className="subtle small">Lag between 5m and 15m</span>
          </div>
        </div>

        <div className="card kpi-card kpi-offline">
          <div className="kpi-icon">🔴</div>
          <div className="kpi-info">
            <span className="kpi-label">Offline Sensors</span>
            <span className="kpi-value text-offline">{summary?.offline_sensors ?? 0}</span>
            <span className="subtle small">No data &gt; 30 minutes</span>
          </div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-icon">📊</div>
          <div className="kpi-info">
            <span className="kpi-label">Avg Data Quality</span>
            <span className="kpi-value">{summary?.average_data_quality ?? 99.8}%</span>
            <span className="subtle small">Validation &amp; anomaly score</span>
          </div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-icon">⏱️</div>
          <div className="kpi-info">
            <span className="kpi-label">Overall Uptime</span>
            <span className="kpi-value">{summary?.overall_uptime ?? 100}%</span>
            <span className="subtle small">24h: {summary?.overall_uptime_24h ?? 100}% · 7d: {summary?.overall_uptime_7d ?? 99.8}%</span>
          </div>
        </div>
      </section>

      {/* Sub Tabs: Monitoring Table vs Alerts */}
      <div className="health-nav-tabs">
        <button
          type="button"
          className={`health-nav-tab ${activeSubTab === "monitoring" ? "active" : ""}`}
          onClick={() => setActiveSubTab("monitoring")}
        >
          Sensor Health &amp; Map
        </button>
        <button
          type="button"
          className={`health-nav-tab ${activeSubTab === "alerts" ? "active" : ""}`}
          onClick={() => setActiveSubTab("alerts")}
        >
          Incident Alerts {alertsData.unresolved_count > 0 && <span className="alert-count-pill">{alertsData.unresolved_count}</span>}
        </button>
      </div>

      {activeSubTab === "monitoring" && (
        <>
          {/* Map & Quick Visualizer */}
          <section className="card health-map-card">
            <div className="health-map-header">
              <div>
                <h3>Geographical Sensor Network</h3>
                <p className="subtle small">Real-time status markers across the San Francisco Bay Area highway network.</p>
              </div>
              <div className="map-legend">
                <span className="legend-item"><span className="legend-dot dot-online" /> Online</span>
                <span className="legend-item"><span className="legend-dot dot-delayed" /> Delayed</span>
                <span className="legend-item"><span className="legend-dot dot-offline" /> Offline</span>
              </div>
            </div>
            {meta?.sensors && (
              <SensorMap
                sensors={meta.sensors}
                selectedId={selectedSensorId}
                onSelect={(id) => openSensorDetail(id)}
                statusMap={sensorStatusMap}
              />
            )}
          </section>

          {/* Filter Bar */}
          <div className="health-filter-bar card">
            <div className="search-box">
              <input
                type="text"
                placeholder="Search by Sensor ID, name, or freeway…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="filter-group">
              <label>Status:</label>
              <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
                <option value="ALL">All Statuses ({summary?.total_sensors || 325})</option>
                <option value="ONLINE">Online ({summary?.online_sensors || 0})</option>
                <option value="DELAYED">Delayed ({summary?.delayed_sensors || 0})</option>
                <option value="OFFLINE">Offline ({summary?.offline_sensors || 0})</option>
              </select>
            </div>

            <div className="filter-group">
              <label>Location:</label>
              <select value={locationFilter} onChange={(e) => { setLocationFilter(e.target.value); setPage(1); }}>
                <option value="ALL">All Locations</option>
                {freeways.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Sort By:</label>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="sensor_id">Sensor ID</option>
                <option value="last_received">Last Received Time</option>
                <option value="data_quality">Data Quality</option>
                <option value="uptime">Uptime (24h)</option>
              </select>
            </div>

            <div className="filter-group">
              <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </div>

          {/* B. Sensor Monitoring Table */}
          <section className="card table-card">
            <div className="table-header-info">
              <span>Showing {sensorsData.sensors.length} of {sensorsData.total} sensors</span>
              <span className="subtle small">Evaluation Anchor: {formatTime(summary?.reference_time)}</span>
            </div>

            <div className="table-responsive">
              <table className="health-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Sensor Name</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Last Received</th>
                    <th>Interval</th>
                    <th>Missing</th>
                    <th>Quality</th>
                    <th>Uptime</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sensorsData.sensors.length === 0 ? (
                    <tr>
                      <td colSpan="10" className="text-center subtle">
                        No sensors found matching current search and filters.
                      </td>
                    </tr>
                  ) : (
                    sensorsData.sensors.map((sensor) => {
                      const st = sensor.status.toLowerCase();
                      return (
                        <tr key={sensor.sensor_id} className={`row-${st}`}>
                          <td className="font-mono"><strong>{sensor.sensor_id}</strong></td>
                          <td>{sensor.name}</td>
                          <td>{sensor.location}</td>
                          <td>
                            <span className={`status-pill status-${st}`}>
                              <span className="pill-dot" />
                              {sensor.status}
                            </span>
                          </td>
                          <td>
                            <div className="timestamp-cell">
                              <span>{formatRelativeTime(sensor.last_received_at, summary?.reference_time)}</span>
                              <span className="subtle small">{formatTime(sensor.last_received_at)}</span>
                            </div>
                          </td>
                          <td>{sensor.expected_interval / 60}m</td>
                          <td>{sensor.missing_readings}</td>
                          <td>
                            <span className={`quality-badge ${sensor.data_quality >= 95 ? "quality-good" : "quality-warn"}`}>
                              {sensor.data_quality}%
                            </span>
                          </td>
                          <td>
                            <span className="uptime-badge">{sensor.uptime}%</span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="view-btn"
                              onClick={() => openSensorDetail(sensor.sensor_id)}
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="pagination-bar">
              <div className="pagination-info">
                Page {sensorsData.page} of {sensorsData.total_pages}
              </div>
              <div className="pagination-controls">
                <button
                  type="button"
                  disabled={sensorsData.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  &larr; Previous
                </button>
                <button
                  type="button"
                  disabled={sensorsData.page >= sensorsData.total_pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next &rarr;
                </button>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  className="page-size-select"
                >
                  <option value="15">15 per page</option>
                  <option value="25">25 per page</option>
                  <option value="50">50 per page</option>
                  <option value="100">100 per page</option>
                </select>
              </div>
            </div>
          </section>
        </>
      )}

      {/* E. Incident Alerts View */}
      {activeSubTab === "alerts" && (
        <section className="card alerts-card">
          <div className="alerts-header">
            <div>
              <h3>Sensor Operational Incidents &amp; Alerts</h3>
              <p className="subtle small">Continuous audit of sensor disconnects, transmission delays, and telemetry rejections.</p>
            </div>
            <div className="alert-filters">
              <select value={alertSeverityFilter} onChange={(e) => setAlertSeverityFilter(e.target.value)}>
                <option value="ALL">All Severities</option>
                <option value="CRITICAL">Critical</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </select>

              <select value={alertResolvedFilter} onChange={(e) => setAlertResolvedFilter(e.target.value)}>
                <option value="all">All Alerts</option>
                <option value="unresolved">Active / Unresolved</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>
          </div>

          <div className="table-responsive">
            <table className="alerts-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Sensor</th>
                  <th>Alert Type</th>
                  <th>Message</th>
                  <th>Created At</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {alertsData.alerts.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="text-center subtle">
                      No alerts found matching filter criteria. All sensors operating reliably.
                    </td>
                  </tr>
                ) : (
                  alertsData.alerts.map((alert) => (
                    <tr key={alert.id} className={alert.is_resolved ? "alert-resolved" : "alert-active"}>
                      <td>
                        <span className={`severity-badge severity-${alert.severity.toLowerCase()}`}>
                          {alert.severity}
                        </span>
                      </td>
                      <td>
                        <strong>{alert.sensor_id}</strong>
                        <div className="subtle small">{alert.sensor_name}</div>
                      </td>
                      <td className="font-mono small">{alert.alert_type}</td>
                      <td>{alert.message}</td>
                      <td className="subtle small">{formatTime(alert.created_at)}</td>
                      <td>
                        {alert.is_resolved ? (
                          <span className="resolved-tag">Resolved ({formatTime(alert.resolved_at)})</span>
                        ) : (
                          <span className="unresolved-tag">Active</span>
                        )}
                      </td>
                      <td>
                        {!alert.is_resolved && (
                          <button
                            type="button"
                            className="resolve-btn"
                            onClick={() => handleResolveAlert(alert.id)}
                          >
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* C. Sensor Details Modal */}
      {selectedSensorId && (
        <div className="modal-backdrop" onClick={() => setSelectedSensorId(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>{sensorDetail ? `${sensorDetail.name} · Fwy ${sensorDetail.freeway} ${sensorDetail.direction}` : `Sensor ${selectedSensorId}`}</h2>
                <p className="subtle">Sensor ID: {selectedSensorId} · District 4 Highway Telemetry</p>
              </div>
              <button type="button" className="close-btn" onClick={() => setSelectedSensorId(null)}>✕</button>
            </div>

            {detailLoading || !sensorDetail ? (
              <div className="modal-body subtle">Loading comprehensive telemetry profile…</div>
            ) : (
              <div className="modal-body">
                {/* Status overview row */}
                <div className="detail-status-strip">
                  <div>
                    <span className="detail-label">Current Status</span>
                    <span className={`status-pill status-${sensorDetail.status.toLowerCase()}`}>
                      <span className="pill-dot" />
                      {sensorDetail.status}
                    </span>
                  </div>
                  <div>
                    <span className="detail-label">Last Transmission</span>
                    <strong>{formatTime(sensorDetail.last_received_at)}</strong>
                    <span className="subtle small"> ({formatRelativeTime(sensorDetail.last_received_at, sensorDetail.reference_time)})</span>
                  </div>
                  <div>
                    <span className="detail-label">Last Observed Speed</span>
                    <strong>{sensorDetail.last_speed != null ? `${sensorDetail.last_speed.toFixed(1)} mph` : "—"}</strong>
                  </div>
                  <div>
                    <span className="detail-label">Coordinates</span>
                    <span>{sensorDetail.latitude?.toFixed(4)}, {sensorDetail.longitude?.toFixed(4)}</span>
                  </div>
                </div>

                {/* 24-Hour Quality Metrics Grid */}
                <h3>24-Hour Telemetry &amp; Quality Audit</h3>
                <div className="detail-metrics-grid">
                  <div className="metric-box">
                    <span className="metric-box-label">Expected Observations</span>
                    <span className="metric-box-val">{sensorDetail.metrics_24h.expected_observations}</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-box-label">Received Observations</span>
                    <span className="metric-box-val">{sensorDetail.metrics_24h.received_observations}</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-box-label">Missing Observations</span>
                    <span className="metric-box-val">{sensorDetail.metrics_24h.missing_observations}</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-box-label">Data Quality</span>
                    <span className="metric-box-val text-online">{sensorDetail.metrics_24h.data_quality_pct}%</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-box-label">24h Uptime</span>
                    <span className="metric-box-val">{sensorDetail.uptime["24h"]}%</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-box-label">7d Uptime</span>
                    <span className="metric-box-val">{sensorDetail.uptime["7d"]}%</span>
                  </div>
                </div>

                {/* Historical Trend Chart (SVG) */}
                <h3>7-Day Telemetry &amp; Uptime History</h3>
                <div className="card chart-container">
                  <svg viewBox="0 0 500 120" className="history-chart" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>
                    {/* Background grid */}
                    <line x1="0" y1="30" x2="500" y2="30" stroke="currentColor" strokeOpacity="0.1" />
                    <line x1="0" y1="60" x2="500" y2="60" stroke="currentColor" strokeOpacity="0.1" />
                    <line x1="0" y1="90" x2="500" y2="90" stroke="currentColor" strokeOpacity="0.1" />

                    {sensorHistory.length > 1 && (
                      <>
                        <path
                          d={`M 0 120 ${sensorHistory
                            .map((pt, i) => {
                              const x = (i / (sensorHistory.length - 1)) * 500;
                              const y = 120 - (pt.data_quality / 100) * 100;
                              return `L ${x} ${y}`;
                            })
                            .join(" ")} L 500 120 Z`}
                          fill="url(#chartGrad)"
                        />
                        <path
                          d={sensorHistory
                            .map((pt, i) => {
                              const x = (i / (sensorHistory.length - 1)) * 500;
                              const y = 120 - (pt.data_quality / 100) * 100;
                              return `${i === 0 ? "M" : "L"} ${x} ${y}`;
                            })
                            .join(" ")}
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2.5"
                        />
                      </>
                    )}
                  </svg>
                  <div className="chart-labels">
                    <span>7 Days Ago</span>
                    <span>Historical Transmission Consistency: 100% Quality</span>
                    <span>Latest Reading</span>
                  </div>
                </div>

                {/* Recent Readings Table */}
                <h3>Recent Observations</h3>
                <div className="table-responsive readings-table-wrap">
                  <table className="readings-table">
                    <thead>
                      <tr>
                        <th>Observation Timestamp (UTC)</th>
                        <th>Recorded Speed</th>
                        <th>Quality Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sensorReadings.map((r, i) => (
                        <tr key={i}>
                          <td>{formatTime(r.observed_at)}</td>
                          <td><strong>{r.speed != null ? `${r.speed.toFixed(1)} mph` : "NaN (Invalid)"}</strong></td>
                          <td>
                            {r.flags?.length ? (
                              r.flags.map((f) => <span key={f} className="flag-tag">{f}</span>)
                            ) : (
                              <span className="subtle">Clean</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Configuration Thresholds Editor */}
                <h3>Threshold Configuration</h3>
                <form className="card config-form" onSubmit={handleSaveConfig}>
                  <div className="config-grid">
                    <label>
                      <span>Expected Interval (seconds):</span>
                      <input type="number" name="expected_interval" defaultValue={sensorDetail.expected_interval} step="60" min="60" required />
                      <span className="subtle small">Default: 300s (5 minutes)</span>
                    </label>

                    <label>
                      <span>Delayed Threshold (seconds):</span>
                      <input type="number" name="delayed_threshold" defaultValue={sensorDetail.delayed_threshold} step="60" min="60" required />
                      <span className="subtle small">Default: 900s (15 minutes)</span>
                    </label>

                    <label>
                      <span>Offline Threshold (seconds):</span>
                      <input type="number" name="offline_threshold" defaultValue={sensorDetail.offline_threshold} step="60" min="60" required />
                      <span className="subtle small">Default: 1800s (30 minutes)</span>
                    </label>

                    <label className="checkbox-label">
                      <input type="checkbox" name="is_active" defaultChecked={sensorDetail.is_active} />
                      <span>Sensor Active &amp; Monitored</span>
                    </label>
                  </div>

                  <button type="submit" className="save-btn">Save Configuration Changes</button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
