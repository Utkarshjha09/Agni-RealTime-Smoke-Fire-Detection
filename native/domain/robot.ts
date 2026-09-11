export type DetectionKind = "fire" | "smoke";
export type DriveDirection = "forward" | "backward" | "left" | "right" | "stop";
export type AppTab = "control" | "map" | "alerts" | "settings";
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** The rover reports this when a sensor value has no hardware behind it. */
export const VALUE_UNAVAILABLE = -1;

export interface DriveMotion {
  throttle: number;
  steering: number;
  sprint: boolean;
}

export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Detection {
  id: string;
  kind: DetectionKind;
  confidence: number;
  timestamp: string;
  /** Seconds since the epoch, from the rover, used for live relative times. */
  epoch?: number;
  location: string;
  snapshotUrl: string;
  boundingBox?: BoundingBox;
  confirmedBySensor: boolean;
  /** Set by the app when the detection arrives, so ordering survives clock skew. */
  receivedAt?: number;
}

/** One ultrasonic ping, as broadcast by raspberry_pi/range_sensor.py.
 *
 * `distanceM` is VALUE_UNAVAILABLE when the echo was lost. That is not the same as
 * zero: it means nothing in range answered, or the surface was too soft or too
 * angled to reflect. A fire robot showing "0 m" would read as a collision.
 */
export interface RangeReading {
  /** Metres to the nearest surface along the beam, or VALUE_UNAVAILABLE. */
  distanceM: number;
  /** Where the sensor pointed, in degrees from the rover's forward axis. */
  bearingDeg: number;
  /** Width of the sensor's cone in degrees; ~15 for an HC-SR04. */
  beamDeg: number;
  /** Beyond this the sensor cannot hear an echo at all. */
  maxM: number;
  /** Seconds since the epoch, from the rover. */
  epoch: number;
  /** Set by the app on arrival, so ageing survives clock skew. */
  receivedAt?: number;
}

export interface RobotTelemetry {
  /** VALUE_UNAVAILABLE when no battery monitor is wired to the rover. */
  batteryPercent: number;
  signalDb: number;
  gpsLocked: boolean;
  roverName: string;
  latitude: number;
  longitude: number;
  inferenceMs: number;
  /** True while the on-device fire/smoke model is running. */
  detectorActive: boolean;
  /** Why the model is not running, when it failed to start. */
  detectorError: string;
  /** Detections the rover filtered out below the sensitivity threshold. */
  suppressedDetections: number;
  /** Camera horizontal field of view in degrees, used to turn boxes into bearings. */
  cameraHfovDeg: number;
  /** True when an ultrasonic sensor is wired and being read. */
  rangeSensorActive: boolean;
  /** Why the range sensor is not running, when it failed to start. */
  rangeSensorError: string;
  /** Latest measured distance in metres, or VALUE_UNAVAILABLE. */
  rangeM: number;
  /** Where the sensor points. 0 is straight ahead; non-zero once it is on a servo. */
  rangeBearingDeg: number;
  rangeBeamDeg: number;
  rangeMaxM: number;
}

export interface RobotEndpoints {
  cameraUrl: string;
  websocketUrl: string;
  /** Shared secret matching ROVER_TOKEN on the Pi. Empty when the rover is open. */
  token: string;
}

export type CameraQuality = "480p" | "720p" | "1080p";

export interface RobotSettings {
  detectionSensitivity: number;
  autoSiren: boolean;
  showAlerts: boolean;
  showLocation: boolean;
  cameraQuality: CameraQuality;
}

/** Appends the shared secret the Pi expects, preserving any existing query. */
export function withToken(url: string, token: string): string {
  if (!url || !token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

export function isWebSocketUrl(url: string): boolean {
  return /^wss?:\/\/\S+$/i.test(url.trim());
}
