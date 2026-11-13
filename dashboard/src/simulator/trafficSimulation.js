/**
 * Traffic Simulation Engine & Vehicle Physics for 3D Highway Simulator.
 * Models vehicle kinematics, lane assignments, car-following heuristics,
 * and Greenshields traffic density response to ML speed predictions.
 */

import * as THREE from "three";

export const VEHICLE_TYPES = [
  { type: "sedan", length: 4.2, width: 1.8, height: 1.4, weight: 0.65 },
  { type: "suv", length: 4.8, width: 2.0, height: 1.7, weight: 0.25 },
  { type: "truck", length: 9.5, width: 2.4, height: 3.2, weight: 0.10 },
];

export const VEHICLE_PALETTES = [
  "#e2e8f0", // pearl white
  "#1e293b", // onyx black
  "#3b82f6", // sapphire blue
  "#ef4444", // radiant red
  "#64748b", // slate silver
  "#f59e0b", // amber gold
  "#0ea5e9", // cyan
];

export class VehicleAgent {
  constructor(id, laneIndex, startProgress, vehicleType, color, baseSpeedMph) {
    this.id = id;
    this.laneIndex = laneIndex;
    this.progress = startProgress; // 0.0 to 1.0 along the highway corridor
    this.type = vehicleType;
    this.color = color;
    this.baseSpeedMph = baseSpeedMph;
    this.currentSpeedMph = baseSpeedMph;
    this.targetSpeedMph = baseSpeedMph;
    this.speedVariance = (Math.random() - 0.5) * 6.0; // +/- 3 mph driver variation
    this.mesh = null;
    this.brakeMesh = null;
    this.headlightMesh = null;
    this.isBraking = false;
  }

  update(deltaTimeSeconds, simSpeedMultiplier, corridorLengthMeters, leaderVehicle) {
    // Car-following model: if close to leader in same lane, decelerate to leader speed
    let safeSpeedMph = this.targetSpeedMph + this.speedVariance;
    this.isBraking = false;

    if (leaderVehicle && leaderVehicle.laneIndex === this.laneIndex) {
      // Calculate distance to leader in meters
      let distMeters = (leaderVehicle.progress - this.progress) * corridorLengthMeters;
      if (distMeters < 0) {
        // leader wrapped around
        distMeters += corridorLengthMeters;
      }

      const safeDistance = Math.max(12.0, (this.currentSpeedMph * 0.44704) * 1.5); // 1.5 sec headway
      if (distMeters < safeDistance) {
        // Match or brake below leader speed
        safeSpeedMph = Math.min(safeSpeedMph, leaderVehicle.currentSpeedMph * 0.95);
        this.isBraking = true;
      }
    }

    // Smooth acceleration / deceleration towards safeSpeed
    const accelRate = this.isBraking ? 18.0 : 8.0; // mph per second
    if (this.currentSpeedMph < safeSpeedMph) {
      this.currentSpeedMph = Math.min(safeSpeedMph, this.currentSpeedMph + accelRate * deltaTimeSeconds);
    } else if (this.currentSpeedMph > safeSpeedMph) {
      this.currentSpeedMph = Math.max(safeSpeedMph, this.currentSpeedMph - accelRate * deltaTimeSeconds);
    }

    // Convert mph to meters per second: 1 mph = 0.44704 m/s
    const speedMps = Math.max(2.0, this.currentSpeedMph) * 0.44704;
    const distanceTraveled = speedMps * deltaTimeSeconds * simSpeedMultiplier;

    // Update progression along highway
    this.progress += distanceTraveled / corridorLengthMeters;
    if (this.progress > 1.0) {
      this.progress -= 1.0;
    }

    // Update brake light visual
    if (this.brakeMesh) {
      this.brakeMesh.material.emissiveIntensity = this.isBraking ? 1.5 : 0.2;
    }
  }
}

/**
 * Procedural 3D Mesh generator for vehicles without external asset dependencies.
 */
