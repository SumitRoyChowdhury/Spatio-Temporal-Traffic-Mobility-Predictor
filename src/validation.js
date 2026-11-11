const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/i;

export function parseTimestamp(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { timestamp: null, reason: "missing_timestamp" };

  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return { timestamp: null, reason: "invalid_timestamp" };

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year === 0 ||
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { timestamp: null, reason: "invalid_timestamp" };
  }

  const isoInput = value.replace(" ", "T");
  const milliseconds = Date.parse(match[8] ? isoInput : `${isoInput}Z`);
  if (!Number.isFinite(milliseconds)) {
    return { timestamp: null, reason: "invalid_timestamp" };
  }
  return { timestamp: new Date(milliseconds), reason: null };
}

export function normalizeSpeed(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { speed: Number.NaN, flags: ["missing_speed"] };

  const speed = Number(value);
  if (Number.isNaN(speed)) {
    return { speed: Number.NaN, flags: ["non_numeric_speed"] };
  }
  if (!Number.isFinite(speed)) {
    return { speed: Number.NaN, flags: ["infinite_speed"] };
  }
  if (speed < 0) {
    return { speed: Number.NaN, flags: ["negative_speed"] };
  }
  if (speed > 200) return { speed, flags: ["excessive_speed"] };
  return { speed, flags: [] };
}

export function isIrregularTimestamp(previousMilliseconds, currentMilliseconds) {
  return (
    previousMilliseconds !== undefined &&
    previousMilliseconds !== currentMilliseconds &&
    currentMilliseconds - previousMilliseconds !== 5 * 60 * 1000
  );
}

export function sameObservation(left, right) {
  return (
    Object.is(left.speed, right.speed) &&
    JSON.stringify(left.flags) === JSON.stringify(right.flags)
  );
}
