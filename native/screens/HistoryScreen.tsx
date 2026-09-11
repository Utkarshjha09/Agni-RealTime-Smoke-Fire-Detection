import { useEffect, useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { AppGround } from "../components/AppGround";
import { Glass } from "../components/Glass";
import { BellIcon, CloseIcon, FlameIcon, MapPinIcon, SmokeIcon } from "../components/icons";
import { colors, font, radius } from "../theme";
import type { AppTab, Detection } from "../domain/robot";
import { detectionColor, detectionLabel, relativeTime } from "../domain/detectionView";
import { useRobot } from "../features/robot/RobotContext";

const filters = ["All", "Fire", "Smoke"] as const;
type Filter = (typeof filters)[number];

function KindIcon({ kind, size, color }: { kind: Detection["kind"]; size: number; color: string }) {
  return kind === "fire" ? <FlameIcon size={size} color={color} /> : <SmokeIcon size={size} color={color} />;
}

export default function HistoryScreen({ landscape = false, onNavigate }: { landscape?: boolean; onNavigate?: (tab: AppTab) => void }) {
  const { clearDetections, connectionState, connectionMessage, detections, settings } = useRobot();
  const [filter, setFilter] = useState<Filter>("All");
  const [selected, setSelected] = useState<Detection | null>(null);
  const [now, setNow] = useState(Date.now());
  const { width } = useWindowDimensions();
  // One column on a phone, more as the screen gets wider, so cards never squash.
  const columns = Math.max(1, Math.min(3, Math.floor((width - 32) / 300)));
  const cardWidth = columns === 1 ? "100%" : `${100 / columns - 1.5}%`;

  // Keeps "2 min ago" honest while the screen is open.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  const shown = useMemo(
    () => detections.filter(detection => filter === "All" || detectionLabel(detection.kind) === filter),
    [detections, filter],
  );
  const connected = connectionState === "connected";

  return (
    <AppGround>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: 44, paddingBottom: landscape ? 24 : 96, paddingLeft: landscape ? 76 : 16, paddingRight: 16 }}
      >
        <View style={styles.headRow}>
          <Text style={styles.h1}>Alerts</Text>
          <Text style={styles.count}>{shown.length} {shown.length === 1 ? "event" : "events"}</Text>
        </View>
        <Text style={styles.sub}>
          {connected ? "Live detection timeline" : "Detection timeline · rover offline"}
        </Text>

        <Glass radius={20} style={styles.filterBar}>
          {filters.map(option => {
            const active = filter === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${option.toLowerCase()} alerts`}
                onPress={() => setFilter(option)}
                style={[styles.filterBtn, active && styles.filterActive]}
              >
                <Text style={{ color: active ? "#fff" : colors.inkMuted, fontFamily: font.sansBold, fontSize: 12 }}>{option}</Text>
              </Pressable>
            );
          })}
        </Glass>

        {shown.length === 0 ? (
          <Glass radius={24} style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <BellIcon size={26} color={colors.inkMuted} />
            </View>
            <Text style={styles.emptyTitle}>{connected ? "No detections yet" : "Rover offline"}</Text>
            <Text style={styles.emptyText}>
              {connected
                ? detections.length === 0
                  ? "The rover is watching. Fire and smoke alerts appear here the moment the on-board model sees one."
                  : `No ${filter.toLowerCase()} alerts in this session.`
                : connectionMessage}
            </Text>
            {!connected && onNavigate && (
              <Pressable accessibilityRole="button" onPress={() => onNavigate("settings")} style={styles.emptyBtn}>
                <Text style={styles.emptyBtnText}>Open Settings</Text>
              </Pressable>
            )}
          </Glass>
        ) : (
          <View style={columns > 1 ? styles.grid : undefined}>
            {shown.map(detection => {
              const color = detectionColor(detection.kind);
              return (
                <View key={detection.id} style={columns > 1 ? { width: cardWidth as any, marginBottom: 12 } : { marginBottom: 12 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${detectionLabel(detection.kind)} detection, ${detection.confidence} percent confidence, ${relativeTime(detection, now)}`}
                    onPress={() => setSelected(detection)}
                  >
                    <Glass radius={24} style={styles.card}>
                      <View style={[styles.accent, { backgroundColor: color }]} />
                      <View style={styles.cardThumb}>
                        {detection.snapshotUrl ? (
                          <Image source={{ uri: detection.snapshotUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                        ) : (
                          <View style={styles.thumbFallback}><KindIcon kind={detection.kind} size={22} color={color} /></View>
                        )}
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={styles.cardTop}>
                          <View style={styles.typeRow}>
                            <KindIcon kind={detection.kind} size={16} color={color} />
                            <Text style={{ color, fontFamily: font.sansBold, fontSize: 14 }}>{detectionLabel(detection.kind)}</Text>
                          </View>
                          <Text style={{ color: colors.ink, fontFamily: font.monoBold, fontSize: 12 }}>{detection.confidence}%</Text>
                        </View>
                        {settings.showLocation && (
                          <View style={styles.gpsRow}>
                            <MapPinIcon size={14} color={colors.inkMuted} />
                            <Text style={styles.gps} numberOfLines={1}>{detection.location}</Text>
                          </View>
                        )}
                        <View style={styles.metaRow}>
                          <Text style={styles.when}>{relativeTime(detection, now)}</Text>
                          {detection.confirmedBySensor && (
                            <View style={styles.sensorBadge}><Text style={styles.sensorText}>SENSOR</Text></View>
                          )}
                        </View>
                      </View>
                    </Glass>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        {detections.length > 0 && (
          <Pressable accessibilityRole="button" onPress={clearDetections} style={styles.clearBtn}>
            <Text style={styles.clearText}>Clear this session</Text>
          </Pressable>
        )}
      </ScrollView>

      <Modal visible={selected !== null} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close detection details" onPress={() => setSelected(null)} />
          {selected && (
            <Glass radius={radius.panel} style={styles.modalCard} borderColor={`${detectionColor(selected.kind)}88`}>
              <View style={styles.modalHead}>
                <View style={styles.typeRow}>
                  <KindIcon kind={selected.kind} size={18} color={detectionColor(selected.kind)} />
                  <Text style={[styles.modalTitle, { color: detectionColor(selected.kind) }]}>{detectionLabel(selected.kind)} detected</Text>
                </View>
                <Pressable accessibilityLabel="Close" hitSlop={10} onPress={() => setSelected(null)}>
                  <CloseIcon size={18} color={colors.inkMuted} />
                </Pressable>
              </View>
              <View style={styles.modalThumb}>
                {selected.snapshotUrl ? (
                  <Image source={{ uri: selected.snapshotUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : (
                  <View style={styles.thumbFallback}><Text style={styles.emptyText}>No snapshot</Text></View>
                )}
              </View>
              {[
                ["Confidence", `${selected.confidence}%`],
                ["Detected", `${relativeTime(selected, now)} · ${selected.timestamp}`],
                ["Location", selected.location],
                ["Sensor confirmed", selected.confirmedBySensor ? "Yes" : "Camera only"],
              ].map(([label, value]) => (
                <View key={label} style={styles.modalRow}>
                  <Text style={styles.modalLabel}>{label}</Text>
                  <Text style={styles.modalValue} numberOfLines={1}>{value}</Text>
                </View>
              ))}
              {onNavigate && (
                <Pressable accessibilityRole="button" onPress={() => { setSelected(null); onNavigate("map"); }} style={styles.modalBtn}>
                  <Text style={styles.modalBtnText}>View on Map</Text>
                </Pressable>
              )}
            </Glass>
          )}
        </View>
      </Modal>
    </AppGround>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  h1: { color: colors.ink, fontFamily: font.sansBold, fontSize: 26 },
  count: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 12 },
  sub: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 14, marginTop: 2, marginBottom: 16 },
  filterBar: { flexDirection: "row", padding: 4, marginBottom: 20 },
  filterBtn: { flex: 1, paddingVertical: 8, borderRadius: 14, alignItems: "center" },
  filterActive: { backgroundColor: colors.cyanDeep },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  gridItem: { width: "49%", marginBottom: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  accent: { width: 4, alignSelf: "stretch", borderRadius: 999 },
  cardThumb: { width: 64, height: 64, borderRadius: 20, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.05)" },
  thumbFallback: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  typeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  gpsRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  gps: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 12, flexShrink: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  when: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 11 },
  sensorBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: "rgba(95,217,164,0.16)", borderWidth: 1, borderColor: "rgba(95,217,164,0.5)" },
  sensorText: { color: colors.mint, fontFamily: font.monoBold, fontSize: 9, letterSpacing: 0.5 },
  emptyCard: { alignItems: "center", padding: 28 },
  emptyIcon: { width: 56, height: 56, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.06)", marginBottom: 14 },
  emptyTitle: { color: colors.ink, fontFamily: font.sansBold, fontSize: 17 },
  emptyText: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 13, textAlign: "center", marginTop: 8, lineHeight: 20 },
  emptyBtn: { marginTop: 18, backgroundColor: colors.cyan, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11 },
  emptyBtnText: { color: "#081018", fontFamily: font.sansBold, fontSize: 14 },
  clearBtn: { alignSelf: "center", marginTop: 18, paddingVertical: 10, paddingHorizontal: 18 },
  clearText: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 13 },
  modalBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.55)" },
  modalCard: { width: "100%", maxWidth: 360, padding: 18 },
  modalHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  modalTitle: { fontFamily: font.sansBold, fontSize: 17 },
  modalThumb: { height: 150, borderRadius: 18, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.05)", marginBottom: 14 },
  modalRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 7 },
  modalLabel: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 13 },
  modalValue: { color: colors.ink, fontFamily: font.monoBold, fontSize: 13, flexShrink: 1, marginLeft: 12 },
  modalBtn: { marginTop: 16, backgroundColor: colors.cyan, borderRadius: 12, alignItems: "center", paddingVertical: 12 },
  modalBtnText: { color: "#081018", fontFamily: font.sansBold, fontSize: 14 },
});
