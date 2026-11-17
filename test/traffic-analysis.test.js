import test from "node:test";
import assert from "node:assert/strict";

import { enrichTrafficObservations } from "../src/traffic-analysis.js";

test("classifies traffic congestion using the published toolkit", () => {
  const records = [
    { sensorId: 1n, speed: 60, flags: [] },
    { sensorId: 1n, speed: 30, flags: [] },
    { sensorId: 1n, speed: 15, flags: [] },
    { sensorId: 1n, speed: 5, flags: [] },
  ];

  const result = enrichTrafficObservations(records);

  assert.deepEqual(
    result.map((record) => record.flags[0]),
    [
      "congestion:free-flow",
      "congestion:moderate",
      "congestion:heavy",
      "congestion:severe",
    ],
  );
});

test("detects an unusual traffic speed using MAD", () => {
  const records = [
    50, 51, 49, 50, 52, 48, 51, 50, 49, 100,
  ].map((speed) => ({
    sensorId: 1n,
    speed,
    flags: [],
  }));

  const result = enrichTrafficObservations(records);

  assert.ok(result[9].flags.includes("anomaly_mad"));
});

test("does not mix observations from different sensors", () => {
  const records = [
    { sensorId: 1n, speed: 50, flags: [] },
    { sensorId: 2n, speed: 5, flags: [] },
  ];

  const result = enrichTrafficObservations(records);

  assert.ok(result[0].flags.includes("congestion:free-flow"));
  assert.ok(result[1].flags.includes("congestion:severe"));
});

test("preserves existing flags and original observations", () => {
  const records = [
    { sensorId: 1n, speed: 50, flags: ["irregular_timestamp"] },
  ];

  const result = enrichTrafficObservations(records);

  assert.ok(result[0].flags.includes("irregular_timestamp"));
  assert.ok(result[0].flags.includes("congestion:free-flow"));
  assert.deepEqual(records[0].flags, ["irregular_timestamp"]);
});
