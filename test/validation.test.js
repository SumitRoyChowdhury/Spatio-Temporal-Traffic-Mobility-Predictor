import test from "node:test";
import assert from "node:assert/strict";
import {
  isIrregularTimestamp,
  normalizeSpeed,
  parseTimestamp,
  sameObservation,
} from "../src/validation.js";

test("timestamp parsing rejects missing and invalid timestamps", () => {
  assert.equal(parseTimestamp("").reason, "missing_timestamp");
  assert.equal(parseTimestamp("2017-02-29 12:00:00").reason, "invalid_timestamp");
  assert.equal(
    parseTimestamp("2017-01-01 00:00:00").timestamp.toISOString(),
    "2017-01-01T00:00:00.000Z",
  );
  assert.equal(
    parseTimestamp("2017-01-01T01:00:00+01:00").timestamp.toISOString(),
    "2017-01-01T00:00:00.000Z",
  );
});

test("speed normalization applies missing, non-numeric, negative, infinite, and high-speed rules", () => {
  assert.ok(Number.isNaN(normalizeSpeed("").speed));
  assert.deepEqual(normalizeSpeed("").flags, ["missing_speed"]);
  assert.deepEqual(normalizeSpeed("fast").flags, ["non_numeric_speed"]);
  assert.deepEqual(normalizeSpeed("-1").flags, ["negative_speed"]);
  assert.deepEqual(normalizeSpeed("Infinity").flags, ["infinite_speed"]);
  assert.equal(normalizeSpeed("201").speed, 201);
  assert.deepEqual(normalizeSpeed("201").flags, ["excessive_speed"]);
  assert.deepEqual(normalizeSpeed("200").flags, []);
});

test("irregular sampling interval is flagged; repeated timestamp is left to deduplication", () => {
  const first = Date.parse("2017-01-01T00:00:00Z");
  assert.equal(isIrregularTimestamp(undefined, first), false);
  assert.equal(isIrregularTimestamp(first, first + 5 * 60 * 1000), false);
  assert.equal(isIrregularTimestamp(first, first + 10 * 60 * 1000), true);
  assert.equal(isIrregularTimestamp(first, first), false);
});

test("observation equality treats NaN as the same normalized value", () => {
  assert.equal(
    sameObservation({ speed: Number.NaN, flags: ["missing_speed"] }, { speed: Number.NaN, flags: ["missing_speed"] }),
    true,
  );
});
