import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useRef, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { Glass } from "../components/Glass";
import { Joystick } from "../components/Joystick";
import {
  AcceleratorIcon, AgniMark, ArIcon, BatteryIcon, BrakeIcon, CloseIcon, FlameIcon,
  FlashlightIcon, GpsIcon, RecordIcon, SignalIcon, SirenIcon, SmokeIcon,
  SprintIcon,
} from "../components/icons";
import { colors, font, radius } from "../theme";
import type { AppTab, BoundingBox } from "../domain/robot";
import { VALUE_UNAVAILABLE } from "../domain/robot";
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
    >
      <Glass radius={18} glow={active ? colors.cyan : undefined} borderColor={active ? "rgba(76,201,240,0.5)" : undefined} style={[styles.iconBtn, disabled && styles.iconBtnDisabled]}>
        <Icon size={20} color={disabled ? colors.inkMuted : active ? colors.cyan : colors.ink} />
      </Glass>
    </Pressable>
  );
}

function DriveAction({
  Icon,
  active,
  disabled,
  label,
  onPress,
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
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  style: StyleProp<ViewStyle>;
  activeStyle: StyleProp<ViewStyle>;
  width: number;
}) {
  const iconColor = disabled ? colors.inkMuted : active ? "#081018" : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[styles.driveAction, style, { width }, active && styles.driveActionActive, active && activeStyle, disabled && styles.iconBtnDisabled]}
    >
      <Icon size={20} color={iconColor} strokeWidth={1.8} />
      <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function DetectionBox({ kind, confidence, box }: { kind: "fire" | "smoke"; confidence: number; box: BoundingBox }) {
  const color = kind === "fire" ? colors.fire1 : colors.smoke;
  return (
    <View style={[styles.detBox, { top: `${box.top}%`, left: `${box.left}%`, width: `${box.width}%`, height: `${box.height}%`, borderColor: color }]}>
      <Glass radius={10} borderColor={color + "88"} style={styles.detLabel}>
        {kind === "fire" ? <FlameIcon size={14} color={color} /> : <SmokeIcon size={14} color={color} />}
        <Text style={[styles.detText, { color }]}>{kind.toUpperCase()}</Text>
        <Text style={styles.detConfidence}>{confidence}%</Text>
      </Glass>
    </View>
  );
}

