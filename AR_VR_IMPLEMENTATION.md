# GridLock: Immersive AR/VR Traffic Intelligence Simulator
## Academic Engineering & Computer Graphics Documentation

**Project Name:** GridLock – Spatio-Temporal Traffic Mobility Predictor  
**Module:** Immersive WebXR 3D Traffic Intelligence Simulator (AR / VR / Desktop 3D)  
**Author:** Sunny Pandey  
**Institution / Scope:** Academic ISD Project (Intelligent Systems & Interactive Computer Graphics)  
**Date:** November 2026  

---

## 1. Project Objectives & System Overview

The **AR/VR Traffic Intelligence Simulator** extends the GridLock spatio-temporal traffic prediction engine into a real-time, interactive, stereoscopic 3D environment. Prior GridLock modules focused on tabular time-series forecasts, 2D GIS heatmaps, TreeSHAP feature attribution, and sensor health metrics. While informative, 2D dashboards fail to convey the physical reality of spatial congestion, vehicular bottleneck propagation, and road geometry.

### Core Objectives:
1. **Interactive 3D Corridor Simulation:** Construct mathematically grounded highway corridors directly derived from Caltrans PeMS sensor stations, accurate postmiles, and multi-lane geometries.
2. **WebXR Virtual Reality (VR):** Deliver true 6-DoF ($SE(3)$) head-mounted stereoscopic navigation using the WebXR Device API, featuring controller laser pointing, raycast sensor interrogation, and in-VR floating telemetry HUDs.
3. **WebXR Augmented Reality (AR):** Implement horizontal plane hit-testing using WebXR SLAM feature points to project a miniature tabletop 3D highway into the user's real-world environment with interactive inspection.
4. **Machine Learning Model Grounding:** Link 3D vehicular kinematics and highway segment illumination directly to live and historical inferences from **XGBoost, CatBoost, LightGBM, and the Weighted Ensemble**.
5. **Macroscopic & Microscopic Traffic Flow Integration:** Model dynamic vehicle speeds and densities using Greenshields traffic stream theory ($v = v_f(1 - k/k_j)$) alongside car-following collision prevention heuristics.
6. **Graceful Degradation & Academic Honesty:** Distinguish true immersive WebXR sessions from standard hardware-accelerated 3D desktop fallbacks with explicit device diagnostics.

---

## 2. 3D Computer Graphics & Rendering Foundations

The simulator is built atop **Three.js** utilizing hardware-accelerated **WebGL 2.0 / WebXR** pipelines.

```
                    ┌─────────────────────────┐
                    │ Caltrans PeMS Metadata  │
                    │ & ML Speed Inferences   │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ SimulatorService Engine │
                    │ (Greenshields Physics)  │
                    └────────────┬────────────┘
                                 │ REST JSON
                                 ▼
                    ┌─────────────────────────┐
                    │   Three.js Scene Graph   │
                    │  (HighwaySceneEngine)   │
                    └──────┬───────────┬──────┘
                           │           │
            ┌──────────────┴────┐ ┌────┴──────────────┐
            ▼                   ▼ ▼                   ▼
   ┌─────────────────┐ ┌────────────────┐ ┌─────────────────┐
   │ Desktop WebGL   │ │ WebXR Immersive│ │ WebXR Immersive │
   │ 360° Controls   │ │ VR Headset     │ │ AR Tabletop     │
   └─────────────────┘ └────────────────┘ └─────────────────┘
```

### 2.1 Coordinate Transformations & The Graphics Pipeline
Every entity in the simulation (highway slabs, vehicles, sensor gantries, laser pointers) is positioned via homogenous 4×4 affine transformation matrices:

$$M = T(t_x, t_y, t_z) \cdot R_z(\theta_z) \cdot R_y(\theta_y) \cdot R_x(\theta_x) \cdot S(s_x, s_y, s_z)$$

The vertex transformation pipeline maps local vehicle geometry to normalized device coordinates (NDC):

$$v_{clip} = \mathbf{P}_{proj} \cdot \mathbf{V}_{view} \cdot \mathbf{M}_{model} \cdot v_{local}$$

