import { LinearGradient } from "expo-linear-gradient";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Glass } from "../components/Glass";
import { Joystick } from "../components/Joystick";
import { LiveStream } from "../components/LiveStream";
import {
  AcceleratorIcon, AgniMark, ArIcon, BatteryIcon, BrakeIcon, CloseIcon, FlameIcon,
  FlashlightIcon, GpsIcon, RecordIcon, SignalIcon, SirenIcon, SmokeIcon,
  SprintIcon,
} from "../components/icons";
import { useScreenInsets } from "../components/useOrientation";
import { colors, font, radius } from "../theme";
import type { AppTab, Detection, RobotTelemetry } from "../domain/robot";
import { VALUE_UNAVAILABLE } from "../domain/robot";
import { combinedThrottle, driveMode, pedalThrottle, wheelMix, type DriveMode, type Pedals } from "../domain/drive";
import { boxOnScreen, liveBoxWindowMs, liveDetections, relativeTime, type Size } from "../domain/detectionView";
import { useRobot } from "../features/robot/RobotContext";

/** Renders an em dash rather than a convincing-looking zero when the rover has no such sensor. */
function readout(value: number, unit: string): string {
  return value === VALUE_UNAVAILABLE ? "—" : `${value}${unit}`;
}

function IconToggle({ Icon, active, onPress, label, disabled }: { Icon: typeof ArIcon; active?: boolean; onPress?: () => void; label: string; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
    >
      {({ pressed }) => (
        <Glass radius={18} glow={active ? colors.cyan : undefined} borderColor={active ? "rgba(76,201,240,0.5)" : undefined} style={[styles.iconBtn, disabled && styles.dimmed, pressed && styles.pressed]}>
          <Icon size={20} color={disabled ? colors.inkMuted : active ? colors.cyan : colors.ink} />
        </Glass>
      )}
    </Pressable>
  );
}

function DriveAction({
  Icon,
  active,
  disabled,
  label,
  onPressIn,
  onPressOut,
  style,
  activeStyle,
  width,
}: {
  Icon: typeof AcceleratorIcon;
  active?: boolean;
  disabled?: boolean;
  label: string;
  onPressIn?: () => void;
  onPressOut?: () => void;
  style: StyleProp<ViewStyle>;
  activeStyle: StyleProp<ViewStyle>;
  width: number;
}) {
  // A native gesture per button, like the stick. React Native's own buttons share
  // one touch responder, so holding ACCEL and then pressing SPRINT or BRAKE
  // cancelled ACCEL: the two-thumb combinations could never work.
  const [pressed, setPressed] = useState(false);
  const inRef = useRef(onPressIn);
  inRef.current = onPressIn;
  const outRef = useRef(onPressOut);
  outRef.current = onPressOut;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const downRef = useRef(false);

  const gesture = useMemo(() => Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .shouldCancelWhenOutside(false)
    // Generous: these are hit by a thumb watching the video, not the button.
    .hitSlop(8)
    .runOnJS(true)
    .onBegin(() => {
      if (disabledRef.current) return;
      downRef.current = true;
      setPressed(true);
      inRef.current?.();
    })
    .onFinalize(() => {
      if (!downRef.current) return;
      downRef.current = false;
      setPressed(false);
      outRef.current?.();
    }), []);

  const iconColor = disabled ? colors.inkMuted : active ? "#081018" : colors.ink;
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active, disabled }}
        onAccessibilityTap={() => {
          if (disabled) return;
          inRef.current?.();
          outRef.current?.();
        }}
        style={[
          styles.driveAction, style, { width },
          active && styles.driveActionActive, active && activeStyle,
          pressed && !active && styles.pressed,
          disabled && styles.dimmed,
        ]}
      >
        <Icon size={20} color={iconColor} strokeWidth={1.8} />
        <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
      </View>
    </GestureDetector>
  );
}

