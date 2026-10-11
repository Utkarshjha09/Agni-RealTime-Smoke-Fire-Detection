import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import type { ConnectionState, Detection, DriveMotion, RangeReading, RobotEndpoints, RobotSettings, RobotTelemetry } from "../../domain/robot";
import { VALUE_UNAVAILABLE, streamUrlFor } from "../../domain/robot";
import { clampUnit } from "../../domain/drive";
import { brakeRobot, connectRobot, defaultEndpoints, disconnectRobot, requestTicket, sendDeviceAction, sendMotion, sendSettings } from "../../services/robotGateway";
import { POINT_TTL_MS } from "../../domain/rangeMap";
import { loadEndpoints, loadSettings, saveEndpoints, saveSettings } from "../../services/storage";

type CameraState = "idle" | "loading" | "live" | "error";

type RobotSession = {
  telemetry: RobotTelemetry;
  detections: Detection[];
  /** Recent ultrasonic pings, newest first. Older than POINT_TTL_MS are dropped. */
  rangeReadings: RangeReading[];
  activeDetection: Detection | null;
  /** Continuous video from the rover, token included. Preferred when present. */
  streamUrl: string;
  /** Changes on each retry, so the stream view starts afresh. */
  streamAttempt: number;
  /** Polled single frames, only for a camera URL with no stream beside it. */
  cameraUrl: string;
  cameraState: CameraState;
  connectionState: ConnectionState;
  connectionMessage: string;
  endpoints: RobotEndpoints;
  settings: RobotSettings;
  ready: boolean;
  updateEndpoints: (endpoints: RobotEndpoints) => void;
  updateSettings: (settings: Partial<RobotSettings>) => void;
  connect: (endpoints?: RobotEndpoints) => void;
  disconnect: () => void;
  clearDetections: () => void;
  /** Map markers and range points from before this are hidden; Alerts keeps them. */
  mapClearedAt: number;
  clearMap: () => void;
  onCameraLoad: () => void;
  onCameraError: () => void;
  onStreamError: () => void;
  /** Set while another device holds the controls; this phone's stick is ignored. */
  controlNotice: string | null;
  /** Boxes drawn onto the video by the rover (AR on), or the plain camera. */
  overlay: boolean;
  setOverlay: (on: boolean) => void;
  drive: (throttle: number, steering: number, sprint: boolean) => void;
  brake: () => void;
  setDeviceAction: (device: "flash" | "siren", enabled: boolean) => boolean;
};

const RobotContext = createContext<RobotSession | null>(null);
const idleMotion: DriveMotion = { throttle: 0, steering: 0, sprint: false };
// 720p matches the rover's default: a Pi 4 serves it fast enough to drive by.
const defaultSettings: RobotSettings = { detectionSensitivity: 74, autoSiren: true, showAlerts: true, showLocation: true, cameraQuality: "720p", whiteBalance: "daylight" };
/** A frame request with no answer in this long has stalled; show it and retry. */
const FRAME_STALL_MS = 5000;
/** Pause between one frame arriving and asking for the next. */
const FRAME_GAP_MS = 40;
/** At most one drive packet per this many ms, about 20 a second. A finger on the
 * stick reports far more often than that, and the rover gains nothing from it. */
const DRIVE_SEND_MS = 50;
/** A held command is repeated this often so the rover's 0.45s watchdog never fires
 * mid-drive. Several repeats fit inside one watchdog window, so one lost packet on
 * a weak link does not stop the car. */
const DRIVE_KEEPALIVE_MS = 120;
const offlineTelemetry: RobotTelemetry = {
  batteryPercent: VALUE_UNAVAILABLE,
  signalDb: VALUE_UNAVAILABLE,
  gpsLocked: false,
  roverName: "Offline",
  inferenceMs: 0,
  motorOutput: false,
  flashAvailable: false,
  flashOn: false,
  sirenAvailable: false,
  sirenOn: false,
  detectorActive: false,
  detectorError: "",
  suppressedDetections: 0,
  cameraHfovDeg: 0,
  cameraFrameAgeMs: VALUE_UNAVAILABLE,
  whiteBalanceAvailable: false,
  rangeSensorActive: false,
  rangeSensorError: "",
  rangeM: VALUE_UNAVAILABLE,
  rangeBearingDeg: 0,
  rangeBeamDeg: 0,
  rangeMaxM: 0,
};