* **Model Matrix ($\mathbf{M}$):** Translates vehicle coordinates along highway lanes ($X$: lane offset, $Y$: road elevation $+0.05\text{m}$, $Z$: postmile progression).
* **View Matrix ($\mathbf{V}$):** In desktop mode, computed from `PerspectiveCamera` with `OrbitControls`. In WebXR mode, populated directly by the headset pose $SE(3)$ tracking matrix via `XRSession.requestAnimationFrame`.
* **Projection Matrix ($\mathbf{P}$):** Asymmetric frustum projection matrices provided per-eye by the WebXR display hardware (`XRWebGLLayer`).

### 2.2 Materials, Shading, & Lighting Architecture
* **Physically Based Rendering (PBR):** Roadbeds utilize `MeshStandardMaterial` configured with high roughness ($\mu = 0.85$) and low metalness ($\mu = 0.15$) to replicate asphalt light absorption.
* **Vehicle Paint Shaders:** Specular metallic car bodies ($\text{metalness} = 0.7$, $\text{roughness} = 0.25$) paired with dark tinted cabin glass ($\text{metalness} = 0.9$, $\text{roughness} = 0.1$).
* **Dynamic Lighting:**
  * Directional sunlight ($L_d = (60, 100, 80)$, color `#fffaed`, intensity $1.2$) casting PCF soft percentage-closer shadow maps (`PCFSoftShadowMap`, resolution 2048×2048).
  * Sky/Ground Hemisphere Light (`#38bdf8` to `#0f172a`, intensity $0.4$) providing natural ambient atmospheric scattering.
  * Emissive LED brake lights with dynamic intensity ($I = 0.2 \to 1.5$) during car deceleration.

---

## 3. WebXR Virtual Reality (VR) Implementation

The Virtual Reality subsystem implements true head-mounted display (HMD) stereoscopy and dual 6-DoF spatial controller interaction.

### 3.1 WebXR Session Initialization
VR sessions are requested through the standard WebXR Device API:
```javascript
const session = await navigator.xr.requestSession('immersive-vr', {
  optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
});
renderer.xr.setSession(session);
```
* **Reference Space:** Uses `'local-floor'` to establish real physical floor height ($Y=0$), placing the user at eye level on the roadside or overhead observation deck.
* **Stereoscopic Rendering:** The WebGL renderer automatically binds left-eye and right-eye viewports via `XRWebGLLayer`, rendering two slightly offset cameras based on the user's interpupillary distance (IPD).

### 3.2 6-DoF Spatial Controller Raycasting
Dual VR controllers are instantiated through `renderer.xr.getController(0)` and `getController(1)`:
* **Laser Pointer Visual:** A tapered luminous beam extends 10 meters along the controller's negative Z-axis ($0, 0, -10$).
* **Trigger Selection Raycasting:** When the user pulls the primary trigger button (`'select'` event), a spatial raycaster is projected from the controller's world transformation matrix:
  ```javascript
  const tempMatrix = new THREE.Matrix4();
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  ```
* Intersected sensor gantries trigger immediate state activation, updating the floating holographic telemetry card in 3D space.

---

## 4. WebXR Augmented Reality (AR) Implementation

The Augmented Reality subsystem allows users on AR-capable devices (e.g., Chrome on Android with Google Play Services for AR / ARCore) to project a live miniature table-top model of the highway into their physical environment.

### 4.1 Surface Hit-Testing & Reticle Anchoring
1. **Session Request:** Requests `'immersive-ar'` with required feature `'hit-test'`:
   ```javascript
   const session = await navigator.xr.requestSession('immersive-ar', {
     requiredFeatures: ['hit-test'],
     optionalFeatures: ['local-floor', 'dom-overlay']
   });
   ```
2. **Hit Test Source:** Binds an `XRHitTestSource` relative to the device's screen-centered `'viewer'` reference space.
3. **Planar Detection:** In each animation frame, `frame.getHitTestResults(hitTestSource)` tests ray-intersections against real-world detected planes (desks, tables, floors).
4. **Reticle Projection:** When a surface is intersected, a circular blue targeting reticle (`THREE.RingGeometry`) is oriented coplanar to the detected surface normal:
   ```javascript
   const hitPose = hit.getPose(referenceSpace);
   reticle.visible = true;
   reticle.matrix.fromArray(hitPose.transform.matrix);
   ```
5. **Tabletop Model Placement:** Tapping the screen or controller places the highway corridor at the reticle position and applies an affine scale transformation ($s = 0.04$) to turn the 800-meter highway into a 32-centimeter interactive desk model.

---

## 5. Spatio-Temporal ML Integration & Traffic Physics

