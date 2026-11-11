# Gridlock traffic data pipeline

This Node.js pipeline validates the wide traffic-speed CSV against the sensor
metadata CSV and persists normalized observations and rejected records to
PostgreSQL using Prisma. It requires Node.js 20+ and does not use Python.

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

3. Run from the project directory:

   ```sh
   npm run pipeline
   ```

Input paths can be changed with `--train path.csv` and
`--metadata path.csv`. The default files are `train_data.csv` and
`PEMS-BAY-META.csv`. The pipeline uses Prisma ORM with the PostgreSQL driver adapter. Create/update
schema objects with Prisma `db push` before running it; `db push` does not reset
or drop existing data. The pipeline can be rerun safely.

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
