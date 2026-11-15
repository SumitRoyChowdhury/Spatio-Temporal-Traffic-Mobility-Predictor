import { useEffect, useMemo, useRef, useState } from "react";

const BASE_WIDTH = 600;
const PADDING = 20;

// Plots sensors by latitude/longitude (equirectangular, scaled by cos(lat)).
// Supports pan, zoom, marker clustering, fullscreen, search highlights, and congestion coloring.
export default function SensorMap({
  sensors = [],
  selectedId,
  onSelect,
  statusMap,
  interactive = false,
  clustering = false,
  showLegend = false,
  searchHighlightId,
}) {
  const containerRef = useRef(null);
  const [hovered, setHovered] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Fullscreen listener
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleZoom = (delta) => {
    setZoom((prev) => Math.max(0.8, Math.min(6.0, Number((prev + delta).toFixed(1)))));
  };

  // Mouse pan handlers
  const handleMouseDown = (e) => {
    if (!interactive || e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Wheel zoom
  const handleWheel = (e) => {
    if (!interactive) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    handleZoom(delta);
  };

  // Projection math
  const { points, height, bounds } = useMemo(() => {
    const located = sensors.filter((s) => s.latitude != null && s.longitude != null);
    if (!located.length) return { points: [], height: 0, bounds: null };
    const lats = located.map((s) => s.latitude);
    const lons = located.map((s) => s.longitude);
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
    const xScale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const spanX = (maxLon - minLon) * xScale || 1;
    const spanY = maxLat - minLat || 1;
    const scale = (BASE_WIDTH - PADDING * 2) / spanX;
    const mapHeight = Math.round(spanY * scale + PADDING * 2);

    const projected = located.map((sensor) => {
      const health = statusMap?.get(sensor.sensor_id) || (sensor.status ? sensor : null);
      const x = PADDING + (sensor.longitude - minLon) * xScale * scale;
      const y = PADDING + (maxLat - sensor.latitude) * scale;
      return { sensor, health, x, y };
    });

    return {
      points: projected,
      height: mapHeight,
      bounds: { minLat, maxLat, minLon, maxLon, scale, xScale },
    };
  }, [sensors, statusMap]);

  // Marker clustering when zoomed out
  const { clusters, unclusteredPoints } = useMemo(() => {
    if (!clustering || zoom > 1.3 || points.length < 20) {
      return { clusters: [], unclusteredPoints: points };
    }

    const clusterRadius = 24 / zoom;
    const visited = new Set();
    const foundClusters = [];
    const singles = [];

    for (let i = 0; i < points.length; i++) {
      if (visited.has(i)) continue;
      const p1 = points[i];
      const members = [p1];
      visited.add(i);

      for (let j = i + 1; j < points.length; j++) {
        if (visited.has(j)) continue;
        const p2 = points[j];
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (dist <= clusterRadius) {
          visited.add(j);
          members.push(p2);
        }
      }

      if (members.length > 1) {
        const avgX = members.reduce((sum, m) => sum + m.x, 0) / members.length;
        const avgY = members.reduce((sum, m) => sum + m.y, 0) / members.length;

        // Count congestion states in cluster
        let heavy = 0, mod = 0, free = 0;
        for (const m of members) {
          const st = m.sensor.congestion_status || m.sensor.congestion_category;
          if (st === "HEAVY" || st === "HEAVY CONGESTION") heavy++;
          else if (st === "MODERATE" || st === "MODERATE TRAFFIC") mod++;
          else free++;
        }
        let clusterColor = "#15803d"; // Green
        if (heavy > 0) clusterColor = "#dc2626"; // Red if any heavy
        else if (mod > 0) clusterColor = "#eab308"; // Yellow if moderate

        foundClusters.push({
          x: avgX,
          y: avgY,
          count: members.length,
          color: clusterColor,
          members,
        });
      } else {
        singles.push(p1);
      }
    }

    return { clusters: foundClusters, unclusteredPoints: singles };
  }, [points, clustering, zoom]);

  if (!points.length) return null;
  const selected = points.find((p) => p.sensor.sensor_id === selectedId);

  return (
    <div
      ref={containerRef}
      className={`map ${interactive ? "map-interactive" : ""} ${isFullscreen ? "map-fullscreen" : ""}`}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{ cursor: isDragging ? "grabbing" : interactive ? "grab" : "default" }}
    >
      {/* Map Interactive Toolbar Controls */}
      {interactive && (
        <div className="map-controls-toolbar" onClick={(e) => e.stopPropagation()}>
          <button type="button" title="Zoom In" onClick={() => handleZoom(0.3)}>
            +
          </button>
          <button type="button" title="Zoom Out" onClick={() => handleZoom(-0.3)}>
            −
          </button>
          <button type="button" title="Reset View" onClick={resetView}>
            ⟲
          </button>
          <button type="button" title="Toggle Fullscreen" onClick={toggleFullscreen}>
            {isFullscreen ? "🗗" : "⛶"}
          </button>
        </div>
      )}

      {/* Map Legend Overlay */}
      {(showLegend || interactive) && (
        <div className="map-legend-overlay">
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#15803d" }} />
            <span>Free Flow (≥70%)</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#eab308" }} />
            <span>Moderate (40-70%)</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#dc2626" }} />
            <span>Heavy (&lt;40%)</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#6b7280" }} />
            <span>No Data</span>
          </div>
        </div>
      )}

      <svg
        viewBox={`0 0 ${BASE_WIDTH} ${height}`}
        role="img"
        aria-label="Map of sensor locations; select a dot to choose a location"
        onMouseLeave={() => {
          setHovered(null);
          setIsDragging(false);
        }}
        className="sensor-map-svg"
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Unclustered Sensors */}
          {unclusteredPoints.map((point) => {
            const sid = point.sensor.sensor_id;
            const customColor = point.sensor.color;
            const st = point.health?.status?.toLowerCase() || point.sensor.congestion_status?.toLowerCase();
            const dotClass = st ? `dot dot-${st}` : "dot";
            const isHighlighted = searchHighlightId != null && (searchHighlightId === sid || (Array.isArray(searchHighlightId) && searchHighlightId.includes(sid)));

            return (
              <g key={sid}>
                {isHighlighted && (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={8 / Math.sqrt(zoom)}
                    fill="none"
                    stroke="#2a78d6"
                    strokeWidth={2 / zoom}
                    strokeDasharray="2 2"
                    className="dot-search-highlight"
                  />
                )}
                <circle
                  className={dotClass}
                  cx={point.x}
                  cy={point.y}
                  r={3.8 / Math.sqrt(zoom)}
                  fill={customColor || undefined}
                />
              </g>
            );
          })}

          {/* Clustered Markers */}
          {clusters.map((c, cIdx) => (
            <g
              key={`cluster-${cIdx}`}
              className="map-cluster-marker"
              transform={`translate(${c.x}, ${c.y})`}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                // Zoom into cluster center
                setPan({
                  x: BASE_WIDTH / 2 - c.x * (zoom + 1.2),
                  y: height / 2 - c.y * (zoom + 1.2),
                });
                setZoom((prev) => Math.min(5.0, prev + 1.2));
              }}
              onMouseEnter={() => {
                setHovered({
                  x: c.x,
                  y: c.y,
                  sensor: {
                    name: `${c.count} Sensors Clustered`,
                    freeway: "Regional Cluster",
                    direction: "Zoom in to inspect",
                    sensor_id: `${c.count} units`,
                  },
                });
              }}
            >
              <circle r={14 / Math.sqrt(zoom)} fill={c.color} opacity={0.3} className="cluster-pulse" />
              <circle r={10 / Math.sqrt(zoom)} fill={c.color} stroke="#fff" strokeWidth={1.5 / zoom} />
              <text
                textAnchor="middle"
                dy={3.5 / Math.sqrt(zoom)}
                fontSize={9 / Math.sqrt(zoom)}
                fontWeight="700"
                fill="#ffffff"
              >
                {c.count}
              </text>
            </g>
          ))}

          {/* Selected Marker Halo & Core */}
          {selected && (
            <g>
              <circle
                className="dot-halo"
                cx={selected.x}
                cy={selected.y}
                r={14 / Math.sqrt(zoom)}
                strokeWidth={1.5 / zoom}
              />
              <circle
                className="dot-selected"
                cx={selected.x}
                cy={selected.y}
                r={6 / Math.sqrt(zoom)}
              />
            </g>
          )}

          {/* Larger invisible hit targets drawn on top for reliable hovering/clicking */}
          {unclusteredPoints.map((point) => (
            <circle
              key={`hit-${point.sensor.sensor_id}`}
              className="hit"
              cx={point.x}
              cy={point.y}
              r={9 / Math.sqrt(zoom)}
              onMouseEnter={() => setHovered(point)}
              onClick={(e) => {
                e.stopPropagation();
                if (onSelect) onSelect(point.sensor.sensor_id);
              }}
            />
          ))}
        </g>
      </svg>

      {/* Floating Tooltip */}
      {hovered && (
        <div
          className="tooltip"
          style={{
            left: `${((hovered.x * zoom + pan.x) / BASE_WIDTH) * 100}%`,
            top: `${((hovered.y * zoom + pan.y) / height) * 100}%`,
          }}
        >
          <strong>{hovered.sensor.name || "Unnamed"}</strong>
          <span>
            {hovered.sensor.freeway ? `Fwy ${hovered.sensor.freeway} ${hovered.sensor.direction || ""} · ` : ""}
            {hovered.sensor.sensor_id}
          </span>

          {/* Congestion info if present */}
          {hovered.sensor.congestion_category && (
            <div className="tooltip-congestion">
              <span
                className="legend-dot"
                style={{
                  background: hovered.sensor.color || "#15803d",
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  marginRight: 6,
                }}
              />
              <strong>{hovered.sensor.congestion_category}</strong>
              {hovered.sensor.primary_speed != null && (
                <span> ({Number(hovered.sensor.primary_speed).toFixed(1)} mph)</span>
              )}
            </div>
          )}

          {/* Health info if present */}
          {hovered.health?.status && (
            <div className="tooltip-health">
              <span className={`status-indicator status-indicator-${hovered.health.status.toLowerCase()}`} />
              <span>{hovered.health.status}</span>
              {hovered.health.data_quality != null && (
                <span> · {hovered.health.data_quality}% quality</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