function DetectionBox({ kind, confidence, rect }: { kind: "fire" | "smoke"; confidence: number; rect: { left: number; top: number; width: number; height: number } }) {
  const color = kind === "fire" ? colors.fire1 : colors.smoke;
  // A box touching the top of the screen would push its label out of view.
  const labelInside = rect.top < 36;
  return (
    <View pointerEvents="none" style={[styles.detBox, { top: rect.top, left: rect.left, width: rect.width, height: rect.height, borderColor: color }]}>
      <Glass radius={10} borderColor={color + "88"} style={[styles.detLabel, labelInside ? styles.detLabelInside : styles.detLabelAbove]}>
        {kind === "fire" ? <FlameIcon size={14} color={color} /> : <SmokeIcon size={14} color={color} />}
        <Text style={[styles.detText, { color }]}>{kind.toUpperCase()}</Text>
        <Text style={styles.detConfidence}>{confidence}%</Text>
      </Glass>
    </View>
  );
}

/** The camera layer on its own, so a drive input or a telemetry packet never
 * re-renders the video. Only a stream change or a state change does. */
const CameraFeed = memo(function CameraFeed({
  streamUrl, streamAttempt, cameraUrl, cameraState, connected, onLoad, onError, onStreamError, onFrameSize, onOpenSettings,
}: {
  streamUrl: string;
  streamAttempt: number;
  cameraUrl: string;
  cameraState: string;
  connected: boolean;
  onLoad: () => void;
  onError: () => void;
  onStreamError: () => void;
  onFrameSize: (width: number, height: number) => void;
  onOpenSettings: () => void;
}) {
  // Polled fallback, for a camera URL with no stream beside it. Two image layers,
  // swapped: on Android an Image blanks itself while its URL changes, so each new
  // frame loads into the hidden layer and only comes forward once it has loaded.
  const [layers, setLayers] = useState<[string, string]>(["", ""]);
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);

  useEffect(() => {
    if (!cameraUrl) {
      setLayers(["", ""]);
      return;
    }
    setLayers(current => {
      const next: [string, string] = [current[0], current[1]];
      next[1 - frontRef.current] = cameraUrl;
      return next;
    });
  }, [cameraUrl]);

  const onLayerLoad = (index: number, width?: number, height?: number) => {
    // A layer finishing an older request must not jump in front of a newer frame.
    if (layers[index] !== cameraUrl) return;
    frontRef.current = index;
    setFront(index);
    if (width && height) onFrameSize(width, height);
    onLoad();
  };
  const onLayerError = (index: number) => {
    if (layers[index] === cameraUrl) onError();
  };

  const showing = Boolean(streamUrl || cameraUrl);

  return (
    <>
      {streamUrl ? (
        <LiveStream key={streamAttempt} url={streamUrl} onLive={onLoad} onError={onStreamError} onFrameSize={onFrameSize} />
      ) : cameraUrl ? (
        <View style={StyleSheet.absoluteFill} accessible accessibilityLabel="Live rover camera">
          {layers.map((uri, index) => (uri ? (
            <Image
              key={index}
              source={{ uri }}
              // Both layers stay opaque; the front one simply sits on top.
              style={[StyleSheet.absoluteFill, { zIndex: index === front ? 2 : 1 }]}
              resizeMode="cover"
              fadeDuration={0}
              onLoad={event => onLayerLoad(index, event.nativeEvent.source?.width, event.nativeEvent.source?.height)}
              onError={() => onLayerError(index)}
            />
          ) : null))}
        </View>
      ) : (
        <View style={styles.cameraOffline}>
          <Text style={styles.offlineTitle}>{connected ? "Loading Pi camera" : "Rover offline"}</Text>
          <Text style={styles.offlineSub}>{connected ? "Waiting for the first frame" : "Enter the Pi's address and token in Settings, then connect."}</Text>
          {!connected && (
            <Pressable accessibilityRole="button" onPress={onOpenSettings} style={({ pressed }) => [styles.offlineBtn, pressed && styles.pressed]}>
              <Text style={styles.offlineBtnText}>Open Settings</Text>
            </Pressable>
          )}
        </View>
      )}
      <LinearGradient colors={["rgba(0,0,0,0.55)", "transparent", "rgba(0,0,0,0.75)"]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {showing && cameraState === "loading" && (
        <View style={styles.cameraError} pointerEvents="none">
          <Text style={styles.offlineTitle}>Connecting to the Pi camera</Text>
        </View>
      )}
      {showing && cameraState === "error" && (
        <View style={styles.cameraError} pointerEvents="none">
          <Text style={styles.offlineTitle}>Pi camera unavailable</Text>
          <Text style={styles.offlineSub}>Retrying. Check that the rover is running and on the same Wi-Fi.</Text>
        </View>
      )}
    </>
  );
});

