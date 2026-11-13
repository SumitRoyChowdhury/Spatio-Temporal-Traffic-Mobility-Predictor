#!/usr/bin/env python3
"""Copy the most recent days of data into a small hosted PostgreSQL database.

Predictions only look back one day and one week, so the last couple of weeks
of observations are enough to serve the dashboard. Only the columns the API
reads are copied (sensors: id + metadata; observations: sensor, time, speed),
which keeps the copy within free database tiers.

The source is the local database (``DATABASE_URL`` or the ``PG*`` defaults);
the target is ``NEON_DATABASE_URL`` unless ``--target-url`` is given. Target
tables are dropped and recreated.

    ./.venv/bin/python -m training.export_recent --days 14
"""

from __future__ import annotations

import argparse
import os
from datetime import timedelta

import psycopg

from training.db import connect

SCHEMA = """
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS sensors;
CREATE TABLE sensors (
    sensor_id BIGINT PRIMARY KEY,
    metadata  JSONB NOT NULL
);
CREATE TABLE observations (
    sensor_id   BIGINT NOT NULL REFERENCES sensors (sensor_id),
    observed_at TIMESTAMPTZ NOT NULL,
    speed       DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (sensor_id, observed_at)
);
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=14, help="Days of observations to keep.")
    parser.add_argument("--target-url", default=os.environ.get("NEON_DATABASE_URL"))
    return parser.parse_args()


def copy_table(source, target, select_sql: str, params: tuple, table: str) -> None:
    with source.cursor() as read, target.cursor() as write:
        with read.copy(f"COPY ({select_sql}) TO STDOUT (FORMAT BINARY)", params) as out, \
                write.copy(f"COPY {table} FROM STDIN (FORMAT BINARY)") as into:
            for block in out:
                into.write(block)


def run() -> int:
    args = parse_args()
    if not args.target_url:
        raise SystemExit("Set NEON_DATABASE_URL in .env or pass --target-url.")

    with connect() as source, psycopg.connect(args.target_url, options="-c timezone=UTC") as target:
        with source.cursor() as cursor:
            cursor.execute("SELECT MAX(observed_at) FROM observations")
            (latest,) = cursor.fetchone()
        day_end = latest.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        start = day_end - timedelta(days=args.days)
        print(f"Copying observations from {start.isoformat()} to {latest.isoformat()}")

        target.execute(SCHEMA)
        copy_table(source, target, "SELECT sensor_id, metadata FROM sensors", (), "sensors (sensor_id, metadata)")
        # Prepared parameters are not allowed in COPY, so the bound is inlined as a literal.
        bound = start.isoformat()
        copy_table(
            source, target,
            f"SELECT sensor_id, observed_at, speed FROM observations WHERE observed_at >= '{bound}'::timestamptz",
            (), "observations (sensor_id, observed_at, speed)",
        )
        target.execute("CREATE INDEX observations_observed_at_idx ON observations (observed_at)")
        target.execute("ANALYZE sensors; ANALYZE observations")
        target.commit()

        with target.cursor() as cursor:
            cursor.execute("SELECT COUNT(*), MIN(observed_at), MAX(observed_at) FROM observations")
            count, first, last = cursor.fetchone()
            cursor.execute("SELECT COUNT(*) FROM sensors")
            (sensors,) = cursor.fetchone()
            cursor.execute("SELECT pg_size_pretty(pg_database_size(current_database()))")
            (size,) = cursor.fetchone()
    print(f"Target now has {sensors} sensors and {count:,} observations "
          f"({first.isoformat()} → {last.isoformat()}), database size {size}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
