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


@dataclass(frozen=True)
class CongestionRatioThresholds:
    """Configurable congestion ratio (Speed / Free-Flow Speed) thresholds.

    Boundary rules:
    - Ratio >= free_flow_ratio (0.70): FREE FLOW
    - Ratio >= moderate_ratio (0.40) and < free_flow_ratio: MODERATE TRAFFIC
    - Ratio < moderate_ratio: HEAVY CONGESTION
    """

    free_flow_ratio: float = 0.70
    moderate_ratio: float = 0.40


ROAD_TYPE_FREE_FLOW_SPEEDS = {
    "Freeway": 65.0,
    "Highway": 55.0,
    "Arterial": 45.0,
    "Urban": 35.0,
}

DEFAULT_THRESHOLDS = CongestionThresholds()
DEFAULT_RATIO_THRESHOLDS = CongestionRatioThresholds()

EXPLANATION = (
    "Congestion classifications are derived from vehicle speeds relative to reference free-flow speeds "
    "(Ratio >= 0.70: Free Flow, 0.40 - 0.70: Moderate Traffic, < 0.40: Heavy Congestion) "
    "and do not constitute an official road authority traffic condition report."
)


def classify_congestion_ratio(
    speed: Any,
    free_flow_speed: float | None = None,
    road_category: str | None = "Freeway",
    ratio_thresholds: CongestionRatioThresholds = DEFAULT_RATIO_THRESHOLDS,
) -> tuple[str, float | None, float]:
    """Classify traffic congestion based on the Congestion Ratio S / F.

    Let:
      Current Speed = S
      Reference Free-Flow Speed = F
      Congestion Ratio = S / F

    Returns:
      (category, ratio, reference_free_flow_speed)
    """
    ref_f = free_flow_speed if (free_flow_speed is not None and free_flow_speed > 0) else ROAD_TYPE_FREE_FLOW_SPEEDS.get(road_category or "Freeway", 65.0)

    if speed is None:
        return CongestionCategory.INSUFFICIENT_DATA, None, ref_f

    try:
        val = float(speed)
    except (TypeError, ValueError):
        return CongestionCategory.INSUFFICIENT_DATA, None, ref_f

    if math.isnan(val) or math.isinf(val) or val < 0:
        return CongestionCategory.INSUFFICIENT_DATA, None, ref_f

    ratio = val / ref_f
    if ratio >= ratio_thresholds.free_flow_ratio:
        cat = CongestionCategory.FREE_FLOW
    elif ratio >= ratio_thresholds.moderate_ratio:
        cat = CongestionCategory.MODERATE_TRAFFIC
    else:
        cat = CongestionCategory.HEAVY_CONGESTION

    return cat, round(ratio, 3), ref_f


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