function StatusPill({ telemetry, connected, compact }: { telemetry: RobotTelemetry; connected: boolean; compact: boolean }) {
  const gap = compact ? 7 : 10;
  return (
    <Glass radius={999} style={[styles.statusPill, { gap, paddingHorizontal: compact ? 10 : 14 }]}>
      <View style={styles.statusItem} accessibilityLabel={`Signal ${readout(telemetry.signalDb, " decibels")}`}>
        <SignalIcon size={16} color={connected ? colors.cyan : colors.inkMuted} />
        <Text style={styles.stat}>{telemetry.signalDb === VALUE_UNAVAILABLE ? "—" : telemetry.signalDb}{!compact && <Text style={styles.unit}>dB</Text>}</Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.statusItem} accessibilityLabel={`Battery ${readout(telemetry.batteryPercent, " percent")}`}>
        <BatteryIcon size={16} color={telemetry.batteryPercent === VALUE_UNAVAILABLE ? colors.inkMuted : colors.mint} />
        <Text style={styles.stat}>{telemetry.batteryPercent === VALUE_UNAVAILABLE ? "—" : telemetry.batteryPercent}<Text style={styles.unit}>%</Text></Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.statusItem} accessibilityLabel={telemetry.gpsLocked ? "GPS locked" : "No GPS"}>
        <GpsIcon size={16} color={telemetry.gpsLocked ? colors.cyan : colors.inkMuted} />
        {!compact && <Text style={styles.unit}>{telemetry.gpsLocked ? "GPS" : "NO GPS"}</Text>}
      </View>
      <View style={styles.sep} />
      <View style={styles.statusItem} accessibilityLabel={telemetry.detectorActive ? "Fire model running" : "Fire model off"}>
        <FlameIcon size={16} color={telemetry.detectorActive ? colors.fire1 : colors.inkMuted} />
        <Text style={[styles.link, { color: telemetry.detectorActive ? colors.fire1 : colors.inkMuted }]}>{telemetry.detectorActive ? "AI" : "NO AI"}</Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.statusItem} accessibilityLabel={connected ? "Rover linked" : "Rover offline"}>
        <RecordIcon size={16} color={connected ? colors.mint : colors.fire1} />
        <Text style={[styles.link, { color: connected ? colors.mint : colors.fire1 }]}>{connected ? "LINK" : "OFF"}</Text>
      </View>
    </Glass>
  );
}

type DriveHudHandle = { show: (throttle: number, steering: number, mode: DriveMode) => void };

/** Left and right wheel bars for the command being sent right now.
 *
 * Tank drive is hard to picture from a stick position; the two bars show what
 * each side is being told to do, using the same mix the Pi applies. It updates
 * through a handle so a drag re-renders only these bars, not the whole cockpit.
 */
