"""Historical-reference features for traffic-speed prediction.

The speed at sensor ``s`` and timestamp ``t`` is predicted from the speed at
the same sensor and time of day:

* one day earlier (``t - 1 day``),
* one week earlier (``t - 7 days``, so the same weekday), and
* one year earlier (same calendar date and time in the previous year).

Any subset of the three references may be missing; a prediction needs at
least one of them.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
SAMPLING_INTERVAL = timedelta(minutes=5)
MAX_VALID_SPEED = 200.0
REFERENCE_FEATURES = (
    "previous_day_speed",
    "previous_week_speed",
    "previous_year_speed",
)
FEATURE_NAMES = ("sensor_id", *REFERENCE_FEATURES)
# Shared by the trainer (which writes) and the predictor (which checks) the
# metrics file that describes the trained models.
FORECAST_TYPE = "historical_reference_speed"
METRICS_FILE = "reference_metrics.json"
INSUFFICIENT_DATA_MESSAGE = (
    "Current data is not sufficient to predict the traffic speed"
)


def to_utc(value: datetime) -> datetime:
    """Return ``value`` in UTC; naive timestamps are treated as UTC.

    This matches the ingestion pipeline, which stores offset-less CSV
    timestamps as UTC.
    """
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def align_to_sampling_grid(value: datetime) -> datetime:
    """Round a timestamp to the nearest five-minute observation slot (UTC)."""
    value = to_utc(value)
    interval = int(SAMPLING_INTERVAL.total_seconds() * 1_000_000)
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    elapsed = (value - epoch) // timedelta(microseconds=1)
    rounded = (elapsed + interval // 2) // interval * interval
    return epoch + timedelta(microseconds=rounded)


def previous_year(value: datetime) -> datetime:
    """Same calendar date and time one year earlier; Feb 29 maps to Feb 28.

    PostgreSQL's ``timestamptz - INTERVAL '1 year'`` (in a UTC session)
    applies the same rule, so training and prediction agree.
    """
    try:
        return value.replace(year=value.year - 1)
    except ValueError:
        return value.replace(year=value.year - 1, day=28)


def reference_timestamps(target: datetime) -> dict[str, datetime]:
    """Map each reference feature name to the timestamp it is read from."""
    target = to_utc(target)
    return {
        "previous_day_speed": target - timedelta(days=1),
        "previous_week_speed": target - timedelta(days=7),
        "previous_year_speed": previous_year(target),
    }


def valid_speed(value: object) -> float | None:
    """Return a usable speed, or ``None`` for missing/invalid readings.

    Invalid readings are stored as NaN by the pipeline; speeds above 200 are
    kept but flagged there, and are excluded here as in model training.
    """
    if value is None:
        return None
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(speed) or not 0 <= speed <= MAX_VALID_SPEED:
        return None
    return speed
