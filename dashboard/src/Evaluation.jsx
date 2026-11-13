import { useEffect, useMemo, useState } from "react";

const MODELS = [
  { key: "xgboost", label: "XGBoost", series: 1 },
  { key: "catboost", label: "CatBoost", series: 2 },
  { key: "lightgbm", label: "LightGBM", series: 3 },
];

const fmt = (value, digits = 2) => (value == null || Number.isNaN(value) ? "—" : value.toFixed(digits));
const pct = (value) => `${(value * 100).toFixed(1)}%`;

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});

export default function Evaluation() {
  const [evaluation, setEvaluation] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/evaluation")
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then(setEvaluation)
      .catch(() =>
        setError("No test evaluation yet. Run `python -m training.evaluate_ensemble <test.csv>`."),
      );
  }, []);

  if (error) return <section className="card evaluation"><p className="subtle">{error}</p></section>;
  if (!evaluation) return null;

  const best = evaluation.best_model;
  const cv = evaluation.weighted_ensemble_cross_validated;
  const rows = [
    ...MODELS.map((model) => ({
      ...model,
      weight: evaluation.weights[model.key],
      metrics: evaluation.models[model.key],
      isBest: model.key === best,
    })),
  ];

  return (
    <section className="evaluation">
      <div className="result-heading">
        <h2>Test-set results</h2>
        <p className="subtle">
          {evaluation.test_file} · {dayFormat.format(new Date(evaluation.test_start))} ·{" "}
          {evaluation.test_examples.toLocaleString()} readings from {evaluation.test_sensors} sensors
          (not used in training)
        </p>
      </div>

      <div className="tiles">
        <article className="card tile">
          <p className="tile-label">Best single model</p>
          <p className="tile-value">{MODELS.find((m) => m.key === best)?.label}</p>
          <p className="subtle small">RMSE {fmt(evaluation.models[best].rmse)} mph</p>
        </article>
        <article className="card tile">
          <p className="tile-label">
            <span className="swatch series-weighted" aria-hidden="true" />
            Weighted ensemble
          </p>
          <p className="tile-value">
            {fmt(evaluation.weighted_ensemble.rmse)}
            <span className="unit">mph RMSE</span>
          </p>
          <p className="subtle small">
            R² {fmt(evaluation.weighted_ensemble.r2, 3)} · MAE {fmt(evaluation.weighted_ensemble.mae)} mph
          </p>
        </article>
        <article className="card tile">
          <p className="tile-label">Fitted weights</p>
          <div className="weights">
            {MODELS.map((model) => (
              <div key={model.key} className="weight-row">
                <span className={`swatch series-${model.series}`} aria-hidden="true" />
                <span>{model.label}</span>
                <span className="weight-bar">
                  <span style={{ width: pct(evaluation.weights[model.key]) }} className={`fill series-${model.series}`} />
                </span>
                <strong>{fmt(evaluation.weights[model.key], 3)}</strong>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="card">
        <h3>Accuracy on the test day</h3>
        <div className="table-scroll">
          <table className="metrics">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Weight</th>
                <th scope="col">RMSE</th>
                <th scope="col">MAE</th>
                <th scope="col">MAPE</th>
                <th scope="col">R²</th>
                <th scope="col">Bias</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <MetricRow
                  key={row.key}
                  label={row.label}
                  swatch={`series-${row.series}`}
                  weight={fmt(row.weight, 3)}
                  metrics={row.metrics}
                  badge={row.isBest ? "best" : null}
                />
              ))}
              <MetricRow
                label="Weighted ensemble"
                swatch="series-weighted"
                weight="Σ = 1"
                metrics={evaluation.weighted_ensemble}
                strong
              />
              <MetricRow
                label="Weighted ensemble (cross-validated)"
                weight={`${cv.folds} folds`}
                metrics={cv.metrics}
              />
              <MetricRow label="Equal-weight mean" weight="⅓ each" metrics={evaluation.equal_mean_ensemble} />
              <MetricRow label="Reference mean (no model)" weight="—" metrics={evaluation.reference_mean_baseline} />
            </tbody>
          </table>
        </div>
        <p className="subtle small note">
          Weights minimise squared error on the test day, constrained to be non-negative and sum to 1.
          The cross-validated row fits weights on five blocks of the day and scores the sixth, which
          gives an out-of-sample estimate. Errors are in mph; bias is mean(predicted − actual).
        </p>
      </div>

      <div className="card">
        <h3>Average speed across all sensors through the test day</h3>
        <TimelineChart timeline={evaluation.timeline} />
      </div>
    </section>
  );
}

