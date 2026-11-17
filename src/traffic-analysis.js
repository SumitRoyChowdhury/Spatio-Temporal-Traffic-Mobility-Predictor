import {
  classifyCongestion,
  detectAnomalies,
} from "traffic-flow-toolkit-atharva";

/**
 * Enrich traffic observations using the published npm toolkit.
 * Results are stored in the existing Prisma JSON flags field.
 */
export function enrichTrafficObservations(observations) {
  const bySensor = new Map();

  observations.forEach((record, index) => {
    const key = record.sensorId.toString();

    if (!bySensor.has(key)) {
      bySensor.set(key, []);
    }

    bySensor.get(key).push(index);
  });

  const enriched = observations.map((record) => ({
    ...record,
    flags: [...record.flags],
  }));

  for (const indexes of bySensor.values()) {
    const speeds = indexes.map((index) => enriched[index].speed);

    const analysis = detectAnomalies(speeds);

    indexes.forEach((recordIndex, position) => {
      const record = enriched[recordIndex];

      const congestion = classifyCongestion(record.speed);

      record.flags.push(`congestion:${congestion}`);

      const anomaly = analysis.anomalies.find(
        (item) => item.index === position,
      );

      if (anomaly) {
        record.flags.push("anomaly_mad");
      }
    });
  }

  return enriched;
}
