/**
 * WebXR Support & Device Capability Detection Utility
 * Checks support for WebXR immersive-vr, immersive-ar, and hit-test features.
 */

export async function checkWebXRSupport() {
  const result = {
    isSupported: false,
    vrSupported: false,
    arSupported: false,
    hitTestSupported: false,
    sessionMode: null,
    reason: "",
    hardwareGuidance: "",
  };

  if (typeof window === "undefined" || !navigator.xr) {
    result.reason = "WebXR Device API is not available in this browser.";
    result.hardwareGuidance =
      "For VR, use a WebXR-compatible browser such as Meta Quest Browser, Google Chrome on PC with an OpenXR headset (SteamVR/Oculus Link), or Wolvic. For AR, use Google Chrome on Android (with Google Play Services for AR) or an AR-capable WebXR headset.";
    return result;
  }

  result.isSupported = true;

  try {
    result.vrSupported = await navigator.xr.isSessionSupported("immersive-vr");
  } catch (err) {
    result.vrSupported = false;
  }

  try {
    result.arSupported = await navigator.xr.isSessionSupported("immersive-ar");
  } catch (err) {
    result.arSupported = false;
  }

  if (result.arSupported) {
    result.hitTestSupported = true;
  }

  if (!result.vrSupported && !result.arSupported) {
    result.reason = "WebXR is present in browser, but no active XR hardware (VR headset or ARCore/ARKit) was detected.";
    result.hardwareGuidance =
      "To test immersive modes: Connect a VR headset (e.g. Meta Quest via Quest Link/Virtual Desktop), open in Meta Quest Browser, or open Chrome on an ARCore-enabled Android smartphone. On desktop, the simulator automatically runs in full interactive 3D simulation mode.";
  }

  return result;
}

export function getWebXRDiagnosticSummary(support) {
  if (support.vrSupported && support.arSupported) {
    return {
      status: "full",
      badge: "WebXR Full AR/VR Ready",
      color: "#10b981",
      description: "Both immersive Virtual Reality and Augmented Reality surface hit-testing are supported on this device.",
    };
  }
  if (support.vrSupported) {
    return {
      status: "vr-only",
      badge: "WebXR VR Supported",
      color: "#3b82f6",
      description: "Immersive VR headset navigation is supported. AR requires an ARCore/camera-enabled device.",
    };
  }
  if (support.arSupported) {
    return {
      status: "ar-only",
      badge: "WebXR AR Supported",
      color: "#8b5cf6",
      description: "Immersive AR tabletop placement and hit-testing are supported on this mobile device.",
    };
  }
  return {
    status: "desktop-3d",
    badge: "Desktop 3D Simulator (Non-XR Fallback)",
    color: "#64748b",
    description: "Running in hardware-accelerated WebGL 3D mode. WebXR hardware (Meta Quest, HTC Vive, or Android ARCore) not detected.",
  };
}
