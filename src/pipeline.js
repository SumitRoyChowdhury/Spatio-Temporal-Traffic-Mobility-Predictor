import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "csv-parse";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  isIrregularTimestamp,
  normalizeSpeed,
  parseTimestamp,
  sameObservation,
} from "./validation.js";

const BATCH_SIZE = 5_000;
const EXISTING_QUERY_SIZE = 1_000;

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = encodeURIComponent(process.env.PGUSER ?? "sumitroychowdhury");
  const password = process.env.PGPASSWORD
    ? `:${encodeURIComponent(process.env.PGPASSWORD)}`
    : "";
  const port = Number(process.env.PGPORT ?? 5432);
  const database = encodeURIComponent(
    process.env.PGDATABASE ?? "gridlock_train_data",
  );
  const host = process.env.PGHOST ?? "/tmp";
  if (host.startsWith("/")) {
    return `postgresql://${user}${password}@localhost:${port}/${database}?host=${encodeURIComponent(host)}&schema=public`;
  }
  return `postgresql://${user}${password}@${host}:${port}/${database}?schema=public`;
}

function getOptions(args) {
  const options = {
    trainFile: resolve("train_data.csv"),
    metadataFile: resolve("PEMS-BAY-META.csv"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--train" && option !== "--metadata") {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a file path`);
    }
    options[option === "--train" ? "trainFile" : "metadataFile"] =
      resolve(value);
    index += 1;
  }
  return options;
}

function csvParser(filePath) {
  return createReadStream(filePath).pipe(
    parse({ bom: true, skip_empty_lines: true }),
  );
}

function quarantineEntry(sourceFile, sourceRow, sensorId, rawSensorId, rawTimestamp, rawSpeed, reason) {
  return {
    sourceFile,
    sourceRow: BigInt(sourceRow),
    sensorId: sensorId === null ? null : BigInt(sensorId),
    rawSensorId,
    rawTimestamp,
    rawSpeed,
    reason,
  };
}

async function loadSensors(prisma, metadataFile) {
  const parser = csvParser(metadataFile);
  let headers;
  let sourceRow = 0;
  const sensors = [];
  const sensorIds = new Set();

  for await (const row of parser) {
    sourceRow += 1;
    if (!headers) {
      headers = row;
      if (!headers.includes("sensor_id")) {
        throw new Error("Sensor metadata CSV must include a sensor_id column");
      }
      continue;
    }
    if (row.length !== headers.length) {
      throw new Error(`Malformed sensor metadata row ${sourceRow}`);
    }
    const metadata = Object.fromEntries(
      headers.map((header, index) => [header, row[index]]),
    );
    const id = metadata.sensor_id.trim();
    if (!/^\d+$/.test(id)) {
      throw new Error(`Invalid sensor_id in metadata row ${sourceRow}`);
    }
    if (sensorIds.has(id)) {
      throw new Error(`Duplicate sensor_id ${id} in metadata CSV`);
    }
    sensorIds.add(id);
    sensors.push({ sensorId: BigInt(id), metadata });
  }
  if (!headers) throw new Error(`Sensor metadata CSV is empty: ${metadataFile}`);
  if (sensors.length === 0) throw new Error("Sensor metadata CSV contains no sensors");

  for (let offset = 0; offset < sensors.length; offset += 500) {
    await prisma.sensor.createMany({
      data: sensors.slice(offset, offset + 500),
      skipDuplicates: true,
    });
  }
  return sensorIds;
}

async function findExistingObservations(prisma, records) {
  const existing = new Map();
  for (let offset = 0; offset < records.length; offset += EXISTING_QUERY_SIZE) {
    const chunk = records.slice(offset, offset + EXISTING_QUERY_SIZE);
    const sensorIds = [...new Set(chunk.map((record) => record.sensorId))];
    const timestamps = [
      ...new Map(
        chunk.map((record) => [record.observedAt.getTime(), record.observedAt]),
      ).values(),
    ];
    const rows = await prisma.observation.findMany({
      where: {
        sensorId: { in: sensorIds },
        observedAt: { in: timestamps },
      },
      select: {
        sensorId: true,
        observedAt: true,
        speed: true,
        flags: true,
      },
    });
    for (const row of rows) {
      existing.set(`${row.sensorId}:${row.observedAt.getTime()}`, row);
    }
  }
  return existing;
}