export function createVehicleMesh(vehicleType, colorHex) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    metalness: 0.7,
    roughness: 0.25,
  });

  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.9,
    roughness: 0.1,
  });

  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x111827,
    roughness: 0.8,
  });

  const lightWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lightRedMat = new THREE.MeshStandardMaterial({
    color: 0xff0000,
    emissive: 0xef4444,
    emissiveIntensity: 0.2,
  });

  if (vehicleType.type === "truck") {
    // Semi-truck cab & container
    const cabGeom = new THREE.BoxGeometry(2.4, 2.8, 3.2);
    const cab = new THREE.Mesh(cabGeom, bodyMat);
    cab.position.set(0, 1.6, 2.5);
    cab.castShadow = true;
    group.add(cab);

    const cargoGeom = new THREE.BoxGeometry(2.5, 3.2, 6.0);
    const cargoMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.6 });
    const cargo = new THREE.Mesh(cargoGeom, cargoMat);
    cargo.position.set(0, 2.0, -1.8);
    cargo.castShadow = true;
    group.add(cargo);
  } else if (vehicleType.type === "suv") {
    // SUV chassis
    const bodyGeom = new THREE.BoxGeometry(2.0, 1.1, 4.6);
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(0, 0.8, 0);
    body.castShadow = true;
    group.add(body);

    const cabinGeom = new THREE.BoxGeometry(1.8, 0.8, 2.8);
    const cabin = new THREE.Mesh(cabinGeom, glassMat);
    cabin.position.set(0, 1.5, -0.2);
    cabin.castShadow = true;
    group.add(cabin);
  } else {
    // Sedan chassis
    const bodyGeom = new THREE.BoxGeometry(1.8, 0.8, 4.2);
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(0, 0.6, 0);
    body.castShadow = true;
    group.add(body);

    const cabinGeom = new THREE.BoxGeometry(1.6, 0.7, 2.2);
    const cabin = new THREE.Mesh(cabinGeom, glassMat);
    cabin.position.set(0, 1.2, -0.3);
    cabin.castShadow = true;
    group.add(cabin);
  }

  // Wheels (4 cylinders)
  const wheelGeom = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 16);
  wheelGeom.rotateZ(Math.PI / 2);
  const zOffset = vehicleType.length * 0.3;
  const xOffset = vehicleType.width * 0.48;

  const wPositions = [
    [-xOffset, 0.38, zOffset],
    [xOffset, 0.38, zOffset],
    [-xOffset, 0.38, -zOffset],
    [xOffset, 0.38, -zOffset],
  ];

  for (const pos of wPositions) {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.position.set(pos[0], pos[1], pos[2]);
    wheel.castShadow = true;
    group.add(wheel);
  }

  // Headlights
  const hlGeom = new THREE.BoxGeometry(0.25, 0.15, 0.1);
  const hlLeft = new THREE.Mesh(hlGeom, lightWhiteMat);
  hlLeft.position.set(-vehicleType.width * 0.35, 0.6, vehicleType.length * 0.5);
  const hlRight = new THREE.Mesh(hlGeom, lightWhiteMat);
  hlRight.position.set(vehicleType.width * 0.35, 0.6, vehicleType.length * 0.5);
  group.add(hlLeft);
  group.add(hlRight);

  // Brake lights
  const brakeGeom = new THREE.BoxGeometry(0.3, 0.15, 0.1);
  const brakeLeft = new THREE.Mesh(brakeGeom, lightRedMat);
  brakeLeft.position.set(-vehicleType.width * 0.35, 0.6, -vehicleType.length * 0.5);
  const brakeRight = new THREE.Mesh(brakeGeom, lightRedMat);
  brakeRight.position.set(vehicleType.width * 0.35, 0.6, -vehicleType.length * 0.5);
  group.add(brakeLeft);
  group.add(brakeRight);

  return { group, brakeLeft, brakeRight };
}
