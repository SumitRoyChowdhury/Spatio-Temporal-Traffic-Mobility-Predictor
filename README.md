# Gridlock traffic data pipeline

**Live dashboard: [gridlock-dashboard-48wd.onrender.com](https://gridlock-dashboard-48wd.onrender.com)**

> Hosted on Render's free tier: the first visit after a quiet spell can take
> 30–60 seconds while the server wakes up. Predictions cover 19 May – 7 June 2017.

The Node.js ingestion pipeline validates the wide traffic-speed CSV against the
sensor metadata CSV and persists normalized observations and rejected records
to PostgreSQL using Prisma. An independent Python training workflow reads the
validated observations from PostgreSQL and trains XGBoost, CatBoost, and
LightGBM models.

## Setup

1. Optionally copy `.env.example` to `.env` and set `DATABASE_URL` if the
   PostgreSQL connection differs from the supplied local defaults.
2. Install and generate Prisma Client:

   ```sh
   npm install
   npm run db:push
   npm run db:generate
   npm test
   ```

3. Run ingestion from the project directory:

   ```sh
   npm run pipeline
   ```

Input paths can be changed with `--train path.csv` and
`--metadata path.csv`. The default files are `train_data.csv` and
`PEMS-BAY-META.csv`. The ingestion pipeline uses Prisma ORM with the PostgreSQL driver adapter.
Create/update schema objects with Prisma `db push` before running it; `db push`
does not reset or drop existing data. The pipeline can be rerun safely.

## Validation behavior

| Condition | Action |
| --- | --- |
| Missing timestamp | Reject the sensor record into `quarantine_records` |
| Invalid timestamp | Reject the sensor record into `quarantine_records` |
| Missing speed | Store PostgreSQL `NaN`; flag `missing_speed` |
| Non-numeric speed | Convert to `NaN`; flag `non_numeric_speed` |
| Negative speed | Convert to `NaN`; flag `negative_speed` |
| Infinite speed | Convert to `NaN`; flag `infinite_speed` |
| Speed greater than 200 | Preserve the value; flag `excessive_speed` |
| Unknown sensor | Reject into `quarantine_records` |
| Duplicate observation | Deduplicate identical values; quarantine conflicting input |
| Irregular timestamp | Keep the observation and flag `irregular_timestamp` |

Timestamps without an offset are interpreted as UTC. The expected sampling
interval is five minutes. For a conflict with an already stored observation,
the existing row is retained and the incoming conflicting record is quarantined.
Invalid-speed values are represented by PostgreSQL's floating-point `NaN`;
flags are JSON arrays.

Main tables:

- `sensors`: known sensors and source metadata.
- `observations`: validated speeds, with flags and a unique sensor/timestamp key.
- `quarantine_records`: rejected inputs and duplicate conflicts.

Example checks:

```sql
SELECT sensor_id, observed_at, speed, flags
FROM observations
WHERE flags <> '[]'::jsonb
ORDER BY observed_at
LIMIT 100;

SELECT reason, count(*)
FROM quarantine_records
GROUP BY reason
ORDER BY reason;
```

## Python environment

Set up the Python environment from the project root:

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python -m unittest discover -s test
```

The training and prediction scripts read `DATABASE_URL` from `.env` if present
(it accepts the project's `.env.example` URI); otherwise they use the standard
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` variables.
Defaults target the local PostgreSQL socket, user `sumitroychowdhury`, and
database `gridlock_train_data`. No password is stored in the repository.

## Predict speed from historical references

This workflow predicts the speed at a sensor (location) and timestamp `t`
from that sensor's speed at the same time:

- one day earlier (`t - 1 day`),
- one week earlier (`t - 7 days`, the same weekday), and
- one year earlier (same date and time last year; Feb 29 uses Feb 28).

Both training and prediction read from `gridlock_train_data`. A missing or
invalid reference (missing row, `NaN`, negative or above 200) is passed to the
models as a missing value, so they use whichever references exist. If all
three are missing, no prediction is made. Instead the script logs
`Current data is not sufficient to predict the traffic speed` and exits with
status 3.

Train XGBoost, CatBoost, and LightGBM on every observation that has at least
one reference:

```sh
./.venv/bin/python -m training.train_reference_models
```

This writes `reference_{xgboost.json,catboost.cbm,lightgbm.txt}` and
`reference_metrics.json` to `model_artifacts/`. The metrics compare each
model with a baseline that averages the available references, broken down by
which references were available. `--sample-fraction 0.05` gives a quick trial
run. Then predict:

```sh
./.venv/bin/python -m training.predict_speed --sensor-id 400001 --timestamp 2017-05-15T08:30:00
```

Timestamps without an offset are treated as UTC, like ingestion, and are rounded
to the nearest five-minute slot. The JSON output lists each reference's
timestamp and speed, which references were used, each model's prediction and
their mean. When the target time is already in the database, it also shows
the recorded `actual_speed`.

The current dataset covers only January to May 2017, so the previous-year
reference is never available. The models learn from the previous-day and
previous-week references only. A previous-year speed found later has no
effect until the models are retrained on more than a year of data.

## Dashboard

A React dashboard (in `dashboard/`) takes a location (sensor) and a timestamp
and shows one predicted speed per model (XGBoost, CatBoost, LightGBM), the
references that were used, and the recorded speed when it exists. Pick a
location from the list or by clicking a sensor on the map. Times are UTC.

The dashboard talks to a small Python API, `training/api.py`, which loads the
three trained models once and reads references from PostgreSQL. Train the
models first (see above), then:

```sh
cd dashboard && npm install && npm run build && cd ..
./.venv/bin/python -m training.api
```

Open http://127.0.0.1:8000. For front-end development, keep the API running
and use `npm run dev` in `dashboard/` (Vite proxies `/api` to port 8000).

API endpoints:

- `GET /api/meta`: sensors with location details, the data range, and each
  model's validation error.
- `GET /api/predict?sensor_id=400001&timestamp=2017-05-15T08:30`: the three
  predictions. It returns HTTP 422 with `insufficient_data: true` when no
  previous-day, previous-week or previous-year reading exists. Once ensemble
  weights are fitted (below) it also returns `weighted_predicted_speed`.
- `GET /api/evaluation`: held-out test results, ensemble weights and the
  time-of-day chart data shown at the bottom of the dashboard.

## Test-set evaluation and weighted ensemble

Score the three models on a held-out CSV in the PEMS-BAY wide layout (one
column per sensor, timestamps in `Unnamed: 0`) and fit ensemble weights:

```sh
./.venv/bin/python -m training.evaluate_ensemble ../first_week_june_2017.csv
```

Features for each test reading are read from PostgreSQL as at prediction
time. The weights are the non-negative coefficients summing to 1 that minimise
squared error on the test data. Because they are fitted on that data, the
script also reports a 6-fold time-blocked cross-validated score. Results go to
`model_artifacts/ensemble_weights.json`; restart the API to pick them up.

## Free hosting (Neon + Render)

The hosted dashboard uses a trimmed copy of the data: predictions only look
back one day and one week, so the last 14 days (18–31 May 2017, about 1.3M
rows, ~135 MB) are enough and fit Neon's free tier. Predictions then work for
19 May to 7 June 2017.

1. Create a Neon project in **AWS Asia Pacific 1 (Singapore)** and put its
   direct (non-pooled) connection string in `.env` as `NEON_DATABASE_URL`.
2. Copy the recent data (drops and recreates `sensors` and `observations` in
   Neon only):
   ```bash
   ./.venv/bin/python -m training.export_recent --days 14
   ```
3. On Render, create a **Blueprint** from this repository. `render.yaml`
   defines one free Docker web service in Singapore; enter the Neon
   connection string as `DATABASE_URL` when asked.

The `Dockerfile` builds the dashboard and serves it with the API. The trained
model files in `model_artifacts/` are committed so the image can load them.
Free Render services sleep after about 15 idle minutes; the first visit
afterwards takes 30–60 seconds.
