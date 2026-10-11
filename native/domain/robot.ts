export type DetectionKind = "fire" | "smoke";
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
  inferenceMs: number;
  /** False while MOTOR_OUTPUT=0: the rover accepts drive commands but the wheels stay still. */
  motorOutput: boolean;
  /** True when a pin is wired for the device; the app hides the button otherwise. */
  flashAvailable: boolean;
  /** The rover's own state, so an auto-siren starting or timing out is shown too. */
  flashOn: boolean;
  sirenAvailable: boolean;
  sirenOn: boolean;
  /** True while the on-device fire/smoke model is running. */
  detectorActive: boolean;
  /** Why the model is not running, when it failed to start. */
  detectorError: string;
  /** Detections the rover filtered out below the sensitivity threshold. */
  suppressedDetections: number;
  /** Camera horizontal field of view in degrees, used to turn boxes into bearings. */
  cameraHfovDeg: number;
  /** Milliseconds since the rover's camera last delivered a frame, or VALUE_UNAVAILABLE. */
  cameraFrameAgeMs: number;
  /** True when the camera takes white balance presets (the Pi camera; not a webcam). */
  whiteBalanceAvailable: boolean;
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

/** Mirrors WHITE_BALANCE_MODES in raspberry_pi/rover_server.py. */
export type WhiteBalance = "auto" | "daylight" | "cloudy" | "indoor" | "tungsten" | "fluorescent";

export interface RobotSettings {
  detectionSensitivity: number;
  autoSiren: boolean;
  showAlerts: boolean;
  showLocation: boolean;
  cameraQuality: CameraQuality;
  whiteBalance: WhiteBalance;
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

export function isWebSocketUrl(url: string): boolean {
  return /^wss?:\/\/\S+$/i.test(url.trim());
}

/** The rover's continuous video for a camera frame URL, or "" when there is none.
 *
 * The rover serves /stream.mjpg beside /frame.jpg. A hand-entered camera URL that
 * is not a /frame.jpg may be some other server, so it is polled as before.
 */
export function streamUrlFor(cameraUrl: string): string {
  const url = cameraUrl.trim();
  return /\/frame\.jpg$/i.test(url) ? url.replace(/\/frame\.jpg$/i, "/stream.mjpg") : "";
}

/** HTTP_PORT's default in raspberry_pi/rover_server.py. */
export const DEFAULT_ROVER_PORT = 8000;

/** "192.168.1.50", "192.168.1.50:8123" or "agni.local" -> the two URLs the rover serves.
 *
 * Both URLs carry the same host and port, so typing them separately on a phone
 * keyboard was two chances to get one wrong. Null when it is not an address.
 */
export function endpointsFromAddress(address: string): { cameraUrl: string; websocketUrl: string } | null {
  // Tolerate a pasted URL: drop any scheme and path, keep host and port.
  const bare = address.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(bare);
  if (!match) return null;
  const port = Number(match[2] ?? DEFAULT_ROVER_PORT);
  if (port < 1 || port > 65535) return null;
  const hostPort = `${match[1]}:${port}`;
  return { cameraUrl: `http://${hostPort}/frame.jpg`, websocketUrl: `ws://${hostPort}/control` };
}

/** The address two URLs were built from, or "" when they were customised by hand. */
export function addressFromEndpoints(cameraUrl: string, websocketUrl: string): string {
  const match = /^ws:\/\/([^/:]+):(\d+)\/control$/i.exec(websocketUrl.trim());
  if (!match) return "";
  const address = Number(match[2]) === DEFAULT_ROVER_PORT ? match[1] : `${match[1]}:${match[2]}`;
  const derived = endpointsFromAddress(address);
  return derived && derived.cameraUrl === cameraUrl.trim() ? address : "";
}