export default function ControlScreen({ landscape = false, onNavigate }: { landscape?: boolean; onNavigate: (tab: AppTab) => void }) {
  const [ar, setAr] = useState(true);
  const [flash, setFlash] = useState(false);
  const [siren, setSiren] = useState(false);
  const [sprint, setSprint] = useState(false);
  const [accelerating, setAccelerating] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const { width, height } = useWindowDimensions();
  const {
    activeDetection, brake, cameraUrl, connectionState, detections, drive,
    cameraState, onCameraLoad, onCameraError, setDeviceAction, settings, telemetry,
  } = useRobot();

  const connected = connectionState === "connected";
  const alert = settings.showAlerts && activeDetection?.id !== dismissedId ? activeDetection : null;

  // The stick, the accelerator and sprint are three inputs to one drive command.
  // Refs hold the live values so a press handler never sends a stale vector.
  const stick = useRef({ throttle: 0, steering: 0 });
  const accelRef = useRef(false);
  const sprintRef = useRef(false);

  const pushDrive = useCallback(() => {
    const { throttle, steering } = stick.current;
    // The accelerator adds forward drive, so you can hold a turn on the stick
    // and accelerate through it with the other thumb.
    const combined = Math.max(-1, Math.min(1, throttle + (accelRef.current ? 1 : 0)));
    drive(combined, steering, sprintRef.current);
  }, [drive]);

  const onStickMove = useCallback((throttle: number, steering: number) => {
    stick.current = { throttle, steering };
    pushDrive();
  }, [pushDrive]);

  const notConnectedNotice = useCallback(() => {
    Alert.alert("Rover not connected", "Open Settings, enter the Raspberry Pi URLs and token, then connect to drive.");
  }, []);

  const setAccelerate = (next: boolean) => {
    accelRef.current = next;
    setAccelerating(next);
    pushDrive();
  };

  const setSprintMode = (next: boolean) => {
    sprintRef.current = next;
    setSprint(next);
    pushDrive();
  };

  const onBrake = () => {
    stick.current = { throttle: 0, steering: 0 };
    accelRef.current = false;
    sprintRef.current = false;
    setAccelerating(false);
    setSprint(false);
    brake();
  };

  // Controls scale with the screen so the cockpit fits small phones and tablets.
  const shortEdge = Math.min(width, height);
  const stickSize = Math.max(132, Math.min(190, shortEdge * 0.44));
  const actionWidth = Math.max(72, Math.min(104, shortEdge * 0.22));

  const toggleDevice = (device: "flash" | "siren", next: boolean, apply: (value: boolean) => void) => {
    if (!setDeviceAction(device, next)) {
      Alert.alert("Rover not connected", "Connect to the rover in Settings before using the on-board devices.");
      return;
    }
    apply(next);
  };

  // The siren is physically loud, so arming it is confirmed; silencing it never is.
  const onSirenPress = () => {
    if (siren) {
      toggleDevice("siren", false, setSiren);
      return;
    }
    if (!connected) {
      Alert.alert("Rover not connected", "Connect to the rover in Settings before using the on-board devices.");
      return;
    }
    Alert.alert("Sound the siren?", "This sounds the rover's siren until you switch it off.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sound siren", style: "destructive", onPress: () => toggleDevice("siren", true, setSiren) },
    ]);
  };

  return (
    <View style={styles.root}>
      {cameraUrl ? (
        <Image source={{ uri: cameraUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" onLoad={onCameraLoad} onError={onCameraError} accessibilityLabel="Live rover camera" />
      ) : (
        <View style={styles.cameraOffline}>
          <Text style={styles.offlineTitle}>{connected ? "Loading Pi camera" : "Rover offline"}</Text>
          <Text style={styles.offlineSub}>{connected ? "Waiting for /frame.jpg" : "Open Settings, enter the Pi URLs, then connect."}</Text>
        </View>
      )}
      <LinearGradient colors={["rgba(0,0,0,0.55)", "transparent", "rgba(0,0,0,0.75)"]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {cameraState === "error" && <View style={styles.cameraError}><Text style={styles.offlineTitle}>Pi camera unavailable</Text><Text style={styles.offlineSub}>Check the frame URL and that the rover is on the same Wi-Fi.</Text></View>}

      {ar && detections.filter(detection => detection.boundingBox).map(detection => (
        <DetectionBox key={detection.id} kind={detection.kind} confidence={detection.confidence} box={detection.boundingBox!} />
      ))}

      <View style={[styles.brandMark, { left: landscape ? 76 : 16 }]}><AgniMark size={32} /></View>
      <View style={[styles.top, { paddingLeft: landscape ? 76 : 16 }]}>
        <Glass radius={999} style={styles.statusPill}>
          <View style={styles.statusItem} accessibilityLabel={`Signal ${readout(telemetry.signalDb, " decibels")}`}>
            <SignalIcon size={16} color={connected ? colors.cyan : colors.inkMuted} />
            <Text style={styles.stat}>{telemetry.signalDb === VALUE_UNAVAILABLE ? "—" : telemetry.signalDb}<Text style={styles.unit}>dB</Text></Text>
          </View>
          <View style={styles.sep} />
          <View style={styles.statusItem} accessibilityLabel={`Battery ${readout(telemetry.batteryPercent, " percent")}`}>
            <BatteryIcon size={16} color={telemetry.batteryPercent === VALUE_UNAVAILABLE ? colors.inkMuted : colors.mint} />
            <Text style={styles.stat}>{telemetry.batteryPercent === VALUE_UNAVAILABLE ? "—" : telemetry.batteryPercent}<Text style={styles.unit}>%</Text></Text>
          </View>
          <View style={styles.sep} />
          <View style={styles.statusItem}><GpsIcon size={16} color={telemetry.gpsLocked ? colors.cyan : colors.inkMuted} /><Text style={styles.unit}>{telemetry.gpsLocked ? "GPS" : "NO GPS"}</Text></View>
          <View style={styles.sep} />
          <View style={styles.statusItem} accessibilityLabel={telemetry.detectorActive ? "Fire model running" : "Fire model off"}>
            <FlameIcon size={16} color={telemetry.detectorActive ? colors.fire1 : colors.inkMuted} />
            <Text style={[styles.link, { color: telemetry.detectorActive ? colors.fire1 : colors.inkMuted }]}>{telemetry.detectorActive ? "AI" : "NO AI"}</Text>
          </View>
          <View style={styles.sep} />
          <View style={styles.statusItem}><RecordIcon size={16} color={connected ? colors.mint : colors.fire1} /><Text style={[styles.link, { color: connected ? colors.mint : colors.fire1 }]}>{connected ? "LINK" : "OFF"}</Text></View>
        </Glass>
        <View style={styles.utilRow}>
          <IconToggle
            Icon={FlashlightIcon}
            label={flash ? "Turn rover flashlight off" : "Turn rover flashlight on"}
            active={flash}
            disabled={!connected}
            onPress={() => toggleDevice("flash", !flash, setFlash)}
          />
          <IconToggle Icon={SirenIcon} label={siren ? "Silence rover siren" : "Sound rover siren"} active={siren} disabled={!connected} onPress={onSirenPress} />
          <IconToggle Icon={ArIcon} label={ar ? "Hide detection overlay" : "Show detection overlay"} active={ar} onPress={() => setAr(value => !value)} />
        </View>
      </View>

      {alert && (
        <Glass radius={radius.panel} glow={alert.kind === "fire" ? colors.fire2 : colors.smoke} borderColor={alert.kind === "fire" ? "rgba(255,107,53,0.55)" : "rgba(185,196,221,0.5)"} style={[styles.banner, { left: landscape ? 76 : 16, right: 16 }]}>
          <View style={styles.bannerRow}>
            <LinearGradient colors={alert.kind === "fire" ? [colors.fire1, colors.fire2] : [colors.smoke, "#71809b"]} style={styles.bannerIcon}>
              {alert.kind === "fire" ? <FlameIcon size={24} color="#fff" /> : <SmokeIcon size={24} color="#fff" />}
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <View style={styles.bannerTitleRow}>
                <Text style={styles.bannerTitle}>{alert.kind === "fire" ? "Fire Detected" : "Smoke Detected"}</Text>
                {alert.confirmedBySensor && <View style={styles.sensorBadge}><Text style={styles.sensorText}>SENSOR CONFIRMED</Text></View>}
              </View>
              <Text style={styles.bannerSub}>{alert.confidence}% confidence{settings.showLocation ? `, ${alert.location}` : ""}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Dismiss alert" onPress={() => setDismissedId(alert.id)} hitSlop={10}><CloseIcon size={18} color={colors.inkMuted} /></Pressable>
          </View>
          <View style={styles.bannerButtons}>
            <Pressable onPress={() => onNavigate("map")} style={{ flex: 1 }}><LinearGradient colors={[colors.fire1, colors.fire2]} style={styles.primaryBtn}><Text style={styles.primaryText}>View on Map</Text></LinearGradient></Pressable>
            <Pressable onPress={() => setDismissedId(alert.id)} style={{ flex: 1 }}><Glass radius={radius.button} dim style={styles.dismissBtn}><Text style={styles.primaryText}>Dismiss</Text></Glass></Pressable>
          </View>
        </Glass>
      )}

      <View style={[styles.bottom, { paddingLeft: landscape ? 84 : 20, paddingBottom: landscape ? 20 : 96 }]}>
        <Joystick disabled={!connected} size={stickSize} onMove={onStickMove} onBlocked={notConnectedNotice} />
        <View style={styles.rightControls}>
          <View style={styles.actionStack}>
            <DriveAction
              Icon={AcceleratorIcon}
              label="ACCEL"
              active={accelerating}
              disabled={!connected}
              onPressIn={() => setAccelerate(true)}
              onPressOut={() => setAccelerate(false)}
              style={styles.accelBtn}
              activeStyle={styles.accelBtnActive}
              width={actionWidth}
            />
            <DriveAction
              Icon={SprintIcon}
              label="SPRINT"
              active={sprint}
              disabled={!connected}
              onPressIn={() => setSprintMode(true)}
              onPressOut={() => setSprintMode(false)}
              style={styles.sprintBtn}
              activeStyle={styles.sprintBtnActive}
              width={actionWidth}
            />
            <DriveAction
              Icon={BrakeIcon}
              label="BRAKE"
              disabled={!connected}
              onPress={onBrake}
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
  cameraError: { position: "absolute", alignSelf: "center", top: "44%", left: 28, right: 28, alignItems: "center", padding: 16, borderRadius: 16, backgroundColor: "rgba(16,24,39,0.9)", borderWidth: 1, borderColor: "rgba(255,107,53,0.55)", zIndex: 12 },
  offlineTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 18, textAlign: "center" },
  offlineSub: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 13, textAlign: "center", marginTop: 8, lineHeight: 20 },
  detBox: { position: "absolute", borderWidth: 2, borderRadius: 16, zIndex: 5 },
  detLabel: { position: "absolute", top: -34, left: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4 },
  detText: { fontFamily: font.monoBold, fontSize: 11 },
  detConfidence: { color: colors.ink, fontFamily: font.monoBold, fontSize: 11 },
  top: { position: "absolute", top: 0, left: 0, right: 0, paddingRight: 16, paddingTop: 44, zIndex: 20 },
  brandMark: { position: "absolute", top: 44, width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(16,24,39,0.9)", borderWidth: 1, borderColor: "rgba(64,196,216,0.6)", zIndex: 30 },
  statusPill: { alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  statusItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  stat: { color: colors.ink, fontFamily: font.monoBold, fontSize: 12 },
  unit: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 11 },
  link: { fontFamily: font.monoBold, fontSize: 11 },
  sep: { width: 1, height: 16, backgroundColor: "rgba(255,255,255,0.15)" },
  utilRow: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconBtnDisabled: { opacity: 0.45 },
  bannerTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  sensorBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: "rgba(95,217,164,0.16)", borderWidth: 1, borderColor: "rgba(95,217,164,0.5)" },
  sensorText: { color: colors.mint, fontFamily: font.monoBold, fontSize: 9, letterSpacing: 0.5 },
  banner: { position: "absolute", top: 112, padding: 16, zIndex: 30 },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  bannerIcon: { width: 44, height: 44, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  bannerTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 15 },
  bannerSub: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 12, marginTop: 2 },
  bannerButtons: { flexDirection: "row", gap: 8, marginTop: 12 },
  primaryBtn: { borderRadius: radius.button, paddingVertical: 12, alignItems: "center" },
  dismissBtn: { paddingVertical: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontFamily: font.sansBold, fontSize: 14 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingRight: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", zIndex: 20 },
  rightControls: { flexDirection: "row", alignItems: "flex-end", gap: 14 },
  actionStack: { gap: 8, alignItems: "flex-end" },
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