const DriveHud = forwardRef<DriveHudHandle, { height: number; disabled: boolean }>(function DriveHud({ height, disabled }, ref) {
  const [state, setState] = useState<{ left: number; right: number; mode: DriveMode }>({ left: 0, right: 0, mode: "DRIVE" });
  useImperativeHandle(ref, () => ({
    show: (throttle, steering, mode) => {
      const mix = wheelMix(throttle, steering);
      // Two decimals is finer than a bar can show; it skips renders for jitter.
      const left = Math.round(mix.left * 50) / 50;
      const right = Math.round(mix.right * 50) / 50;
      setState(current => (current.left === left && current.right === right && current.mode === mode ? current : { left, right, mode }));
    },
  }), []);
  const sprint = state.mode === "SPRINT" || state.mode === "CRUISE";

  const half = height / 2;
  const forwardColor = sprint ? colors.cyan : colors.mint;
  const bar = (value: number, label: string) => (
    <View style={styles.hudColumn}>
      <View style={[styles.hudTrack, { height }]}>
        <View style={[styles.hudCentre, { top: half - 1 }]} />
        {value > 0 && <View style={[styles.hudFill, { bottom: half, height: value * half, backgroundColor: forwardColor }]} />}
        {value < 0 && <View style={[styles.hudFill, { top: half, height: -value * half, backgroundColor: colors.fire1 }]} />}
      </View>
      <Text style={styles.hudLabel}>{label}</Text>
    </View>
  );

  return (
    <Glass
      radius={16}
      style={[styles.hud, disabled && styles.dimmed]}
      borderColor={state.mode === "REVERSE" ? "rgba(255,107,53,0.6)" : sprint ? "rgba(76,201,240,0.55)" : undefined}
    >
      <View
        accessible
        accessibilityLabel={`Wheel command: left ${Math.round(state.left * 100)} percent, right ${Math.round(state.right * 100)} percent, ${state.mode.toLowerCase()}`}
        style={styles.hudBars}
      >
        {bar(state.left, "L")}
        {bar(state.right, "R")}
      </View>
      <Text style={[styles.hudMode, { color: state.mode === "REVERSE" ? colors.fire1 : sprint ? colors.cyan : colors.inkMuted }]}>{state.mode}</Text>
    </Glass>
  );
});