function isIdle(motion: DriveMotion) {
  return motion.throttle === 0 && motion.steering === 0;
}

export function RobotProvider({ children }: { children: ReactNode }) {
  const [telemetry, setTelemetry] = useState(offlineTelemetry);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [rangeReadings, setRangeReadings] = useState<RangeReading[]>([]);
  const [endpoints, setEndpoints] = useState<RobotEndpoints>(defaultEndpoints);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [connectionMessage, setConnectionMessage] = useState("Rover not connected");
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraTick, setCameraTick] = useState(Date.now());
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [streamUrl, setStreamUrl] = useState("");
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(true);
  // The drive command lives in refs, not state. A stick reports dozens of moves a
  // second; as state, each one re-rendered every screen (camera included) before
  // the packet could leave. Now a move goes straight to the socket.
  const motionRef = useRef<DriveMotion>(idleMotion);
  const lastSentRef = useRef(0);
  const pendingSendRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settings, setSettings] = useState<RobotSettings>(defaultSettings);
  const [ready, setReady] = useState(false);
  // Latest settings without re-creating connect() on every keystroke of a slider.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const receiveDetection = useCallback((detection: Detection) => {
    if (detection.kind !== "fire" && detection.kind !== "smoke") return;
    const stamped: Detection = { ...detection, receivedAt: Date.now() };
    setDetections(current => [stamped, ...current.filter(item => item.id !== detection.id)].slice(0, 50));
  }, []);

  const receiveRange = useCallback((reading: RangeReading) => {
    const arrivedAt = Date.now();
    const stamped: RangeReading = { ...reading, receivedAt: arrivedAt };
    // Drop readings that have aged past the map's TTL here rather than in render,
    // so the list cannot grow without bound while the rover sits connected.
    setRangeReadings(current =>
      [stamped, ...current].filter(item => arrivedAt - (item.receivedAt ?? 0) <= POINT_TTL_MS).slice(0, 240),
    );
  }, []);

  /** Forget any held command without sending, for when there is no link to send on. */
  const resetMotion = useCallback(() => {
    if (pendingSendRef.current) clearTimeout(pendingSendRef.current);
    pendingSendRef.current = null;
    motionRef.current = idleMotion;
  }, []);

  const flushMotion = useCallback(() => {
    if (pendingSendRef.current) clearTimeout(pendingSendRef.current);
    pendingSendRef.current = null;
    lastSentRef.current = Date.now();
    sendMotion(motionRef.current);
  }, []);

  const connect = useCallback((nextEndpoints?: RobotEndpoints) => {
    const target = nextEndpoints ?? endpoints;
    setEndpoints(target);
    void saveEndpoints(target);
    setCameraState(target.cameraUrl ? "loading" : "idle");
    connectRobot(target, {
      onState: (state, message) => {
        setConnectionState(state);
        setConnectionMessage(message ?? (state === "connected" ? "Connected to rover" : "Rover disconnected"));
        if (state === "connected") {
          sendSettings(settingsRef.current);
        } else {
          // The last packet from a rover we can no longer hear is not current.
          // Keeping it would leave "AI" lit and a signal reading on an offline screen.
          setTelemetry(offlineTelemetry);
          setRangeReadings([]);
          // A stick held through a dropout must not resume driving on reconnect.
          resetMotion();
          setControlNotice(null);
        }
      },
      onTelemetry: packet => setTelemetry(current => ({ ...current, ...packet })),
      onDetection: receiveDetection,
      onRange: receiveRange,
      onControl: (driving, reason) => setControlNotice(driving ? null : reason ?? "Another device is driving"),
    });
  }, [endpoints, receiveDetection, receiveRange, resetMotion]);

  // Restore the last rover and reconnect to it automatically on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [storedEndpoints, storedSettings] = await Promise.all([loadEndpoints(), loadSettings()]);
      if (cancelled) return;
      if (storedSettings) setSettings(current => ({ ...current, ...storedSettings }));
      if (storedEndpoints?.websocketUrl) {
        const restored: RobotEndpoints = { ...defaultEndpoints, ...storedEndpoints };
        setEndpoints(restored);
        connect(restored);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount; connect is stable enough for a one-shot restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = useCallback(() => {
    disconnectRobot();
    resetMotion();
    setTelemetry(offlineTelemetry);
    setRangeReadings([]);
    setConnectionState("disconnected");
    setConnectionMessage("Rover disconnected");
    setCameraState("idle");
  }, [resetMotion]);

  const drive = useCallback((throttle: number, steering: number, sprint: boolean) => {
    const next: DriveMotion = { throttle: clampUnit(throttle), steering: clampUnit(steering), sprint };
    motionRef.current = next;
    const sinceLast = Date.now() - lastSentRef.current;
    // A stop always goes out at once. Otherwise send now if the rate allows, or
    // once at the end of the window so the final position is never dropped.
    if (isIdle(next) || sinceLast >= DRIVE_SEND_MS) {
      flushMotion();
    } else if (!pendingSendRef.current) {
      pendingSendRef.current = setTimeout(flushMotion, DRIVE_SEND_MS - sinceLast);
    }
  }, [flushMotion]);

  const brake = useCallback(() => {
    resetMotion();
    brakeRobot();
  }, [resetMotion]);

  const updateSettings = useCallback((partial: Partial<RobotSettings>) => {
    setSettings(current => {
      const next = { ...current, ...partial };
      sendSettings(next);
      void saveSettings(next);
      return next;
    });
  }, []);

  const clearDetections = useCallback(() => setDetections([]), []);
  // Lives here, not in the map screen, so a cleared map stays cleared when you
  // switch tabs and come back.
  const [mapClearedAt, setMapClearedAt] = useState(0);
  const clearMap = useCallback(() => setMapClearedAt(Date.now()), []);

  useEffect(() => () => disconnectRobot(), []);

  // A held joystick refreshes the command so the rover-side watchdog knows the app is still in control.
  useEffect(() => {
    if (connectionState !== "connected") return;
    const interval = setInterval(() => {
      if (!isIdle(motionRef.current) && Date.now() - lastSentRef.current >= DRIVE_KEEPALIVE_MS) flushMotion();
    }, DRIVE_KEEPALIVE_MS / 2);
    return () => clearInterval(interval);
  }, [connectionState, flushMotion]);

  // Leaving the app mid-drive (a call, the home button) stops the car at once,
  // rather than leaving it to the watchdog after the OS suspends our timers.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", next => {
      if (next !== "active" && !isIdle(motionRef.current)) {
        resetMotion();
        brakeRobot();
      }
    });
    return () => subscription.remove();
  }, [resetMotion]);

  // Frame pacing is driven by onLoad/onError rather than a blind interval, so a
  // slow Pi never has overlapping frame requests piling up behind it. The short
  // gap only yields to the UI thread; the double-buffered feed keeps the last
  // frame on screen meanwhile, so there is nothing to gain by waiting longer.
  const requestNextFrame = useCallback(() => {
    setTimeout(() => setCameraTick(Date.now()), FRAME_GAP_MS);
  }, []);

  const onCameraLoad = useCallback(() => {
    setCameraState("live");
    requestNextFrame();
  }, [requestNextFrame]);

  const onCameraError = useCallback(() => {
    setCameraState("error");
    // Retry more slowly while the camera is failing.
    setTimeout(() => setCameraTick(Date.now()), 1500);
  }, []);

  const onStreamError = useCallback(() => {
    setCameraState("error");
    // A fresh stream after a pause: a rover restart or a Wi-Fi blip recovers
    // on its own, without hammering a camera that is actually broken.
    setTimeout(() => setStreamAttempt(attempt => attempt + 1), 2000);
  }, []);

  // The rover's stream, opened with a one-time ticket from the authenticated
  // socket. The token never appears in a URL, where anyone on the Wi-Fi could read
  // it; a captured ticket is already spent. Each retry asks for a fresh one.
  const streamBase = connectionState === "connected" ? streamUrlFor(endpoints.cameraUrl) : "";
  useEffect(() => {
    setStreamUrl("");
    if (!streamBase) return;
    let cancelled = false;
    void requestTicket("stream").then(ticket => {
      if (cancelled) return;
      if (!ticket) {
        onStreamError();
        return;
      }
      setStreamUrl(`${streamBase}?ticket=${encodeURIComponent(ticket)}${overlay ? "&overlay=1" : ""}`);
    });
    return () => {
      cancelled = true;
    };
    // A change of overlay needs a new stream, and so a new one-time ticket.
  }, [onStreamError, overlay, streamAttempt, streamBase]);

  // The rover says how old its newest camera frame is. A camera that stopped
  // delivering is shown as failed and the stream reopened, rather than the last
  // picture staying on screen looking live.
  const cameraStale = streamBase !== "" && telemetry.cameraFrameAgeMs > FRAME_STALL_MS;
  useEffect(() => {
    if (cameraStale) onStreamError();
  }, [cameraStale, onStreamError]);

  // Polled frames, only for a camera URL that is not the rover's: another server,
  // so the rover's token is never attached to it.
  const cameraUrl = useMemo(() => {
    if (connectionState !== "connected" || !endpoints.cameraUrl || streamUrlFor(endpoints.cameraUrl)) return "";
    const separator = endpoints.cameraUrl.includes("?") ? "&" : "?";
    return `${endpoints.cameraUrl}${separator}t=${cameraTick}`;
  }, [cameraTick, connectionState, endpoints.cameraUrl]);

  // Each frame URL is requested once. If neither onLoad nor onError arrives the
  // chain stops, and the last frame would sit on screen looking live. Every new
  // URL restarts this timer, so it only fires on a real stall.
  useEffect(() => {
    if (!cameraUrl) return;
    const timer = setTimeout(() => {
      setCameraState("error");
      setCameraTick(Date.now());
    }, FRAME_STALL_MS);
    return () => clearTimeout(timer);
  }, [cameraUrl]);

  const value = useMemo<RobotSession>(() => ({
    telemetry,
    detections,
    rangeReadings,
    activeDetection: detections[0] ?? null,
    streamUrl,
    streamAttempt,
    cameraUrl,
    cameraState,
    connectionState,
    connectionMessage,
    endpoints,
    settings,
    ready,
    updateEndpoints: setEndpoints,
    updateSettings,
    connect,
    disconnect,
    clearDetections,
    mapClearedAt,
    clearMap,
    onCameraLoad,
    onCameraError,
    onStreamError,
    controlNotice,
    overlay,
    setOverlay,
    drive,
    brake,
    setDeviceAction: sendDeviceAction,
  }), [brake, cameraState, cameraUrl, clearDetections, clearMap, controlNotice, mapClearedAt, onStreamError, overlay, streamAttempt, streamUrl, connect, connectionMessage, connectionState, detections, disconnect, drive, endpoints, onCameraError, onCameraLoad, rangeReadings, ready, settings, telemetry, updateSettings]);

  return <RobotContext.Provider value={value}>{children}</RobotContext.Provider>;
}

export function useRobot() {
  const session = useContext(RobotContext);
  if (!session) throw new Error("useRobot must be used inside RobotProvider");
  return session;
}
