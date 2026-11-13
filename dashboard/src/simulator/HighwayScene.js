/**
 * HighwayScene.js - Core Three.js & WebXR Engine for GridLock 3D Traffic Simulator.
 * Manages 3D scene graph, procedural highway geometry, dynamic vehicle animations,
 * interactive sensor beacons, WebXR VR controllers, and WebXR AR hit-test placement.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  VEHICLE_TYPES,
  VEHICLE_PALETTES,
  VehicleAgent,
  createVehicleMesh,
} from "./trafficSimulation.js";

export class HighwaySceneEngine {
  constructor(containerElement, options = {}) {
    this.container = containerElement;
    this.options = options;
    this.onSelectSensor = options.onSelectSensor || (() => {});
    this.onXRStateChange = options.onXRStateChange || (() => {});

    // State
    this.highwayData = null;
    this.selectedSensorId = null;
    this.simSpeedMultiplier = 1.0;
    this.isPaused = false;
    this.cameraMode = "aerial"; // aerial, driver, roadside, sensor
    this.activeVehicleId = null;

    // Three.js primitives
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.clock = new THREE.Clock();

    // Groups
    this.highwayGroup = new THREE.Group();
    this.sensorsGroup = new THREE.Group();
    this.vehiclesGroup = new THREE.Group();
    this.reticle = null;

    // WebXR
    this.xrSession = null;
    this.xrHitTestSource = null;
    this.xrHitTestSourceRequested = false;
    this.isAR = false;
    this.isVR = false;
    this.controllers = [];
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Simulation entities
    this.vehicles = [];
    this.sensorMeshes = [];
    this.corridorLengthMeters = 800.0;
    this.laneWidth = 3.8; // standard US highway lane width in meters
    this.totalLanes = 3;

    this.init();
  }

  init() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090d16);
    this.scene.fog = new THREE.FogExp2(0x090d16, 0.0018);

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    this.camera.position.set(0, 45, 110);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.xr.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    // OrbitControls for desktop navigation
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // prevent going underground
    this.controls.minDistance = 5;
    this.controls.maxDistance = 600;
    this.controls.target.set(0, 0, 0);

    // Lighting
    this.setupLighting();

    // Ground and Scene Groups
    this.setupGround();
    this.scene.add(this.highwayGroup);
    this.scene.add(this.sensorsGroup);
    this.scene.add(this.vehiclesGroup);

    // AR Placement Reticle
    this.setupReticle();

    // WebXR Controllers
    this.setupXRControllers();

    // Interaction Listeners
    this.bindEvents();

    // Start render loop
    this.renderer.setAnimationLoop(this.render.bind(this));
  }

  setupLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfffaed, 1.2);
    sun.position.set(60, 100, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 400;
    const d = 120;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    // Highway atmospheric fill
    const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x0f172a, 0.4);
    this.scene.add(hemiLight);
  }

  setupGround() {
    const groundGeom = new THREE.PlaneGeometry(1200, 1200);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.9,
      metalness: 0.1,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Grid helper for spatial depth
    const grid = new THREE.GridHelper(1000, 50, 0x1e293b, 0x0f172a);
    grid.position.y = -0.02;
    this.scene.add(grid);
  }

  setupReticle() {
    const ringGeom = new THREE.RingGeometry(0.35, 0.42, 32).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide });
    this.reticle = new THREE.Mesh(ringGeom, ringMat);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
  }

  setupXRControllers() {
    const controllerModelFactory = (index) => {
      const controller = this.renderer.xr.getController(index);

      // Laser pointer beam
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -10),
      ]);
      const material = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.7 });
      const line = new THREE.Line(geometry, material);
      line.name = "laser";
      controller.add(line);

      // Pointer tip
      const tipGeom = new THREE.SphereGeometry(0.04, 16, 16);
      const tipMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      const tip = new THREE.Mesh(tipGeom, tipMat);
      tip.position.z = -10;
      controller.add(tip);

      // Trigger selection
      controller.addEventListener("select", () => {
        this.handleXRControllerSelect(controller);
      });

      this.scene.add(controller);
      return controller;
    };

    this.controllers.push(controllerModelFactory(0));
    this.controllers.push(controllerModelFactory(1));
  }

  handleXRControllerSelect(controller) {
    if (this.isAR && this.reticle.visible) {
      // Place tabletop miniature highway at reticle location
      this.highwayGroup.position.setFromMatrixPosition(this.reticle.matrix);
      this.sensorsGroup.position.setFromMatrixPosition(this.reticle.matrix);
      this.vehiclesGroup.position.setFromMatrixPosition(this.reticle.matrix);

      // Scale to tabletop miniature size
      const scale = 0.04;
      this.highwayGroup.scale.set(scale, scale, scale);
      this.sensorsGroup.scale.set(scale, scale, scale);
      this.vehiclesGroup.scale.set(scale, scale, scale);
      return;
    }

    // Raycast in VR from controller laser
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const intersects = this.raycaster.intersectObjects(this.sensorMeshes, true);
    if (intersects.length > 0) {
      let obj = intersects[0].object;
      while (obj && !obj.userData?.sensorData && obj.parent) {
        obj = obj.parent;
      }
      if (obj?.userData?.sensorData) {
        this.selectSensor(obj.userData.sensorData.sensor_id);
      }
    }
  }

  bindEvents() {
    this.onWindowResize = () => {
      if (!this.container) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    };
    window.addEventListener("resize", this.onWindowResize);

    // Mouse click for desktop raycast sensor selection
    this.onPointerDown = (event) => {
      if (this.isVR || this.isAR) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.sensorMeshes, true);
      if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj && !obj.userData?.sensorData && obj.parent) {
          obj = obj.parent;
        }
        if (obj?.userData?.sensorData) {
          this.selectSensor(obj.userData.sensorData.sensor_id);
        }
      }
    };
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
  }

  /* ─── DATA INGESTION & SCENE GENERATION ─── */

  loadHighwayData(sceneData) {
    this.highwayData = sceneData;
    this.totalLanes = sceneData.sensors?.[0]?.lanes || 3;

    // Clear old highway meshes
    this.clearGroup(this.highwayGroup);
    this.clearGroup(this.sensorsGroup);
    this.clearGroup(this.vehiclesGroup);
    this.sensorMeshes = [];
    this.vehicles = [];

    const segments = sceneData.segments || [];
    const sensors = sceneData.sensors || [];

    // Scale world coordinate length: map segments to ~600-900m world units
    const totalPhysicalLengthM = segments.reduce((sum, s) => sum + s.length_m, 0) || 2000.0;
    this.corridorLengthMeters = Math.max(400.0, Math.min(1000.0, totalPhysicalLengthM * 0.4));

    // Construct 3D roadbed & lane dividers
    this.buildHighwayRoadbed(segments, sensors);

    // Construct sensor beacons & overhead gantries
    this.buildSensorStations(sensors);

    // Spawn dynamic vehicle agents
    this.spawnVehicles(segments);

    // Reset camera target to center of corridor
    this.setCameraPreset("aerial");
  }

  buildHighwayRoadbed(segments, sensors) {
    const roadWidth = this.totalLanes * this.laneWidth;
    const shoulderWidth = 2.5;
    const fullRoadWidth = roadWidth + shoulderWidth * 2;
    const roadLength = this.corridorLengthMeters;

    // Main asphalt road surface
    const roadGeom = new THREE.PlaneGeometry(fullRoadWidth, roadLength, 1, 32);
    const roadMat = new THREE.MeshStandardMaterial({
      color: 0x181f2a,
      roughness: 0.85,
      metalness: 0.15,
    });
    const road = new THREE.Mesh(roadGeom, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, 0);
    road.receiveShadow = true;
    this.highwayGroup.add(road);

    // Road shoulders (darker asphalt/aggregate)
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x111620, roughness: 0.95 });
    [-fullRoadWidth / 2 + shoulderWidth / 2, fullRoadWidth / 2 - shoulderWidth / 2].forEach((x) => {
      const shGeom = new THREE.PlaneGeometry(shoulderWidth, roadLength);
      const shMesh = new THREE.Mesh(shGeom, shoulderMat);
      shMesh.rotation.x = -Math.PI / 2;
      shMesh.position.set(x, 0.005, 0);
      shMesh.receiveShadow = true;
      this.highwayGroup.add(shMesh);
    });

    // Solid outer edge markings (yellow on left shoulder, white on right)
    const lineMatYellow = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    const lineMatWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const leftLineGeom = new THREE.PlaneGeometry(0.25, roadLength);
    const leftLine = new THREE.Mesh(leftLineGeom, lineMatYellow);
    leftLine.rotation.x = -Math.PI / 2;
    leftLine.position.set(-roadWidth / 2, 0.01, 0);
    this.highwayGroup.add(leftLine);

    const rightLineGeom = new THREE.PlaneGeometry(0.25, roadLength);
    const rightLine = new THREE.Mesh(rightLineGeom, lineMatWhite);
    rightLine.rotation.x = -Math.PI / 2;
    rightLine.position.set(roadWidth / 2, 0.01, 0);
    this.highwayGroup.add(rightLine);

    // White dashed lane divider markings
    for (let lane = 1; lane < this.totalLanes; lane++) {
      const laneX = -roadWidth / 2 + lane * this.laneWidth;
      const dashLength = 3.0;
      const gapLength = 9.0;
      const step = dashLength + gapLength;
      const numDashes = Math.floor(roadLength / step);

      for (let d = 0; d < numDashes; d++) {
        const dashGeom = new THREE.PlaneGeometry(0.18, dashLength);
        const dashMesh = new THREE.Mesh(dashGeom, lineMatWhite);
        dashMesh.rotation.x = -Math.PI / 2;
        const dashZ = -roadLength / 2 + d * step + dashLength / 2;
        dashMesh.position.set(laneX, 0.01, dashZ);
        this.highwayGroup.add(dashMesh);
      }
    }

    // Metallic guardrails on borders
    const railMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.3 });
    [-fullRoadWidth / 2 - 0.2, fullRoadWidth / 2 + 0.2].forEach((x) => {
      const railGeom = new THREE.BoxGeometry(0.15, 0.5, roadLength);
      const rail = new THREE.Mesh(railGeom, railMat);
      rail.position.set(x, 0.65, 0);
      rail.castShadow = true;
      this.highwayGroup.add(rail);

      // Support posts every 15 meters
      for (let z = -roadLength / 2; z <= roadLength / 2; z += 15) {
        const postGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.8, 8);
        const post = new THREE.Mesh(postGeom, railMat);
        post.position.set(x, 0.4, z);
        post.castShadow = true;
        this.highwayGroup.add(post);
      }
    });

    // Segment Heatmap Color Glow Ribbons along road borders
    let currentZ = -roadLength / 2;
    segments.forEach((seg, i) => {
      const segLength = (seg.length_m / (this.highwayData.total_length_km * 1000 || 1)) * roadLength;
      const ribbonMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(seg.color || "#10b981"),
        transparent: true,
        opacity: 0.75,
      });

      // Left and right glow ribbons
      [-fullRoadWidth / 2 - 0.4, fullRoadWidth / 2 + 0.4].forEach((rx) => {
        const ribbonGeom = new THREE.BoxGeometry(0.35, 0.2, segLength);
        const ribbon = new THREE.Mesh(ribbonGeom, ribbonMat);
        ribbon.position.set(rx, 0.15, currentZ + segLength / 2);
        this.highwayGroup.add(ribbon);
      });

      currentZ += segLength;
    });
  }

  buildSensorStations(sensors) {
    if (!sensors || sensors.length === 0) return;
    const roadWidth = this.totalLanes * this.laneWidth;
    const roadLength = this.corridorLengthMeters;
    const stepZ = roadLength / (sensors.length || 1);

    sensors.forEach((s, i) => {
      const zPos = -roadLength / 2 + i * stepZ + stepZ * 0.5;
      const sensorStation = new THREE.Group();
      sensorStation.position.set(0, 0, zPos);
      sensorStation.userData = { sensorData: s };

      const statusColor = new THREE.Color(s.color || "#10b981");

      // Overhead Gantry Truss spanning the entire freeway
      const gantryMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.4 });
      const towerHeight = 7.5;
      const spanWidth = roadWidth + 8.0;

      // Left & right support towers
      [-spanWidth / 2, spanWidth / 2].forEach((tx) => {
        const towerGeom = new THREE.CylinderGeometry(0.3, 0.35, towerHeight, 12);
        const tower = new THREE.Mesh(towerGeom, gantryMat);
        tower.position.set(tx, towerHeight / 2, 0);
        tower.castShadow = true;
        sensorStation.add(tower);
      });

      // Horizontal cross beam
      const beamGeom = new THREE.BoxGeometry(spanWidth, 0.6, 0.6);
      const beam = new THREE.Mesh(beamGeom, gantryMat);
      beam.position.set(0, towerHeight, 0);
      beam.castShadow = true;
      sensorStation.add(beam);

      // Overhead Electronic Signboard
      const signGeom = new THREE.BoxGeometry(10.0, 2.2, 0.3);
      const signMat = new THREE.MeshStandardMaterial({ color: 0x020617, roughness: 0.5 });
      const sign = new THREE.Mesh(signGeom, signMat);
      sign.position.set(0, towerHeight + 0.3, 0.2);
      sensorStation.add(sign);

      // Congestion Beacon light on top of sign
      const beaconGeom = new THREE.SphereGeometry(0.5, 16, 16);
      const beaconMat = new THREE.MeshStandardMaterial({
        color: statusColor,
        emissive: statusColor,
        emissiveIntensity: 1.2,
      });
      const beacon = new THREE.Mesh(beaconGeom, beaconMat);
      beacon.position.set(0, towerHeight + 2.0, 0);
      sensorStation.add(beacon);

      // Vertical holographic light pillar to ground
      const pillarGeom = new THREE.CylinderGeometry(0.12, 0.12, towerHeight + 2, 12);
      const pillarMat = new THREE.MeshBasicMaterial({
        color: statusColor,
        transparent: true,
        opacity: 0.35,
      });
      const pillar = new THREE.Mesh(pillarGeom, pillarMat);
      pillar.position.set(spanWidth / 2, (towerHeight + 2) / 2, 0);
      sensorStation.add(pillar);

      // Sensor pod clickable trigger box
      const clickGeom = new THREE.BoxGeometry(spanWidth + 2, towerHeight + 4, 4.0);
      const clickMat = new THREE.MeshBasicMaterial({ visible: false });
      const clickBox = new THREE.Mesh(clickGeom, clickMat);
      clickBox.position.set(0, towerHeight / 2, 0);
      clickBox.userData = { sensorData: s };
      sensorStation.add(clickBox);

      this.sensorsGroup.add(sensorStation);
      this.sensorMeshes.push(clickBox);
    });
  }

  spawnVehicles(segments) {
    this.vehicles = [];
    const roadWidth = this.totalLanes * this.laneWidth;
    let vehicleId = 0;

    // Distribute vehicles evenly across segments according to recommended traffic density
    segments.forEach((seg, sIdx) => {
      const segRatio = (seg.speed_mph || 60.0) / 65.0;
      const count = seg.target_vehicle_count || 6;
      const segStartProg = sIdx / segments.length;
      const segEndProg = (sIdx + 1) / segments.length;

      for (let i = 0; i < count; i++) {
        const lane = Math.floor(Math.random() * this.totalLanes);
        const startProg = segStartProg + (i / count) * (segEndProg - segStartProg);

        // Pick vehicle type based on realistic traffic distribution
        const rand = Math.random();
        const type = rand < 0.65 ? VEHICLE_TYPES[0] : rand < 0.9 ? VEHICLE_TYPES[1] : VEHICLE_TYPES[2];
        const color = VEHICLE_PALETTES[Math.floor(Math.random() * VEHICLE_PALETTES.length)];

        const agent = new VehicleAgent(
          ++vehicleId,
          lane,
          startProg,
          type,
          color,
          seg.speed_mph || 60.0
        );

        const meshData = createVehicleMesh(type, color);
        agent.mesh = meshData.group;
        agent.brakeMesh = meshData.brakeLeft;

        this.vehiclesGroup.add(agent.mesh);
        this.vehicles.push(agent);
      }
    });

    if (this.vehicles.length > 0) {
      this.activeVehicleId = this.vehicles[0].id;
    }
  }

  selectSensor(sensorId) {
    this.selectedSensorId = sensorId;
    const sensor = this.highwayData?.sensors?.find((s) => s.sensor_id === sensorId);
    if (sensor) {
      this.onSelectSensor(sensor);
      if (this.cameraMode === "sensor") {
        this.focusOnSensor(sensorId);
      }
    }
  }

  focusOnSensor(sensorId) {
    const sensorIdx = this.highwayData?.sensors?.findIndex((s) => s.sensor_id === sensorId);
    if (sensorIdx == null || sensorIdx < 0) return;

    const roadLength = this.corridorLengthMeters;
    const sensorsCount = this.highwayData.sensors.length;
    const stepZ = roadLength / (sensorsCount || 1);
    const zPos = -roadLength / 2 + sensorIdx * stepZ + stepZ * 0.5;

    // Smoothly set controls target
    this.controls.target.set(0, 4, zPos);
    this.camera.position.set(22, 14, zPos + 25);
  }

  setCameraPreset(mode) {
    this.cameraMode = mode;
    const roadLength = this.corridorLengthMeters;

    if (mode === "aerial") {
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0, 95, 160);
    } else if (mode === "driver") {
      // Driver dashcam view behind active vehicle
      const v = this.vehicles.find((veh) => veh.id === this.activeVehicleId) || this.vehicles[0];
      if (v?.mesh) {
        this.controls.target.copy(v.mesh.position).add(new THREE.Vector3(0, 1.4, -15));
        this.camera.position.copy(v.mesh.position).add(new THREE.Vector3(0, 2.5, 6.0));
      }
    } else if (mode === "roadside") {
      // Stationary highway tower perspective
      this.controls.target.set(0, 2, 0);
      this.camera.position.set(-28, 12, 40);
    } else if (mode === "sensor") {
      if (this.selectedSensorId) {
        this.focusOnSensor(this.selectedSensorId);
      } else if (this.highwayData?.sensors?.[0]) {
        this.selectSensor(this.highwayData.sensors[0].sensor_id);
      }
    }
  }

  setSimSpeed(multiplier) {
    this.simSpeedMultiplier = Math.max(0.1, Math.min(10.0, multiplier));
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    return this.isPaused;
  }

  /* ─── WEBXR VR & AR LIFECYCLE ─── */

  async enterVR() {
    if (!navigator.xr) throw new Error("WebXR not supported");
    const session = await navigator.xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
    });
    this.isVR = true;
    this.isAR = false;
    this.xrSession = session;
    await this.renderer.xr.setSession(session);
    this.onXRStateChange({ active: true, mode: "immersive-vr" });

    session.addEventListener("end", () => {
      this.isVR = false;
      this.xrSession = null;
      this.onXRStateChange({ active: false, mode: null });
    });
  }

  async enterAR() {
    if (!navigator.xr) throw new Error("WebXR not supported");
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["local-floor", "dom-overlay"],
    });
    this.isAR = true;
    this.isVR = false;
    this.xrSession = session;
    this.xrHitTestSourceRequested = false;
    this.xrHitTestSource = null;

    await this.renderer.xr.setSession(session);
    this.onXRStateChange({ active: true, mode: "immersive-ar" });

    session.addEventListener("end", () => {
      this.isAR = false;
      this.xrSession = null;
      this.xrHitTestSource = null;
      this.reticle.visible = false;
      this.onXRStateChange({ active: false, mode: null });
    });
  }

  /* ─── RENDER & ANIMATION LOOP ─── */

  render(timestamp, frame) {
    const delta = Math.min(this.clock.getDelta(), 0.1);

    // WebXR AR Hit-Testing
    if (this.isAR && frame) {
      const referenceSpace = this.renderer.xr.getReferenceSpace();
      const session = this.renderer.xr.getSession();

      if (!this.xrHitTestSourceRequested && session) {
        session.requestReferenceSpace("viewer").then((viewerSpace) => {
          session.requestHitTestSource({ space: viewerSpace }).then((source) => {
            this.xrHitTestSource = source;
          });
        });
        session.addEventListener("end", () => {
          this.xrHitTestSourceRequested = false;
          this.xrHitTestSource = null;
        });
        this.xrHitTestSourceRequested = true;
      }

      if (this.xrHitTestSource) {
        const hitTestResults = frame.getHitTestResults(this.xrHitTestSource);
        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0];
          this.reticle.visible = true;
          this.reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);
        } else {
          this.reticle.visible = false;
        }
      }
    }

    // Vehicle Physics & Animation
    if (!this.isPaused && this.vehicles.length > 0) {
      const roadWidth = this.totalLanes * this.laneWidth;
      const roadLength = this.corridorLengthMeters;

      // Sort vehicles by progress for car-following leader lookup
      const sortedByProgress = [...this.vehicles].sort((a, b) => b.progress - a.progress);

      this.vehicles.forEach((v) => {
        // Find leader vehicle in same lane
        const leader = sortedByProgress.find(
          (other) => other.laneIndex === v.laneIndex && other.id !== v.id && other.progress > v.progress
        ) || sortedByProgress.find(
          (other) => other.laneIndex === v.laneIndex && other.id !== v.id
        );

        v.update(delta, this.simSpeedMultiplier, roadLength, leader);

        // Update 3D mesh position
        if (v.mesh) {
          const laneX = -roadWidth / 2 + (v.laneIndex + 0.5) * this.laneWidth;
          const zPos = -roadLength / 2 + v.progress * roadLength;
          v.mesh.position.set(laneX, 0.05, zPos);
        }
      });

      // Follow vehicle in Driver View mode
      if (this.cameraMode === "driver" && !this.isVR && !this.isAR) {
        const activeV = this.vehicles.find((veh) => veh.id === this.activeVehicleId) || this.vehicles[0];
        if (activeV?.mesh) {
          const targetPos = activeV.mesh.position.clone().add(new THREE.Vector3(0, 1.4, -20));
          const camPos = activeV.mesh.position.clone().add(new THREE.Vector3(0, 2.8, 7.0));
          this.controls.target.lerp(targetPos, 0.1);
          this.camera.position.lerp(camPos, 0.1);
        }
      }
    }

    if (!this.isVR && !this.isAR) {
      this.controls.update();
    }

    this.renderer.render(this.scene, this.camera);
  }

  clearGroup(group) {
    while (group.children.length > 0) {
      const obj = group.children[0];
      group.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    }
  }

  destroy() {
    window.removeEventListener("resize", this.onWindowResize);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.setAnimationLoop(null);
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}
