"""Traffic anomaly detection utilities.

This module provides a lightweight, explainable anomaly detection based on
historical speed observations using median and median absolute deviation (MAD).

The logic is deliberately simple and self‑contained so that it can be used by
the prediction API without pulling in heavy scientific dependencies.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import List, Tuple, Any


@dataclass(frozen=True)
class AnomalyThresholds:
    """Configurable thresholds expressed as multiples of MAD.

    * ``low`` – deviation > low * MAD → LOW severity
    * ``medium`` – deviation > medium * MAD → MEDIUM severity
    * ``high`` – deviation > high * MAD → HIGH severity

    The default values were chosen empirically to give a sensible spread for
    typical traffic speed variation.
    """

    low: float = 1.5
    medium: float = 3.0
    high: float = 5.0


# A single immutable instance used by the detection code.  Keeping it in the
# module makes it easy to adjust via import if needed.
DEFAULT_THRESHOLDS = AnomalyThresholds()


def _median_absolute_deviation(values: List[float], median: float) -> float:
    """Return the median absolute deviation for *values*.

    ``values`` must contain at least one element; callers guarantee this.
    """
    deviations = [abs(v - median) for v in values]
    return statistics.median(deviations)


def detect_anomaly(
    historical_speeds: List[Any],
    current_speed: Any,
    thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
) -> Tuple[bool, str, str, str]:
    """Detect an anomaly for a single prediction.

    Parameters
    ----------
    historical_speeds:
        A list of past speed observations (numeric). ``None`` or non‑numeric
        entries are ignored.
    current_speed:
        The speed we are evaluating – typically the model's predicted speed.
    thresholds:
        Multiples of MAD used to classify severity.

    Returns
    -------
    detected: bool
        ``True`` when an anomaly is identified.
    severity: str
        One of ``"LOW"``, ``"MEDIUM"``, ``"HIGH"`` or ``""`` when not detected.
    anomaly_type: str
        ``"speed_drop"``, ``"speed_spike"`` or ``""`` when not detected.
    explanation: str
        Human‑readable description of why the decision was made.
    """
    # Filter out invalid values.
    valid_hist = [float(v) for v in historical_speeds if isinstance(v, (int, float)) and math.isfinite(v)]
    if not valid_hist:
        return False, "", "", "Insufficient historical data for anomaly detection."

    # Median and MAD of the historical set.
    median = statistics.median(valid_hist)
    mad = _median_absolute_deviation(valid_hist, median)
    # Guard against zero or near-zero MAD: use a minimum floor (1.0 mph)
    # to prevent tiny speed differences from producing false HIGH severity anomalies.
    effective_mad = max(mad, 1.0)

    # Validate current speed.
    try:
        cur = float(current_speed)
        if not math.isfinite(cur):
            raise ValueError
    except Exception:
        return False, "", "", "Current speed is missing or invalid, cannot evaluate anomaly."

    deviation = abs(cur - median)
    ratio = deviation / effective_mad

    if ratio > thresholds.high:
        severity = "HIGH"
    elif ratio > thresholds.medium:
        severity = "MEDIUM"
    elif ratio > thresholds.low:
        severity = "LOW"
    else:
        return False, "", "", "Speed within normal variation."

    anomaly_type = "speed_drop" if cur < median else "speed_spike"
    explanation = (
        f"Current speed {cur:.1f} mph deviates from historical median {median:.1f} mph "
        f"by {deviation:.1f} mph ({ratio:.2f}× MAD)."
    )
    return True, severity, anomaly_type, explanation
