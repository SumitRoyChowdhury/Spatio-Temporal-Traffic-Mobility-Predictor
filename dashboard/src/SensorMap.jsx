import { useMemo, useState } from "react";

const WIDTH = 600;
const PADDING = 16;

// Plots sensors by latitude/longitude (equirectangular, scaled by cos(lat)).
export default function SensorMap({ sensors, selectedId, onSelect }) {
  const [hovered, setHovered] = useState(null);

  const { points, height } = useMemo(() => {
    const located = sensors.filter((s) => s.latitude != null && s.longitude != null);
    if (!located.length) return { points: [], height: 0 };
    const lats = located.map((s) => s.latitude);
    const lons = located.map((s) => s.longitude);
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
    const xScale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const spanX = (maxLon - minLon) * xScale || 1;
    const spanY = maxLat - minLat || 1;
    const scale = (WIDTH - PADDING * 2) / spanX;
    const mapHeight = Math.round(spanY * scale + PADDING * 2);
    return {
      height: mapHeight,
      points: located.map((sensor) => ({
        sensor,
        x: PADDING + (sensor.longitude - minLon) * xScale * scale,
        y: PADDING + (maxLat - sensor.latitude) * scale,
      })),
    };
  }, [sensors]);

  if (!points.length) return null;
  const selected = points.find((p) => p.sensor.sensor_id === selectedId);

  return (
    <div className="map">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label="Map of sensor locations; select a dot to choose a location"
        onMouseLeave={() => setHovered(null)}
      >
        {points.map((point) => (
          <circle key={point.sensor.sensor_id} className="dot" cx={point.x} cy={point.y} r="3" />
        ))}
        {selected && (
          <>
            <circle className="dot-halo" cx={selected.x} cy={selected.y} r="14" />
            <circle className="dot-selected" cx={selected.x} cy={selected.y} r="6" />
          </>
        )}
        {/* Larger invisible hit targets drawn on top */}
        {points.map((point) => (
          <circle
            key={`hit-${point.sensor.sensor_id}`}
            className="hit"
            cx={point.x}
            cy={point.y}
            r="8"
            onMouseEnter={() => setHovered(point)}
            onClick={() => onSelect(point.sensor.sensor_id)}
          />
        ))}
      </svg>
      {hovered && (
        <div
          className="tooltip"
          style={{
            left: `${(hovered.x / WIDTH) * 100}%`,
            top: `${(hovered.y / height) * 100}%`,
          }}
        >
          <strong>{hovered.sensor.name || "Unnamed"}</strong>
          <span>
            Fwy {hovered.sensor.freeway} {hovered.sensor.direction} · {hovered.sensor.sensor_id}
          </span>
        </div>
      )}
    </div>
  );
}
