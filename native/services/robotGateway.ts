import { getRandomBytes } from "expo-crypto";
import type { Detection, DriveMotion, RangeReading, RobotEndpoints, RobotSettings, RobotTelemetry } from "../domain/robot";
import { isWebSocketUrl } from "../domain/robot";
import { LinkSession, authProof, sameMac, serverProof, sessionKey, toHex } from "../domain/crypto";

type GatewayListeners = {
  onState: (state: "connecting" | "connected" | "disconnected" | "error", message?: string) => void;
  onTelemetry: (telemetry: Partial<RobotTelemetry>) => void;
  onDetection: (detection: Detection) => void;
  onRange?: (reading: RangeReading) => void;
  onSettings?: (settings: Partial<RobotSettings>) => void;
  /** Whether this phone holds the controls; another device may be driving. */
  onControl?: (driving: boolean, reason?: string) => void;
};

export type TicketPurpose = "stream" | "frame";

let socket: WebSocket | null = null;
let listeners: GatewayListeners | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let wantConnection = false;
let activeUrl = "";
let token = "";
/** Set once the handshake succeeds; nothing but the handshake is sent before it. */
let authenticated = false;
let session: LinkSession | null = null;
let pendingChallenge: { roverNonce: string; clientNonce: string } | null = null;
const ticketWaiters: { purpose: TicketPurpose; resolve: (ticket: string | null) => void }[] = [];

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
const TICKET_TIMEOUT_MS = 5000;
/** The rover's close code for a failed handshake. Retrying it would only earn a lockout. */
const CLOSE_AUTH_FAILED = 4401;

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

function resetLink() {
  authenticated = false;
  session = null;
  pendingChallenge = null;
  for (const waiter of ticketWaiters.splice(0)) waiter.resolve(null);
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

/** Give up on this rover until the user changes something, with a reason they can act on. */
function refuse(activeSocket: WebSocket, message: string) {
  wantConnection = false;
  clearRetry();
  // Detach first, so the close that follows cannot replace this message with
  // a plain "disconnected".
  if (socket === activeSocket) socket = null;
  resetLink();
  listeners?.onState("error", message);
  activeSocket.close();
}

function onHandshake(activeSocket: WebSocket, raw: Record<string, unknown>) {
  if (raw.type === "challenge" && typeof raw.nonce === "string") {
    if (!token) {
      refuse(activeSocket, "This rover needs an access token. Enter it in Settings.");
      return;
    }
    const clientNonce = toHex(getRandomBytes(16));
    pendingChallenge = { roverNonce: raw.nonce, clientNonce };
    // The token itself never goes on the wire: only a signature made with it.
    activeSocket.send(JSON.stringify({ type: "auth", clientNonce, mac: authProof(token, raw.nonce, clientNonce) }));
    return;
  }
  if (raw.type === "authOk" && pendingChallenge && typeof raw.proof === "string") {
    const key = sessionKey(token, pendingChallenge.roverNonce, pendingChallenge.clientNonce);
    if (!sameMac(raw.proof, serverProof(key))) {
      // Only something holding the token can make this proof.
      refuse(activeSocket, "The rover could not prove it has this token. Check the token, or something else is answering at the rover's address.");
      return;
    }
    session = new LinkSession(key);
    authenticated = true;
    retryAttempt = 0;
    listeners?.onState("connected", "Connected to rover (authenticated)");
    return;
  }
  if (raw.type === "hello" && raw.auth === "none") {
    if (token) {
      // A rover with a token always challenges. One that does not may not be ours.
      refuse(activeSocket, "This rover is not asking for a token. Refusing to connect, in case something else is answering at its address.");
      return;
    }
    session = null;
    authenticated = true;
    retryAttempt = 0;
    listeners?.onState("connected", "Connected to rover (no token set on the rover)");
  }
}

function onMessage(raw: Record<string, unknown>) {
  // Anything not signed with this connection's key, or replayed, is dropped here.
  const message = session ? session.open(raw) : raw;
  if (!message) return;
  if (message.type === "telemetry") listeners?.onTelemetry(message as Partial<RobotTelemetry>);
  if (message.type === "detection" && message.detection) listeners?.onDetection(message.detection as Detection);
  if (message.type === "range") listeners?.onRange?.(message as unknown as RangeReading);
  if (message.type === "settings" && message.settings) listeners?.onSettings?.(message.settings as Partial<RobotSettings>);
  if (message.type === "control") listeners?.onControl?.(message.driving === true, typeof message.reason === "string" ? message.reason : undefined);
  if (message.type === "ticket" && typeof message.ticket === "string") {
    const index = ticketWaiters.findIndex(waiter => waiter.purpose === message.purpose);
    if (index >= 0) ticketWaiters.splice(index, 1)[0].resolve(message.ticket);
  }
}

function openSocket() {
  resetLink();
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
    listeners?.onState("connecting", "Verifying the rover...");
  };
  activeSocket.onerror = () => {
    failed = true;
    if (wantConnection) listeners?.onState("error", "Unable to reach the rover.");
  };
  activeSocket.onclose = event => {
    // An old connection closing must not mark a newer connection as disconnected.
    if (socket !== activeSocket) return;
    socket = null;
    resetLink();
    if (event.code === CLOSE_AUTH_FAILED) {
      refuse(activeSocket, "The rover rejected the access token. Check it in Settings.");
      return;
    }
    if (wantConnection) {
      listeners?.onState(failed ? "error" : "disconnected", failed ? "Unable to reach the rover." : "Rover connection lost.");
      scheduleRetry();
    } else {
      listeners?.onState("disconnected", "Rover disconnected");
    }
  };
  activeSocket.onmessage = event => {
    if (socket !== activeSocket) return;
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data));
    } catch {
      return; // Malformed packets are dropped without ending a driving session.
    }
    if (typeof raw !== "object" || raw === null) return;
    if (authenticated) onMessage(raw as Record<string, unknown>);
    else onHandshake(activeSocket, raw as Record<string, unknown>);
  };
}

export function connectRobot(endpoints: RobotEndpoints, nextListeners: GatewayListeners) {
  disconnectRobot(false);
  listeners = nextListeners;

  const url = endpoints.websocketUrl.trim();
  if (!url) {
    listeners.onState("error", "Enter the Raspberry Pi address first.");
    return;
  }
  if (!isWebSocketUrl(url)) {
    listeners.onState("error", "Control URL must start with ws:// or wss://");
    return;
  }

  wantConnection = true;
  retryAttempt = 0;
  // No token in the URL: it would cross the network in clear. The handshake proves it.
  activeUrl = url;
  token = endpoints.token.trim();
  openSocket();
}

function send(payload: Record<string, unknown>): boolean {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(session ? session.seal(payload) : payload));
  return true;
}

/** A short-lived ticket that opens the video, so the token never appears in a URL. */
export function requestTicket(purpose: TicketPurpose): Promise<string | null> {
  return new Promise(resolve => {
    if (!send({ type: "ticket", purpose })) {
      resolve(null);
      return;
    }
    const waiter = { purpose, resolve };
    ticketWaiters.push(waiter);
    setTimeout(() => {
      const index = ticketWaiters.indexOf(waiter);
      if (index >= 0) {
        ticketWaiters.splice(index, 1);
        resolve(null);
      }
    }, TICKET_TIMEOUT_MS);
  });
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
  if (sendStop) send({ type: "brake" });
  wantConnection = false;
  retryAttempt = 0;
  clearRetry();
  const closing = socket;
  socket = null;
  resetLink();
  closing?.close();
}
