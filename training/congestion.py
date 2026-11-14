"""Traffic congestion classification based on predicted vehicle speeds.

Categorizes traffic speeds into standardized congestion levels:
- FREE FLOW (> 50 mph)
- MODERATE TRAFFIC (25 - 50 mph)
- HEAVY CONGESTION (< 25 mph)
- INSUFFICIENT DATA (missing, NaN, infinite, or invalid values)

Note: Congestion categories are model-derived classifications based on
predicted speed thresholds and do not represent an official road authority condition.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


class CongestionCategory:
    """Standard congestion category labels."""

    FREE_FLOW = "FREE FLOW"
    MODERATE_TRAFFIC = "MODERATE TRAFFIC"
    HEAVY_CONGESTION = "HEAVY CONGESTION"
    INSUFFICIENT_DATA = "INSUFFICIENT DATA"


@dataclass(frozen=True)
class CongestionThresholds:
    """Configurable speed thresholds in miles per hour (mph).

    Boundary rules:
    - Speed > free_flow_min: FREE FLOW
    - Speed >= moderate_min and <= free_flow_min: MODERATE TRAFFIC
    - Speed < moderate_min: HEAVY CONGESTION
    """

    free_flow_min: float = 50.0
    moderate_min: float = 25.0


DEFAULT_THRESHOLDS = CongestionThresholds()

EXPLANATION = (
    "Congestion classifications are derived from model-predicted vehicle speeds "
    "(>50 mph: Free Flow, 25-50 mph: Moderate Traffic, <25 mph: Heavy Congestion) "
    "and do not constitute an official road authority traffic condition report."
)


def classify_speed(
    speed: Any,
    thresholds: CongestionThresholds = DEFAULT_THRESHOLDS,
) -> str:
    """Classify a vehicle speed (in mph) into a congestion category.

    Exact boundary rules:
    - Speed > 50: FREE FLOW
    - Speed >= 25 and <= 50: MODERATE TRAFFIC
    - Speed < 25: HEAVY CONGESTION
    - None, NaN, +/-inf, or non-numeric: INSUFFICIENT DATA
    """
    if speed is None:
        return CongestionCategory.INSUFFICIENT_DATA

    try:
        val = float(speed)
    except (TypeError, ValueError):
        return CongestionCategory.INSUFFICIENT_DATA

    if math.isnan(val) or math.isinf(val):
        return CongestionCategory.INSUFFICIENT_DATA

    if val > thresholds.free_flow_min:
        return CongestionCategory.FREE_FLOW
    if val >= thresholds.moderate_min:
        return CongestionCategory.MODERATE_TRAFFIC
    return CongestionCategory.HEAVY_CONGESTION