function AlertBanner({ alert, now, showLocation, onDismiss, onMap }: { alert: Detection; now: number; showLocation: boolean; onDismiss: () => void; onMap: () => void }) {
  const fire = alert.kind === "fire";
  return (
    <Glass radius={radius.panel} glow={fire ? colors.fire2 : colors.smoke} borderColor={fire ? "rgba(255,107,53,0.55)" : "rgba(185,196,221,0.5)"} style={styles.banner}>
      <View style={styles.bannerRow}>
        <LinearGradient colors={fire ? [colors.fire1, colors.fire2] : [colors.smoke, "#71809b"]} style={styles.bannerIcon}>
          {fire ? <FlameIcon size={22} color="#fff" /> : <SmokeIcon size={22} color="#fff" />}
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <View style={styles.bannerTitleRow}>
            <Text style={styles.bannerTitle}>{fire ? "Fire Detected" : "Smoke Detected"}</Text>
            {alert.confirmedBySensor && <View style={styles.sensorBadge}><Text style={styles.sensorText}>SENSOR CONFIRMED</Text></View>}
          </View>
          <Text style={styles.bannerSub} numberOfLines={1}>{alert.confidence}% confidence{showLocation ? `, ${alert.location}` : ""} · {relativeTime(alert, now)}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss alert" onPress={onDismiss} hitSlop={12}><CloseIcon size={18} color={colors.inkMuted} /></Pressable>
      </View>
      <Pressable accessibilityRole="button" onPress={onMap} style={({ pressed }) => [styles.bannerMapBtn, pressed && styles.pressed]}>
        <LinearGradient colors={[colors.fire1, colors.fire2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtn}>
          <Text style={styles.primaryText}>View on Map</Text>
        </LinearGradient>
      </Pressable>
    </Glass>
  );
}

export default function ControlScreen({ landscape = false, onNavigate }: { landscape?: boolean; onNavigate: (tab: AppTab) => void }) {
  // What the buttons show; the refs below are what the drive command is built from.
  const [pedalView, setPedalView] = useState<Pedals & { sprint: boolean }>({ accel: false, brake: false, cruise: false, sprint: false });
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // The rover's frame is 16:9 at every quality setting; the stream reports the
  // real size on its first frame and this is replaced then.
  const [frameSize, setFrameSize] = useState<Size>({ width: 1280, height: 720 });
  const { width, height } = useWindowDimensions();
  const [viewSize, setViewSize] = useState<Size>({ width, height });
  const insets = useScreenInsets(landscape);
  const {
    activeDetection, brake, cameraUrl, connectionState, detections, drive, streamUrl, streamAttempt,
    cameraState, controlNotice, onCameraLoad, onCameraError, onStreamError, overlay, setDeviceAction, setOverlay, settings, telemetry,
  } = useRobot();

  const connected = connectionState === "connected";
  const alert = settings.showAlerts && activeDetection?.id !== dismissedId ? activeDetection : null;
  // Device state comes from the rover, never from the last button press, so an
  // unwired pin or an auto-siren timing out is shown as it really is.
  const flash = telemetry.flashOn;
  const siren = telemetry.sirenOn;

  // Boxes must leave the feed once the model stops seeing them, so the clock
  // runs while there is anything that could expire.
  useEffect(() => {
    if (detections.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [detections.length]);
  const liveBoxes = useMemo(
    () => liveDetections(detections, now, liveBoxWindowMs(telemetry.inferenceMs)),
    [detections, now, telemetry.inferenceMs],
  );

  // The stick and the pedal buttons are inputs to one drive command. Refs hold the
  // live values so a press handler never sends a stale vector.
  const stick = useRef({ throttle: 0, steering: 0 });
  const pedals = useRef<Pedals>({ accel: false, brake: false, cruise: false });
  const sprintRef = useRef(false);
  const hud = useRef<DriveHudHandle>(null);

  const showPedals = useCallback(() => {
    setPedalView({ ...pedals.current, sprint: sprintRef.current });
  }, []);

  const pushDrive = useCallback(() => {
    const throttle = combinedThrottle(stick.current.throttle, pedalThrottle(pedals.current));
    const steering = stick.current.steering;
    drive(throttle, steering, sprintRef.current);
    hud.current?.show(throttle, steering, driveMode(pedals.current, sprintRef.current));
  }, [drive]);

  const onStickMove = useCallback((throttle: number, steering: number) => {
    stick.current = { throttle, steering };
    pushDrive();
  }, [pushDrive]);

  const resetCockpit = useCallback(() => {
    stick.current = { throttle: 0, steering: 0 };
    pedals.current = { accel: false, brake: false, cruise: false };
    sprintRef.current = false;
  }, []);

  // Switching tabs unmounts the stick and buttons mid-gesture, and their release
  // never fires. Without this the last command, or a cruise, would keep being
  // refreshed, and the car with it.
  useEffect(() => () => {
    resetCockpit();
    drive(0, 0, false);
  }, [drive, resetCockpit]);

  // A dropped link resets the session's command; reset the cockpit to match, so
  // reconnecting never resumes cruising or with a pedal still lit.
  useEffect(() => {
    if (connected) return;
    resetCockpit();
    showPedals();
    hud.current?.show(0, 0, "DRIVE");
  }, [connected, resetCockpit, showPedals]);

  const notConnectedNotice = useCallback(() => {
    Alert.alert("Rover not connected", "Open Settings, enter the Raspberry Pi address and token, then connect to drive.");
  }, []);

  /** The hard stop: zero everything and have the rover short the motors. */
  const hardBrake = () => {
    stick.current = { throttle: 0, steering: 0 };
    pedals.current.cruise = false;
    sprintRef.current = false;
    showPedals();
    brake();
    hud.current?.show(0, 0, "DRIVE");
  };

  const onAccelIn = () => {
    pedals.current.accel = true;
    // ACCEL with SPRINT on latches cruise: the car keeps going forward when the
    // thumb comes off, until BRAKE, SPRINT off or a lost link.
    if (sprintRef.current && !pedals.current.brake) pedals.current.cruise = true;
    showPedals();
    pushDrive();
  };

  const onAccelOut = () => {
    pedals.current.accel = false;
    showPedals();
    // Letting go of ACCEL while still holding BRAKE ends a reverse in a stop.
    if (pedals.current.brake) hardBrake();
    else pushDrive();
  };

  // Sprint latches on a tap. Holding it needed a third thumb: one on the stick,
  // one on ACCEL, and none left for SPRINT.
  const onSprintTap = () => {
    sprintRef.current = !sprintRef.current;
    if (!sprintRef.current) pedals.current.cruise = false;
    else if (pedals.current.accel && !pedals.current.brake) pedals.current.cruise = true;
    showPedals();
    pushDrive();
  };

  const onBrakeIn = () => {
    pedals.current.brake = true;
    pedals.current.cruise = false;
    sprintRef.current = false;
    if (pedals.current.accel) {
      // ACCEL and BRAKE together: reverse, for as long as both are held.
      showPedals();
      pushDrive();
    } else {
      hardBrake();
    }
  };

  const onBrakeOut = () => {
    pedals.current.brake = false;
    showPedals();
    // Still holding ACCEL: back to forward. Otherwise the brake is already done.
    if (pedals.current.accel) pushDrive();
  };

  // Controls scale with the screen so the cockpit fits small phones and tablets.
  const shortEdge = Math.min(width, height);
  const stickSize = Math.max(132, Math.min(200, shortEdge * 0.44));
  const actionWidth = Math.max(72, Math.min(104, shortEdge * 0.22));
  const compactStatus = width < 400;

  // The button lights up when the rover's telemetry confirms the change.
  const toggleDevice = (device: "flash" | "siren", next: boolean) => {
    if (!setDeviceAction(device, next)) {
      Alert.alert("Rover not connected", "Connect to the rover in Settings before using the on-board devices.");
    }
  };

  // The siren is physically loud, so arming it is confirmed; silencing it never is.
  const onSirenPress = () => {
    if (siren) {
      toggleDevice("siren", false);
      return;
    }
    if (!connected) {
      Alert.alert("Rover not connected", "Connect to the rover in Settings before using the on-board devices.");
      return;
    }
    Alert.alert("Sound the siren?", "This sounds the rover's siren until you switch it off.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sound siren", style: "destructive", onPress: () => toggleDevice("siren", true) },
    ]);
  };

  const openSettings = useCallback(() => onNavigate("settings"), [onNavigate]);
  const onFrameSize = useCallback((frameWidth: number, frameHeight: number) => {
    setFrameSize(current => (current.width === frameWidth && current.height === frameHeight ? current : { width: frameWidth, height: frameHeight }));
  }, []);
  const onRootLayout = useCallback((event: LayoutChangeEvent) => {
    const { width: viewWidth, height: viewHeight } = event.nativeEvent.layout;
    setViewSize({ width: viewWidth, height: viewHeight });
  }, []);

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      <CameraFeed
        streamUrl={streamUrl}
        streamAttempt={streamAttempt}
        cameraUrl={cameraUrl}
        cameraState={cameraState}
        connected={connected}
        onLoad={onCameraLoad}
        onError={onCameraError}
        onStreamError={onStreamError}
        onFrameSize={onFrameSize}
        onOpenSettings={openSettings}
      />

      {/* The rover draws boxes onto its own video, so they only come from here for
          a camera that is not the rover's. */}
      {overlay && !streamUrl && liveBoxes.map(detection => (
        <DetectionBox key={detection.id} kind={detection.kind} confidence={detection.confidence} rect={boxOnScreen(detection.boundingBox!, frameSize, viewSize)} />
      ))}

      <View style={[styles.top, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <View style={styles.brandMark}><AgniMark size={30} /></View>
          <View style={styles.pillWrap} pointerEvents="box-none">
            <StatusPill telemetry={telemetry} connected={connected} compact={compactStatus} />
          </View>
        </View>

        <View style={styles.utilRow} pointerEvents="box-none">
          {connected && controlNotice && (
            // The rover gives the controls to one device at a time. Without this the
            // stick would look broken here while someone else drives. BRAKE still works.
            <Glass radius={999} style={styles.motorsOff} borderColor="rgba(255,107,53,0.55)">
              <Text style={styles.motorsOffText}>{controlNotice.toUpperCase()}</Text>
            </Glass>
          )}
          {connected && !telemetry.motorOutput && (
            // Without this the stick looks broken: commands arrive, the wheels stay still.
            <Glass radius={999} style={styles.motorsOff} borderColor="rgba(255,107,53,0.55)">
              <Text style={styles.motorsOffText}>MOTORS OFF ON ROVER</Text>
            </Glass>
          )}
          {/* Only a device with a wired pin gets a button. */}
          {telemetry.flashAvailable && (
            <IconToggle
              Icon={FlashlightIcon}
              label={flash ? "Turn rover flashlight off" : "Turn rover flashlight on"}
              active={flash}
              disabled={!connected}
              onPress={() => toggleDevice("flash", !flash)}
            />
          )}
          {telemetry.sirenAvailable && (
            <IconToggle Icon={SirenIcon} label={siren ? "Silence rover siren" : "Sound rover siren"} active={siren} disabled={!connected} onPress={onSirenPress} />
          )}
          <IconToggle Icon={ArIcon} label={overlay ? "Hide detection boxes" : "Show detection boxes"} active={overlay} onPress={() => setOverlay(!overlay)} />
        </View>

        {alert && (
          <View style={styles.bannerWrap}>
            <AlertBanner
              alert={alert}
              now={now}
              showLocation={settings.showLocation}
              onDismiss={() => setDismissedId(alert.id)}
              onMap={() => onNavigate("map")}
            />
          </View>
        )}
      </View>

      <View
        style={[styles.bottom, { paddingLeft: landscape ? insets.left : 20, paddingRight: landscape ? insets.right + 4 : 20, paddingBottom: insets.bottom }]}
        pointerEvents="box-none"
      >
        <Joystick disabled={!connected} size={stickSize} onMove={onStickMove} onBlocked={notConnectedNotice} />
        <View style={styles.rightControls} pointerEvents="box-none">
          <DriveHud ref={hud} height={actionWidth * 1.15} disabled={!connected} />
          <View style={styles.actionStack}>
            <DriveAction
              Icon={AcceleratorIcon}
              label={pedalView.cruise ? "CRUISE" : "ACCEL"}
              active={pedalView.accel || pedalView.cruise}
              disabled={!connected}
              onPressIn={onAccelIn}
              onPressOut={onAccelOut}
              style={styles.accelBtn}
              activeStyle={styles.accelBtnActive}
              width={actionWidth}
            />
            <DriveAction
              Icon={SprintIcon}
              label={pedalView.sprint ? "SPRINT ON" : "SPRINT"}
              active={pedalView.sprint}
              disabled={!connected}
              onPressIn={onSprintTap}
              style={styles.sprintBtn}
              activeStyle={styles.sprintBtnActive}
              width={actionWidth}
            />
            <DriveAction
              Icon={BrakeIcon}
              label={pedalView.brake && pedalView.accel ? "REVERSE" : "BRAKE"}
              active={pedalView.brake}
              disabled={!connected}
              onPressIn={onBrakeIn}
              onPressOut={onBrakeOut}
              style={styles.brakeBtn}
              activeStyle={styles.brakeBtnActive}
              width={actionWidth}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#101521" },
  cameraOffline: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", paddingHorizontal: 36, backgroundColor: "#101521" },
  cameraError: { position: "absolute", alignSelf: "center", top: "44%", left: 28, right: 28, maxWidth: 420, alignItems: "center", padding: 16, borderRadius: 16, backgroundColor: "rgba(16,24,39,0.9)", borderWidth: 1, borderColor: "rgba(255,107,53,0.55)", zIndex: 12 },
  offlineTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 18, textAlign: "center" },
  offlineSub: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 13, textAlign: "center", marginTop: 8, lineHeight: 20 },
  offlineBtn: { marginTop: 18, backgroundColor: colors.cyan, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11 },
  offlineBtnText: { color: "#081018", fontFamily: font.sansBold, fontSize: 14 },
  detBox: { position: "absolute", borderWidth: 2, borderRadius: 14, zIndex: 5 },
  detLabel: { position: "absolute", left: -2, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4 },
  detLabelAbove: { top: -32 },
  detLabelInside: { top: 4, left: 4 },
  detText: { fontFamily: font.monoBold, fontSize: 11 },
  detConfidence: { color: colors.ink, fontFamily: font.monoBold, fontSize: 11 },
  top: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 20 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandMark: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(16,24,39,0.9)", borderWidth: 1, borderColor: "rgba(64,196,216,0.6)" },
  pillWrap: { flex: 1, alignItems: "center" },
  statusPill: { flexDirection: "row", alignItems: "center", paddingVertical: 8, flexShrink: 1 },
  statusItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  stat: { color: colors.ink, fontFamily: font.monoBold, fontSize: 12 },
  unit: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 11 },
  link: { fontFamily: font.monoBold, fontSize: 11 },
  sep: { width: 1, height: 16, backgroundColor: "rgba(255,255,255,0.15)" },
  utilRow: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 10 },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  dimmed: { opacity: 0.45 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  motorsOff: { paddingHorizontal: 12, paddingVertical: 8 },
  motorsOffText: { color: colors.fire1, fontFamily: font.monoBold, fontSize: 10, letterSpacing: 0.5 },
  bannerWrap: { marginTop: 10, width: "100%", maxWidth: 460, alignSelf: "center" },
  banner: { padding: 14 },
  bannerTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  sensorBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: "rgba(95,217,164,0.16)", borderWidth: 1, borderColor: "rgba(95,217,164,0.5)" },
  sensorText: { color: colors.mint, fontFamily: font.monoBold, fontSize: 9, letterSpacing: 0.5 },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  bannerIcon: { width: 40, height: 40, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  bannerTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 15 },
  bannerSub: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 12, marginTop: 2 },
  bannerMapBtn: { marginTop: 12 },
  primaryBtn: { borderRadius: radius.button, paddingVertical: 11, alignItems: "center" },
  primaryText: { color: "#fff", fontFamily: font.sansBold, fontSize: 14 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", zIndex: 20 },
  rightControls: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  actionStack: { gap: 8, alignItems: "flex-end" },
  hud: { paddingHorizontal: 9, paddingTop: 10, paddingBottom: 8, alignItems: "center" },
  hudBars: { flexDirection: "row", gap: 9 },
  hudColumn: { alignItems: "center", gap: 4 },
  hudTrack: { width: 10, borderRadius: 5, backgroundColor: "rgba(255,255,255,0.08)", overflow: "hidden" },
  hudCentre: { position: "absolute", left: 0, right: 0, height: 2, backgroundColor: "rgba(255,255,255,0.28)" },
  hudFill: { position: "absolute", left: 0, right: 0, borderRadius: 2 },
  hudLabel: { color: colors.inkMuted, fontFamily: font.monoBold, fontSize: 9 },
  hudMode: { fontFamily: font.monoBold, fontSize: 8, letterSpacing: 0.5, marginTop: 6 },
  driveAction: { height: 52, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  driveActionActive: { borderColor: "rgba(255,255,255,0.35)" },
  accelBtn: { backgroundColor: "rgba(95,217,164,0.2)", borderColor: "rgba(95,217,164,0.55)" },
  accelBtnActive: { backgroundColor: colors.mint },
  sprintBtn: { backgroundColor: "rgba(76,201,240,0.2)", borderColor: "rgba(76,201,240,0.5)" },
  sprintBtnActive: { backgroundColor: colors.cyan },
  brakeBtn: { backgroundColor: "rgba(232,68,44,0.25)", borderColor: "rgba(255,107,53,0.65)" },
  brakeBtnActive: { backgroundColor: colors.fire1 },
  actionLabel: { color: colors.ink, fontFamily: font.monoBold, fontSize: 9 },
  actionLabelActive: { color: "#081018" },
});