### 5.1 Real Data Ingestion
The simulator retrieves highway corridors via:
* `GET /api/simulator/corridors`: Catalogs 16 freeway branches across Silicon Valley (CA-85, US-101, I-880, I-280, CA-17, CA-237, CA-87).
* `GET /api/simulator/highway`: Assembles sequential sensor stations sorted by Caltrans Absolute Postmile (`Abs_PM`), calculates inter-sensor segment lengths in meters, queries ground-truth speeds from PostgreSQL, and computes inferences across all 4 machine learning models:
  * **LightGBM:** Fast gradient-boosted decision trees.
  * **XGBoost:** Extreme gradient boosting with second-order Taylor expansion.
  * **CatBoost:** Oblivious tree symmetric splitting with categorical embeddings.
  * **Weighted Ensemble:** Optimal inverse-variance linear combination ($\sum w_i \hat{y}_i$).

### 5.2 Congestion Classification & Chromatic Road Ribbons
Highway segments are classified relative to reference free-flow speeds ($F = 65\text{ mph}$):

$$\text{Congestion Ratio } R = \frac{S_{eff}}{F}$$

* **Free-Flow ($R \ge 0.70$):** Emerald Green (`#10b981`)
* **Moderate Traffic ($0.40 \le R < 0.70$):** Amber Yellow (`#f59e0b`)
* **Heavy Congestion ($R < 0.40$):** Ruby Red (`#ef4444`)
* **Missing Data:** Slate Grey (`#6b7280`)

Each segment renders illuminated under-glow ribbons along both guardrails, visually communicating congestion bottlenecks across the 3D corridor.

### 5.3 Microscopic Vehicle Kinematics (Car-Following Model)
Vehicles are governed by an adaptive kinematic car-following model:
* **Target Speed:** $v_{target} = v_{segment} + \epsilon_i$, where $\epsilon_i \sim \mathcal{U}(-3, 3)\text{ mph}$.
* **Headway Safety Distance:**
  $$d_{safe} = \max\left(12.0\text{ m},\, 1.5 \cdot v_{current}\right)$$
* **Collision Avoidance:** If distance to lead vehicle in the same lane falls below $d_{safe}$, deceleration rate $a_{brake} = 18\text{ mph/s}$ activates, vehicle slows to match leader, and brake lights illuminate (`emissiveIntensity = 1.5`).
* **Greenshields Flow Density:** Vehicle spawn counts scale with empirical traffic density $k = k_j(1 - v/v_f)$, reproducing realistic traffic accordion waves.

---

## 6. Testing & Validation Procedures

### Automated Test Suite (`test/test_simulator.py`)
1. `test_corridors_loaded`: Verifies parser reads all 16 Caltrans corridors.
2. `test_corridor_postmile_ordering`: Verifies sensors are strictly non-decreasing in postmile.
3. `test_get_highway_scene_structure`: Verifies segments, sensors, lengths, and coordinate fields.
4. `test_sensor_metrics_and_classification`: Verifies positive Greenshields density ($k > 0$) and flow rates ($q > 0$).
5. `test_segment_metrics_and_spawn_targets`: Verifies segment vehicle counts and color validity.
6. `test_color_mapping`: Verifies exact hex codes matching the GridLock design tokens.
7. `test_invalid_corridor_fallback`: Verifies graceful degradation for unsupported routes.

**Result:** **80/80 unit and integration tests passing** across the complete GridLock test suite.

### Frontend Production Build
Compiled using Vite 7.3.8 and Node 22:
```bash
npm --prefix dashboard run build
✓ built in 655ms
```
Zero build warnings, zero runtime syntax errors.

---

## 7. Technical Limitations & Hardware Requirements

1. **WebXR Hardware Prerequisites:**
   * **Virtual Reality:** Requires an OpenXR-compliant HMD (e.g., Meta Quest 2/3/Pro, HTC Vive, or Valve Index). Standard desktop monitors cannot produce stereoscopic binocular disparity.
   * **Augmented Reality:** Requires camera ARCore SLAM support (e.g., Google Chrome on Android with Google Play Services for AR).
2. **Desktop Fallback Transparency:** When WebXR hardware is absent, the system explicitly displays the diagnostic status `"Desktop 3D Simulator (Non-XR Fallback)"` and provides full 360-degree OrbitControls, Aerial Drone view, Roadside Tower view, and Driver Dashcam camera modes.
