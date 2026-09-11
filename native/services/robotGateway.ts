import type { Detection, DriveMotion, RangeReading, RobotEndpoints, RobotSettings, RobotTelemetry } from "../domain/robot";
import { isWebSocketUrl, withToken } from "../domain/robot";

type GatewayListeners = {
  onState: (state: "connecting" | "connected" | "disconnected" | "error", message?: string) => void;
  onTelemetry: (telemetry: Partial<RobotTelemetry>) => void;
  onDetection: (detection: Detection) => void;
  onRange?: (reading: RangeReading) => void;
  onSettings?: (settings: Partial<RobotSettings>) => void;
};

let socket: WebSocket | null = null;
let listeners: GatewayListeners | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let wantConnection = false;
let activeUrl = "";

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

export const defaultEndpoints: RobotEndpoints = {
  cameraUrl: process.env.EXPO_PUBLIC_ROBOT_CAMERA_URL ?? "",
  websocketUrl: process.env.EXPO_PUBLIC_ROBOT_WS_URL ?? "",
  token: process.env.EXPO_PUBLIC_ROBOT_TOKEN ?? "",
};

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry() {
  if (!wantConnection || retryTimer) return;
  // Exponential backoff so a rover that is off or out of range is retried
  // politely, but a brief Wi-Fi blip reconnects almost immediately.
  const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS);
  retryAttempt += 1;
  listeners?.onState("connecting", `Reconnecting in ${Math.round(delay / 1000)}s...`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (wantConnection) openSocket();
  }, delay);
}

function openSocket() {
  listeners?.onState("connecting", retryAttempt > 0 ? "Reconnecting to rover..." : "Connecting to rover...");

  let activeSocket: WebSocket;
  try {
    activeSocket = new WebSocket(activeUrl);
  } catch {
    listeners?.onState("error", "The control URL is not valid.");
    scheduleRetry();
    return;
  }
  socket = activeSocket;

  let failed = false;
  activeSocket.onopen = () => {
    retryAttempt = 0;
    listeners?.onState("connected", "Connected to rover");
  };
  activeSocket.onerror = () => {
    failed = true;
    listeners?.onState("error", "Unable to reach the rover.");
  };
  activeSocket.onclose = () => {
    // An old connection closing must not mark a newer connection as disconnected.
    if (socket !== activeSocket) return;
    socket = null;
    if (wantConnection) {
      listeners?.onState(failed ? "error" : "disconnected", failed ? "Unable to reach the rover." : "Rover connection lost.");
      scheduleRetry();
    } else {
      listeners?.onState("disconnected", "Rover disconnected");
    }
  };
  activeSocket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === "telemetry") listeners?.onTelemetry(message);
      if (message.type === "detection" && message.detection) listeners?.onDetection(message.detection as Detection);
      if (message.type === "range") listeners?.onRange?.(message as RangeReading);
      if (message.type === "settings" && message.settings) listeners?.onSettings?.(message.settings as Partial<RobotSettings>);
    } catch {
      // Ignore malformed packets without dropping a working driving session.
    }
  };
}

export function connectRobot(endpoints: RobotEndpoints, nextListeners: GatewayListeners) {
  disconnectRobot(false);
  listeners = nextListeners;

  const url = endpoints.websocketUrl.trim();
  if (!url) {
    listeners.onState("error", "Enter the Raspberry Pi WebSocket URL first.");
    return;
  }
  if (!isWebSocketUrl(url)) {
    listeners.onState("error", "Control URL must start with ws:// or wss://");
    return;
  }

  wantConnection = true;
  retryAttempt = 0;
  activeUrl = withToken(url, endpoints.token.trim());
  openSocket();
}

function send(payload: Record<string, unknown>): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

export function sendMotion(motion: DriveMotion) {
  return send({ type: "drive", ...motion });
}

export function brakeRobot() {
  return send({ type: "brake" });
}

export function sendSettings(settings: RobotSettings) {
  return send({ type: "settings", settings });
}

export function sendDeviceAction(device: "flash" | "siren", enabled: boolean) {
  return send({ type: "device", device, enabled });
}

export function disconnectRobot(sendStop = true) {
  wantConnection = false;
  retryAttempt = 0;
  clearRetry();
  if (socket && sendStop && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "brake" }));
  }
  socket?.close();
  socket = null;
}