async function flushBatch(prisma, observations, quarantineRecords, totals) {
  const unique = new Map();
  const conflicted = new Set();
  const internalQuarantine = [];
  for (const record of observations) {
    const key = `${record.sensorId}:${record.observedAt.getTime()}`;
    if (conflicted.has(key)) {
      internalQuarantine.push(
        quarantineEntry(
          record.sourceFile,
          record.sourceRow,
          record.sensorId,
          String(record.sensorId),
          record.rawTimestamp,
          record.rawSpeed,
          "duplicate_conflict",
        ),
      );
      continue;
    }
    const prior = unique.get(key);
    if (!prior) {
      unique.set(key, record);
    } else if (sameObservation(prior, record)) {
      totals.deduplicated += 1;
    } else {
      unique.delete(key);
      conflicted.add(key);
      for (const conflicting of [prior, record]) {
        internalQuarantine.push(
          quarantineEntry(
            conflicting.sourceFile,
            conflicting.sourceRow,
            conflicting.sensorId,
            String(conflicting.sensorId),
            conflicting.rawTimestamp,
            conflicting.rawSpeed,
            "duplicate_conflict",
          ),
        );
      }
    }
  }

  const candidates = [...unique.values()];
  const existing = await findExistingObservations(prisma, candidates);
  const toInsert = [];
  const externalQuarantine = [];
  for (const record of candidates) {
    const key = `${record.sensorId}:${record.observedAt.getTime()}`;
    const prior = existing.get(key);
    if (!prior) {
      toInsert.push(record);
    } else if (sameObservation(prior, record)) {
      totals.deduplicated += 1;
    } else {
      externalQuarantine.push(
        quarantineEntry(
          record.sourceFile,
          record.sourceRow,
          record.sensorId,
          String(record.sensorId),
          record.rawTimestamp,
          record.rawSpeed,
          "duplicate_conflict",
        ),
      );
    }
  }

  await prisma.$transaction(async (transaction) => {
    const rejections = [...quarantineRecords, ...internalQuarantine, ...externalQuarantine];
    if (rejections.length > 0) {
      await transaction.quarantineRecord.createMany({ data: rejections });
    }
    if (toInsert.length > 0) {
      const result = await transaction.observation.createMany({
        data: toInsert.map(({ rawTimestamp, rawSpeed, ...record }) => record),
        skipDuplicates: true,
      });
      totals.inserted += result.count;
      totals.deduplicated += toInsert.length - result.count;
    }
  });
  totals.quarantined += quarantineRecords.length + internalQuarantine.length + externalQuarantine.length;
}

async function loadObservations(prisma, trainFile, knownSensorIds, totals) {
  const parser = csvParser(trainFile);
  const sourceFile = basename(trainFile);
  const lastTimestampBySensor = new Map();
  let headers;
  let sensorColumns;
  let sourceRow = 0;
  let observations = [];
  let quarantineRecords = [];

  const flush = async () => {
    await flushBatch(prisma, observations, quarantineRecords, totals);
    observations = [];
    quarantineRecords = [];
  };

  for await (const row of parser) {
    sourceRow += 1;
    if (!headers) {
      headers = row;
      if (headers.length < 2 || headers[0] !== "Unnamed: 0") {
        throw new Error("Training CSV must have a timestamp column named 'Unnamed: 0'");
      }
      sensorColumns = headers.slice(1).map((rawSensorId, index) => {
        const sensorId = rawSensorId.trim();
        return {
          rawSensorId,
          sensorId: /^\d+$/.test(sensorId) ? sensorId : null,
          known: /^\d+$/.test(sensorId) && knownSensorIds.has(sensorId),
          columnIndex: index + 1,
        };
      });
      continue;
    }
    if (row.length !== headers.length) {
      throw new Error(`Malformed training CSV row ${sourceRow}: expected ${headers.length} columns, received ${row.length}`);
    }

    const timestamp = parseTimestamp(row[0]);
    for (const sensor of sensorColumns) {
      const rawSpeed = row[sensor.columnIndex];
      if (timestamp.reason) {
        quarantineRecords.push(
          quarantineEntry(
            sourceFile,
            sourceRow,
            sensor.sensorId,
            sensor.rawSensorId,
            row[0],
            rawSpeed,
            timestamp.reason,
          ),
        );
      } else if (!sensor.known) {
        quarantineRecords.push(
          quarantineEntry(
            sourceFile,
            sourceRow,
            sensor.sensorId,
            sensor.rawSensorId,
            row[0],
            rawSpeed,
            "unknown_sensor",
          ),
        );
      } else {
        const value = normalizeSpeed(rawSpeed);
        const milliseconds = timestamp.timestamp.getTime();
        if (isIrregularTimestamp(lastTimestampBySensor.get(sensor.sensorId), milliseconds)) {
          value.flags.push("irregular_timestamp");
        }
        lastTimestampBySensor.set(sensor.sensorId, milliseconds);
        observations.push({
          sensorId: BigInt(sensor.sensorId),
          observedAt: timestamp.timestamp,
          speed: value.speed,
          flags: value.flags,
          sourceFile,
          sourceRow: BigInt(sourceRow),
          rawTimestamp: row[0],
          rawSpeed,
        });
      }

      if (
        observations.length >= BATCH_SIZE ||
        quarantineRecords.length >= BATCH_SIZE
      ) {
        await flush();
      }
    }
  }
  if (!headers) throw new Error(`Training CSV is empty: ${trainFile}`);
  await flush();
}

async function main() {
  const options = getOptions(process.argv.slice(2));
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      new Pool({
        connectionString: databaseUrl(),
        options: "-c timezone=UTC",
      }),
      { disposeExternalPool: true },
    ),
  });
  const totals = { inserted: 0, deduplicated: 0, quarantined: 0 };
  try {
    await prisma.$connect();
    const sensorIds = await loadSensors(prisma, options.metadataFile);
    await loadObservations(prisma, options.trainFile, sensorIds, totals);
    console.log(
      JSON.stringify(
        {
          status: "complete",
          sensorsInMetadata: sensorIds.size,
          observationsInserted: totals.inserted,
          duplicatesDeduplicated: totals.deduplicated,
          recordsQuarantined: totals.quarantined,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Pipeline failed:", error.message);
  process.exitCode = 1;
});
