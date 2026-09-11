import Slider from "@react-native-community/slider";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppGround } from "../components/AppGround";
import { Glass } from "../components/Glass";
import { AgniMark, BellIcon, CameraQualityIcon, ChevronIcon, FlameIcon, GaugeIcon, GpsIcon, InfoIcon, SirenIcon, WifiIcon } from "../components/icons";
import { colors, font, radius } from "../theme";
import type { AppTab, CameraQuality } from "../domain/robot";
import { isHttpUrl, isWebSocketUrl } from "../domain/robot";
import { useRobot } from "../features/robot/RobotContext";

function Toggle({ on, onChange, label }: { on: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={() => onChange(!on)}
      style={[styles.toggle, { backgroundColor: on ? colors.cyan : "rgba(255,255,255,0.14)" }]}
    >
      <View style={[styles.knob, { left: on ? 23 : 3 }]} />
    </Pressable>
  );
}

function SettingsRow({ Icon, label, children }: { Icon: typeof BellIcon; label: string; children: React.ReactNode }) {
  return <View style={styles.row}><View style={styles.rowIcon}><Icon size={20} color={colors.cyan} /></View><Text style={styles.rowLabel}>{label}</Text>{children}</View>;
}

export default function SettingsScreen({ landscape = false }: { landscape?: boolean; onNavigate?: (tab: AppTab) => void }) {
  const { connect, connectionMessage, connectionState, disconnect, endpoints, settings, telemetry, updateSettings } = useRobot();
  const [cameraUrl, setCameraUrl] = useState(endpoints.cameraUrl);
  const [websocketUrl, setWebsocketUrl] = useState(endpoints.websocketUrl);
  const [token, setToken] = useState(endpoints.token);
  const [urlError, setUrlError] = useState("");
  const [qualityPicker, setQualityPicker] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Local value keeps the slider smooth; only the released value hits the rover.
  const [sensitivity, setSensitivity] = useState(settings.detectionSensitivity);
  const connected = connectionState === "connected";
  const connecting = connectionState === "connecting";
  const qualities: CameraQuality[] = ["480p", "720p", "1080p"];

  // Reflect endpoints restored from storage, or edited elsewhere.
  useEffect(() => {
    setCameraUrl(endpoints.cameraUrl);
    setWebsocketUrl(endpoints.websocketUrl);
    setToken(endpoints.token);
  }, [endpoints.cameraUrl, endpoints.token, endpoints.websocketUrl]);

  useEffect(() => setSensitivity(settings.detectionSensitivity), [settings.detectionSensitivity]);

  const handleConnect = () => {
    const nextCamera = cameraUrl.trim();
    const nextSocket = websocketUrl.trim();
    if (!isWebSocketUrl(nextSocket)) {
      setUrlError("Control URL must start with ws:// or wss://");
      return;
    }
    if (nextCamera && !isHttpUrl(nextCamera)) {
      setUrlError("Camera URL must start with http:// or https://");
      return;
    }
    setUrlError("");
    connect({ cameraUrl: nextCamera, websocketUrl: nextSocket, token: token.trim() });
  };

  return (
    <AppGround>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 44, paddingBottom: landscape ? 24 : 96, paddingLeft: landscape ? 76 : 16, paddingRight: 16 }}>
        <Text style={styles.h1}>Settings</Text>
        <Text style={styles.sub}>{connected ? `${telemetry.roverName} · field controller` : "Rover not connected"}</Text>

        <Text style={styles.groupTitle}>ROVER CONNECTION</Text>
        <Glass radius={24} style={styles.connectionCard} borderColor={connected ? "rgba(95,217,164,0.55)" : undefined}>
          <View style={styles.connectionHeading}>
            <View style={[styles.connectionDot, { backgroundColor: connected ? colors.mint : connecting ? colors.cyan : colors.fire1 }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.connectionTitle}>{connected ? "Rover connected" : "Raspberry Pi rover"}</Text>
              <Text style={styles.connectionMessage}>{connectionMessage}</Text>
            </View>
          </View>

          <Text style={styles.fieldLabel}>CAMERA FRAME URL</Text>
          <TextInput accessibilityLabel="Camera frame URL" value={cameraUrl} onChangeText={setCameraUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://192.168.1.50:8000/frame.jpg" placeholderTextColor={colors.inkMuted} style={styles.input} />
          <Text style={styles.fieldLabel}>CONTROL WEBSOCKET URL</Text>
          <TextInput accessibilityLabel="Control WebSocket URL" value={websocketUrl} onChangeText={setWebsocketUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="ws://192.168.1.50:8000/control" placeholderTextColor={colors.inkMuted} style={styles.input} />
          <Text style={styles.fieldLabel}>ACCESS TOKEN (ROVER_TOKEN)</Text>
          <TextInput accessibilityLabel="Rover access token" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Leave empty if the rover has no token" placeholderTextColor={colors.inkMuted} style={styles.input} />
          {urlError ? <Text style={styles.errorText}>{urlError}</Text> : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={connected ? "Disconnect rover" : "Connect rover"}
            disabled={connecting}
            onPress={connected ? disconnect : handleConnect}
            style={[styles.connectBtn, connected && styles.disconnectBtn, connecting && styles.disabled]}
          >
            <Text style={styles.connectText}>{connected ? "Disconnect rover" : connecting ? "Connecting..." : "Connect rover"}</Text>
          </Pressable>
          <Text style={styles.hint}>The rover reconnects automatically and remembers these details for next launch.</Text>
        </Glass>

        <Text style={styles.groupTitle}>DETECTION MODEL</Text>
        <Glass radius={24} style={styles.groupCard}>
          <SettingsRow Icon={FlameIcon} label="On-device model">
            <Text style={[styles.value, { color: telemetry.detectorActive ? colors.mint : colors.inkMuted }]}>
              {telemetry.detectorActive ? "Running" : connected ? "Off" : "—"}
            </Text>
          </SettingsRow>
          <View style={styles.separator} />
          <SettingsRow Icon={WifiIcon} label="Inference time">
            <Text style={styles.value}>{telemetry.detectorActive ? `${telemetry.inferenceMs} ms` : "—"}</Text>
          </SettingsRow>
          {telemetry.detectorError ? (
            <>
              <View style={styles.separator} />
              <View style={styles.errorRow}><Text style={styles.errorText}>{telemetry.detectorError}</Text></View>
            </>
          ) : null}
        </Glass>

        <Text style={styles.groupTitle}>DETECTION</Text>
        <Glass radius={24} style={styles.groupCard}>
          <SettingsRow Icon={GaugeIcon} label="Detection sensitivity">
            <View style={styles.sliderRow}>
              <Slider
                accessibilityLabel="Detection sensitivity"
                style={{ flex: 1 }}
                minimumValue={0}
                maximumValue={100}
                value={settings.detectionSensitivity}
                onValueChange={value => setSensitivity(Math.round(value))}
                onSlidingComplete={value => updateSettings({ detectionSensitivity: Math.round(value) })}
                minimumTrackTintColor={colors.fire1}
                maximumTrackTintColor="rgba(255,255,255,0.15)"
                thumbTintColor="#fff"
              />
              <Text style={styles.sliderValue}>{sensitivity}</Text>
            </View>
          </SettingsRow>
          <View style={styles.separator} />
          <SettingsRow Icon={SirenIcon} label="Auto-siren on fire"><Toggle label="Auto-siren on fire" on={settings.autoSiren} onChange={autoSiren => updateSettings({ autoSiren })} /></SettingsRow>
          <View style={styles.separator} />
          <SettingsRow Icon={BellIcon} label="In-app detection alerts"><Toggle label="In-app detection alerts" on={settings.showAlerts} onChange={showAlerts => updateSettings({ showAlerts })} /></SettingsRow>
          <View style={styles.separator} />
          <SettingsRow Icon={GpsIcon} label="Show detection location"><Toggle label="Show detection location" on={settings.showLocation} onChange={showLocation => updateSettings({ showLocation })} /></SettingsRow>
          {connected && telemetry.suppressedDetections > 0 && (
            <>
              <View style={styles.separator} />
              <View style={styles.errorRow}>
                <Text style={styles.hint}>{telemetry.suppressedDetections} low-confidence results filtered out. Raise sensitivity to see more.</Text>
              </View>
            </>
          )}
        </Glass>

        <Text style={styles.groupTitle}>CAMERA</Text>
        <Glass radius={24} style={styles.groupCard}>
          <Pressable accessibilityRole="button" accessibilityLabel="Change camera quality" onPress={() => setQualityPicker(true)}>
            <SettingsRow Icon={CameraQualityIcon} label="Camera quality"><View style={styles.valueRow}><Text style={styles.value}>{settings.cameraQuality}</Text><ChevronIcon size={16} color={colors.inkMuted} /></View></SettingsRow>
          </Pressable>
        </Glass>

        <Text style={styles.groupTitle}>ABOUT</Text>
        <Glass radius={24} style={styles.groupCard}>
          <Pressable accessibilityRole="button" onPress={() => setAboutOpen(true)}>
            <SettingsRow Icon={InfoIcon} label="Agni rover controller"><ChevronIcon size={16} color={colors.inkMuted} /></SettingsRow>
          </Pressable>
        </Glass>
      </ScrollView>

      <Modal visible={qualityPicker} transparent animationType="fade" onRequestClose={() => setQualityPicker(false)}>
        <View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={() => setQualityPicker(false)} /><Glass dim intensity={80} radius={radius.panel} style={styles.modalCard}><Text style={styles.modalTitle}>Camera quality</Text>{qualities.map(quality => <Pressable key={quality} accessibilityRole="button" onPress={() => { updateSettings({ cameraQuality: quality }); setQualityPicker(false); }} style={[styles.option, settings.cameraQuality === quality && styles.optionActive]}><Text style={styles.optionText}>{quality}</Text><Text style={styles.optionMeta}>{quality === "480p" ? "Lower bandwidth" : quality === "720p" ? "Balanced" : "Highest detail"}</Text></Pressable>)}</Glass></View>
      </Modal>

      <Modal visible={aboutOpen} transparent animationType="fade" onRequestClose={() => setAboutOpen(false)}>
        <View style={styles.modalBackdrop}><Pressable style={StyleSheet.absoluteFill} onPress={() => setAboutOpen(false)} /><Glass dim intensity={80} radius={radius.panel} style={styles.modalCard}><View style={styles.aboutHeader}><View style={styles.aboutLogo}><AgniMark size={36} /></View><Text style={[styles.modalTitle, styles.aboutTitle]}>Agni rover controller</Text></View><Text style={styles.aboutText}>Drive the Raspberry Pi rover, watch the live camera, and receive fire and smoke detections from the YOLO model running on the rover itself. The motor link stops automatically if it loses contact.</Text><Pressable accessibilityRole="button" onPress={() => setAboutOpen(false)} style={styles.closeBtn}><Text style={styles.closeText}>Close</Text></Pressable></Glass></View>
      </Modal>
    </AppGround>
  );
}

const styles = StyleSheet.create({
  h1: { color: colors.ink, fontFamily: font.sansBold, fontSize: 26 },
  sub: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 14, marginTop: 2, marginBottom: 24 },
  groupTitle: { color: colors.inkMuted, fontFamily: font.sansBold, fontSize: 11, letterSpacing: 1.5, marginBottom: 8, marginLeft: 4, marginTop: 18 },
  connectionCard: { padding: 16 },
  connectionHeading: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  connectionDot: { width: 10, height: 10, borderRadius: 999 },
  connectionTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 15 },
  connectionMessage: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 12, marginTop: 2 },
  fieldLabel: { color: colors.inkMuted, fontFamily: font.monoBold, fontSize: 10, letterSpacing: 1, marginBottom: 6 },
  input: { color: colors.ink, fontFamily: font.mono, fontSize: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.14)", backgroundColor: "rgba(0,0,0,0.16)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  errorText: { color: colors.fire1, fontFamily: font.sans, fontSize: 12, marginBottom: 10 },
  errorRow: { paddingHorizontal: 16, paddingVertical: 12 },
  connectBtn: { backgroundColor: colors.cyan, borderRadius: 12, alignItems: "center", paddingVertical: 12, marginTop: 2 },
  disconnectBtn: { backgroundColor: "rgba(232,68,44,0.85)" },
  disabled: { opacity: 0.55 },
  connectText: { color: "#081018", fontFamily: font.sansBold, fontSize: 14 },
  hint: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 11, lineHeight: 16, marginTop: 10 },
  groupCard: { overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  separator: { height: 1, marginLeft: 60, backgroundColor: "rgba(255,255,255,0.08)" },
  rowIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(76,201,240,0.12)" },
  rowLabel: { flex: 1, color: colors.ink, fontFamily: font.sans, fontSize: 15 },
  sliderRow: { flexDirection: "row", alignItems: "center", gap: 8, width: 140 },
  sliderValue: { width: 28, textAlign: "right", color: colors.fire1, fontFamily: font.monoBold, fontSize: 12 },
  toggle: { width: 46, height: 26, borderRadius: 999, justifyContent: "center" },
  knob: { position: "absolute", width: 20, height: 20, borderRadius: 999, backgroundColor: "#fff" },
  valueRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  value: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 14 },
  modalBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.78)" },
  modalCard: { width: "100%", maxWidth: 340, padding: 18, backgroundColor: "rgba(11,15,26,0.96)", borderColor: "rgba(255,255,255,0.24)" },
  aboutHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  aboutLogo: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(76,201,240,0.12)", borderWidth: 1, borderColor: "rgba(76,201,240,0.35)" },
  modalTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 18, marginBottom: 14 },
  aboutTitle: { flex: 1, marginBottom: 0 },
  option: { borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", borderRadius: 12, padding: 13, marginBottom: 8 },
  optionActive: { borderColor: colors.cyan, backgroundColor: "rgba(76,201,240,0.12)" },
  optionText: { color: colors.ink, fontFamily: font.sansBold, fontSize: 14 },
  optionMeta: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 12, marginTop: 2 },
  aboutText: { color: colors.ink, fontFamily: font.sans, fontSize: 14, lineHeight: 21 },
  closeBtn: { alignItems: "center", backgroundColor: colors.cyan, borderRadius: 12, paddingVertical: 12, marginTop: 18 },
  closeText: { color: "#081018", fontFamily: font.sansBold, fontSize: 14 },
});