function MetricRow({ label, swatch, weight, metrics, badge, strong }) {
  return (
    <tr className={strong ? "strong" : undefined}>
      <th scope="row">
        {swatch && <span className={`swatch ${swatch}`} aria-hidden="true" />}
        {label}
        {badge && <span className="badge">{badge}</span>}
      </th>
      <td>{weight}</td>
      <td>{fmt(metrics.rmse, 3)}</td>
      <td>{fmt(metrics.mae, 3)}</td>
      <td>{fmt(metrics.mape, 2)}%</td>
      <td>{fmt(metrics.r2, 4)}</td>
      <td>{metrics.bias >= 0 ? "+" : ""}{fmt(metrics.bias, 3)}</td>
    </tr>
  );
}

const SERIES = [
  { key: "actual", label: "Recorded", className: "line-actual" },
  { key: "weighted", label: "Weighted ensemble", className: "line-weighted" },
  ...MODELS.map((m) => ({ key: m.key, label: m.label, className: `line-series-${m.series}` })),
];

function TimelineChart({ timeline }) {
  const [hover, setHover] = useState(null);
  const width = 760;
  const height = 260;
  const pad = { top: 12, right: 12, bottom: 28, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const { yMin, yMax, ticks } = useMemo(() => {
    const values = timeline.flatMap((p) => SERIES.map((s) => p[s.key]));
    const lo = Math.floor(Math.min(...values) / 5) * 5;
    const hi = Math.ceil(Math.max(...values) / 5) * 5;
    const step = hi - lo > 20 ? 10 : 5;
    const t = [];
    for (let v = lo; v <= hi; v += step) t.push(v);
    return { yMin: lo, yMax: hi, ticks: t };
  }, [timeline]);

  const x = (i) => pad.left + (i / (timeline.length - 1)) * innerW;
  const y = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const path = (key) => timeline.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  const hours = [0, 3, 6, 9, 12, 15, 18, 21];
  const point = hover == null ? null : timeline[hover];

  function onMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - pad.left) / innerW) * (timeline.length - 1));
    setHover(Math.max(0, Math.min(timeline.length - 1, i)));
  }

  return (
    <div className="chart">
      <div className="legend">
        {SERIES.map((s) => (
          <span key={s.key} className="legend-item">
            <span className={`legend-line ${s.className}`} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Average recorded and predicted speed by time of day"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={pad.left - 6} y={y(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        {hours.map((h) => (
          <text key={h} className="axis-label" x={x(h * 12)} y={height - 8} textAnchor="middle">
            {String(h).padStart(2, "0")}:00
          </text>
        ))}
        {SERIES.slice(2).map((s) => <path key={s.key} d={path(s.key)} className={`line ${s.className} thin`} />)}
        <path d={path("actual")} className="line line-actual" />
        <path d={path("weighted")} className="line line-weighted" />
        {point && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} />}
      </svg>
      <p className="subtle small chart-readout">
        {point
          ? `${point.timestamp.slice(11, 16)} UTC · ` +
            SERIES.map((s) => `${s.label} ${fmt(point[s.key], 1)}`).join(" · ") + " mph"
          : "Hover the chart to read values (mph, UTC)."}
      </p>
    </div>
  );
}
