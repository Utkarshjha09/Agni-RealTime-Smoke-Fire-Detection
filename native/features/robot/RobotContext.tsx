import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnectionState, Detection, DriveMotion, RangeReading, RobotEndpoints, RobotSettings, RobotTelemetry } from "../../domain/robot";
import { VALUE_UNAVAILABLE, withToken } from "../../domain/robot";
import { brakeRobot, connectRobot, defaultEndpoints, disconnectRobot, sendDeviceAction, sendMotion, sendSettings } from "../../services/robotGateway";
import { POINT_TTL_MS } from "../../domain/rangeMap";
import { loadEndpoints, loadSettings, saveEndpoints, saveSettings } from "../../services/storage";

type CameraState = "idle" | "loading" | "live" | "error";

type RobotSession = {
  telemetry: RobotTelemetry;
  detections: Detection[];
  /** Recent ultrasonic pings, newest first. Older than POINT_TTL_MS are dropped. */
  rangeReadings: RangeReading[];
  activeDetection: Detection | null;
  cameraUrl: string;
  cameraState: CameraState;
  connectionState: ConnectionState;
  connectionMessage: string;
  endpoints: RobotEndpoints;
  settings: RobotSettings;
  motion: DriveMotion;
  ready: boolean;
  updateEndpoints: (endpoints: RobotEndpoints) => void;
  updateSettings: (settings: Partial<RobotSettings>) => void;
  connect: (endpoints?: RobotEndpoints) => void;
  disconnect: () => void;
  clearDetections: () => void;
  onCameraLoad: () => void;
  onCameraError: () => void;
  drive: (throttle: number, steering: number, sprint: boolean) => void;
  brake: () => void;
  setDeviceAction: (device: "flash" | "siren", enabled: boolean) => boolean;
};

const RobotContext = createContext<RobotSession | null>(null);
const idleMotion: DriveMotion = { throttle: 0, steering: 0, sprint: false };
const defaultSettings: RobotSettings = { detectionSensitivity: 74, autoSiren: true, showAlerts: true, showLocation: true, cameraQuality: "1080p" };
const offlineTelemetry: RobotTelemetry = {
  batteryPercent: VALUE_UNAVAILABLE,
  signalDb: VALUE_UNAVAILABLE,
  gpsLocked: false,
  roverName: "Offline",
  latitude: 0,
  longitude: 0,
  inferenceMs: 0,
  detectorActive: false,
  detectorError: "",
  suppressedDetections: 0,
  cameraHfovDeg: 0,
  rangeSensorActive: false,
  rangeSensorError: "",
  rangeM: VALUE_UNAVAILABLE,
  rangeBearingDeg: 0,
  rangeBeamDeg: 0,
  rangeMaxM: 0,
};

function clamp(value: number) {
  return Math.max(-1, Math.min(1, value));
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
  const [motion, setMotion] = useState<DriveMotion>(idleMotion);
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

  const connect = useCallback((nextEndpoints?: RobotEndpoints) => {
    const target = nextEndpoints ?? endpoints;
    setEndpoints(target);
    void saveEndpoints(target);
    setCameraState(target.cameraUrl ? "loading" : "idle");
    connectRobot(target, {
      onState: (state, message) => {
        setConnectionState(state);
        setConnectionMessage(message ?? (state === "connected" ? "Connected to rover" : "Rover disconnected"));
        if (state === "connected") sendSettings(settingsRef.current);
      },
      onTelemetry: packet => setTelemetry(current => ({ ...current, ...packet })),
      onDetection: receiveDetection,
      onRange: receiveRange,
    });
  }, [endpoints, receiveDetection, receiveRange]);

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
    setMotion(idleMotion);
    setTelemetry(offlineTelemetry);
    setRangeReadings([]);
    setConnectionState("disconnected");
    setConnectionMessage("Rover disconnected");
    setCameraState("idle");
  }, []);

  const drive = useCallback((throttle: number, steering: number, sprint: boolean) => {
    setMotion({ throttle: clamp(throttle), steering: clamp(steering), sprint });
  }, []);

  const brake = useCallback(() => {
    setMotion(idleMotion);
    brakeRobot();
  }, []);

  const updateSettings = useCallback((partial: Partial<RobotSettings>) => {
    setSettings(current => {
      const next = { ...current, ...partial };
      sendSettings(next);
      void saveSettings(next);
      return next;
    });
  }, []);

  const clearDetections = useCallback(() => setDetections([]), []);

  useEffect(() => () => disconnectRobot(), []);

  // A held joystick refreshes the command so the rover-side watchdog knows the app is still in control.
  useEffect(() => {
    if (connectionState !== "connected") return;
    sendMotion(motion);
    if (motion.throttle === 0 && motion.steering === 0) return;
    const interval = setInterval(() => sendMotion(motion), 120);
    return () => clearInterval(interval);
  }, [connectionState, motion]);

  // Frame pacing is driven by onLoad/onError rather than a blind interval, so a
  // slow Pi never has overlapping frame requests piling up behind it.
  const requestNextFrame = useCallback(() => {
    setTimeout(() => setCameraTick(Date.now()), 120);
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

  const cameraUrl = useMemo(() => {
    if (connectionState !== "connected" || !endpoints.cameraUrl) return "";
    const authed = withToken(endpoints.cameraUrl, endpoints.token);
    const separator = authed.includes("?") ? "&" : "?";
    return `${authed}${separator}t=${cameraTick}`;
  }, [cameraTick, connectionState, endpoints.cameraUrl, endpoints.token]);

  const value = useMemo<RobotSession>(() => ({
    telemetry,
    detections,
    rangeReadings,
    activeDetection: detections[0] ?? null,
    cameraUrl,
    cameraState,
    connectionState,
    connectionMessage,
    endpoints,
    settings,
    motion,
    ready,
    updateEndpoints: setEndpoints,
    updateSettings,
    connect,
    disconnect,
    clearDetections,
    onCameraLoad,
    onCameraError,
    drive,
    brake,
    setDeviceAction: sendDeviceAction,
  }), [brake, cameraState, cameraUrl, clearDetections, connect, connectionMessage, connectionState, detections, disconnect, drive, endpoints, motion, onCameraError, onCameraLoad, rangeReadings, ready, settings, telemetry, updateSettings]);

  return <RobotContext.Provider value={value}>{children}</RobotContext.Provider>;
}

export function useRobot() {
  const session = useContext(RobotContext);
  if (!session) throw new Error("useRobot must be used inside RobotProvider");
  return session;
}
