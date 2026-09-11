import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, PanResponder, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Ellipse, G, Line, Polygon, Text as SvgText } from "react-native-svg";
import { AppGround } from "../components/AppGround";
import { Glass } from "../components/Glass";
import { LiveDot } from "../components/ui";
import type { AppTab } from "../domain/robot";
import { detectionColor, detectionLabel, detectionTime, relativeTime } from "../domain/detectionView";
import { DEFAULT_HFOV_DEG, placeDetections } from "../domain/geometry";
import { beamFootprint, hasEcho, latestReading, placeRangeReadings } from "../domain/rangeMap";
import {
  MAX_PITCH, clampCamera, defaultCamera, project, projectSegment, viewBasis,
  type OrbitCamera,
} from "../domain/scene3d";
import { CloseIcon, CrosshairIcon, LayersIcon, MinusIcon, PlusIcon } from "../components/icons";
import { colors, font, radius } from "../theme";
import { useRobot } from "../features/robot/RobotContext";

/** Ground grid: 1m cells out to this many metres. */
const GRID_EXTENT = 12;
const GRID_STEP = 2;
/** Detections older than this fade out of the scene. */
const FADE_AFTER_MS = 120000;

export default function MapScreen({ landscape = false, onNavigate }: { landscape?: boolean; onNavigate?: (tab: AppTab) => void }) {
  const { connectionState, detections, rangeReadings, telemetry } = useRobot();
  const [camera, setCamera] = useState<OrbitCamera>(defaultCamera);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const connected = connectionState === "connected";
  const hfov = telemetry.cameraHfovDeg > 0 ? telemetry.cameraHfovDeg : DEFAULT_HFOV_DEG;

  // Range points age out in seconds, so the clock has to run far faster while an
  // ultrasonic sensor is live. Without a sensor, detections fade over minutes and a
  // 10s tick is plenty.
  useEffect(() => {
    const period = telemetry.rangeSensorActive ? 500 : 10000;
    const interval = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(interval);
  }, [telemetry.rangeSensorActive]);

  // Drag to orbit the scene. Refs keep the gesture stable across re-renders.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const gestureStart = useRef(camera);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.hypot(gesture.dx, gesture.dy) > 4,
    onPanResponderGrant: () => { gestureStart.current = cameraRef.current; },
    onPanResponderMove: (_, gesture) => {
      const start = gestureStart.current;
      setCamera(clampCamera({
        ...start,
        yaw: start.yaw - gesture.dx * 0.006,
        pitch: start.pitch + gesture.dy * 0.004,
      }));
    },
  }), []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ width, height });
  }, []);

  const zoom = (delta: number) => setCamera(current => clampCamera({ ...current, distance: current.distance + delta }));
  const resetView = () => setCamera(defaultCamera());
  const topDown = () => setCamera(current => clampCamera({ ...current, pitch: MAX_PITCH, yaw: 0 }));

  // Real geometry: bearing from the camera's field of view. Range is measured when an
  // ultrasonic ping covered that bearing, and estimated from box size otherwise.
  const placements = useMemo(
    () => placeDetections(detections, hfov, rangeReadings, now).filter(p => p.located),
    [detections, hfov, now, rangeReadings],
  );
  const rangePoints = useMemo(() => placeRangeReadings(rangeReadings, now), [now, rangeReadings]);
  const lastPing = useMemo(() => latestReading(rangeReadings), [rangeReadings]);
  const rangeActive = telemetry.rangeSensorActive;

  // "No echo" is not "0 m". Nothing answered within the sensor's range, which on a
  // fire robot must never be shown as an obstacle pressed against the bumper.
  const clearanceText = !lastPing
    ? "—"
    : hasEcho(lastPing)
      ? `${lastPing.distanceM.toFixed(2)} m`
      : "No echo";
  const clearanceMeta = !lastPing
    ? "Waiting for the first ping"
    : hasEcho(lastPing)
      ? `${lastPing.bearingDeg === 0 ? "Straight ahead" : `${lastPing.bearingDeg.toFixed(0)}° bearing`} · ±${(lastPing.beamDeg / 2).toFixed(0)}° cone`
      : `Nothing within ${lastPing.maxM.toFixed(1)} m`;
  const selected = placements.find(p => p.detection.id === selectedId) ?? null;
  const nearest = useMemo(
    () => placements.reduce<typeof placements[number] | null>((best, p) => (!best || p.rangeM < best.rangeM ? p : best), null),
    [placements],
  );

  const scene = useMemo(() => {
    if (viewport.width < 2 || viewport.height < 2) return null;
    const basis = viewBasis(camera, viewport);

    const gridLines: { x1: number; y1: number; x2: number; y2: number; key: string; major: boolean }[] = [];
    for (let value = -GRID_EXTENT; value <= GRID_EXTENT; value += GRID_STEP) {
      const alongZ = projectSegment({ x: value, y: 0, z: -2 }, { x: value, y: 0, z: GRID_EXTENT * 2 }, basis, viewport);
      if (alongZ) gridLines.push({ x1: alongZ.from.x, y1: alongZ.from.y, x2: alongZ.to.x, y2: alongZ.to.y, key: `x${value}`, major: value === 0 });
      const z = value + GRID_EXTENT;
      const alongX = projectSegment({ x: -GRID_EXTENT, y: 0, z }, { x: GRID_EXTENT, y: 0, z }, basis, viewport);
      if (alongX) gridLines.push({ x1: alongX.from.x, y1: alongX.from.y, x2: alongX.to.x, y2: alongX.to.y, key: `z${z}`, major: z === 0 });
    }

    const rover = project({ x: 0, y: 0, z: 0 }, basis, viewport);
    // The camera's actual field of view, drawn on the ground so you can see what the rover can see.
    const halfFov = (hfov * Math.PI) / 360;
    const fovReach = 9;
    const fovLeft = project({ x: -Math.tan(halfFov) * fovReach, y: 0, z: fovReach }, basis, viewport);
    const fovRight = project({ x: Math.tan(halfFov) * fovReach, y: 0, z: fovReach }, basis, viewport);

    const markers = placements
      .map(placement => {
        const base = project({ x: placement.x, y: 0, z: placement.z }, basis, viewport);
        const top = project({ x: placement.x, y: 1.1, z: placement.z }, basis, viewport);
        return { placement, base, top };
      })
      .filter(marker => marker.base.visible && marker.top.visible)
      // Painter's algorithm: draw distant markers first so near ones overlap them.
      .sort((a, b) => b.base.depth - a.base.depth);

    // The ultrasonic cone on the ground, drawn only when a sensor is actually wired.
    // Next to the camera wedge it shows plainly how narrow one fixed sensor's view is.
    const beam = rangeActive && lastPing
      ? beamFootprint(lastPing.bearingDeg, lastPing.beamDeg, Math.min(lastPing.maxM, 6))
          .map(point => project({ x: point.x, y: 0, z: point.z }, basis, viewport))
      : [];
    const beamVisible = beam.length > 0 && beam.every(point => point.visible);

    // Measured surface points. A short vertical tick reads as a wall rather than a
    // mark painted on the floor.
    const surfaces = rangePoints
      .map(point => ({
        point,
        base: project({ x: point.x, y: 0, z: point.z }, basis, viewport),
        top: project({ x: point.x, y: 0.45, z: point.z }, basis, viewport),
      }))
      .filter(item => item.base.visible && item.top.visible)
      .sort((a, b) => b.base.depth - a.base.depth);

    return { gridLines, rover, fovLeft, fovRight, markers, beam, beamVisible, surfaces };
  }, [camera, hfov, lastPing, placements, rangeActive, rangePoints, viewport]);

  return (
    <AppGround>
      <View style={StyleSheet.absoluteFill} onLayout={onLayout} {...responder.panHandlers}>
        {scene && (
          <Svg width={viewport.width} height={viewport.height}>
            {scene.gridLines.map(line => (
              <Line
                key={line.key}
                x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}
                stroke={line.major ? "rgba(76,201,240,0.34)" : "rgba(76,201,240,0.13)"}
                strokeWidth={line.major ? 1.6 : 1}
              />
            ))}

            {/* What the camera can actually see, from its real field of view */}
            {scene.rover.visible && scene.fovLeft.visible && scene.fovRight.visible && (
              <Polygon
                points={`${scene.rover.x},${scene.rover.y} ${scene.fovLeft.x},${scene.fovLeft.y} ${scene.fovRight.x},${scene.fovRight.y}`}
                fill="rgba(76,201,240,0.10)"
                stroke="rgba(76,201,240,0.28)"
                strokeWidth={1}
              />
            )}

            {/* Ultrasonic cone, where the rover can actually measure distance */}
            {scene.beamVisible && (
              <Polygon
                points={scene.beam.map(point => `${point.x},${point.y}`).join(" ")}
                fill="rgba(95,217,164,0.10)"
                stroke="rgba(95,217,164,0.30)"
                strokeWidth={1}
              />
            )}

            {/* Measured surfaces. Real distances, fading as they age out. */}
            {scene.surfaces.map(({ point, base, top }) => (
              <G key={point.key} opacity={point.strength}>
                <Line x1={base.x} y1={base.y} x2={top.x} y2={top.y} stroke={colors.mint} strokeWidth={2} />
                <Circle cx={base.x} cy={base.y} r={Math.max(2, Math.min(7, base.scale * viewport.height * 0.06))} fill={colors.mint} />
              </G>
            ))}

            {scene.markers.map(({ placement, base, top }) => {
              const { detection } = placement;
              const color = detectionColor(detection.kind);
              const age = now - detectionTime(detection);
              const opacity = Math.max(0.28, 1 - age / FADE_AFTER_MS);
              const size = Math.max(5, Math.min(26, base.scale * viewport.height * 0.32));
              const isSelected = detection.id === selectedId;
              return (
                <G key={detection.id} opacity={opacity} onPress={() => setSelectedId(detection.id)}>
                  {/* Footprint on the ground plane, so the height reads as height */}
                  <Ellipse cx={base.x} cy={base.y} rx={size * 1.5} ry={size * 0.55} fill={`${color}33`} stroke={`${color}66`} strokeWidth={1} />
                  <Line x1={base.x} y1={base.y} x2={top.x} y2={top.y} stroke={color} strokeWidth={isSelected ? 3 : 2} />
                  <Circle cx={top.x} cy={top.y} r={size} fill={`${color}55`} />
                  <Circle cx={top.x} cy={top.y} r={size * 0.5} fill={color} stroke={isSelected ? "#fff" : "transparent"} strokeWidth={2} />
                  <SvgText
                    x={top.x} y={top.y - size - 6}
                    fill={color} fontSize={11} fontFamily={font.monoBold} textAnchor="middle"
                  >
                    {`${detectionLabel(detection.kind).toUpperCase()} ${detection.confidence}%${placement.rangeSource === "measured" ? " ·" : ""}`}
                  </SvgText>
                </G>
              );
            })}

            {/* Rover at the origin */}
            {scene.rover.visible && (
              <G>
                <Circle cx={scene.rover.x} cy={scene.rover.y} r={12} fill="rgba(76,201,240,0.25)" />
                <Circle cx={scene.rover.x} cy={scene.rover.y} r={6} fill={connected ? colors.cyan : colors.inkMuted} />
                <SvgText x={scene.rover.x} y={scene.rover.y + 24} fill={colors.inkMuted} fontSize={10} fontFamily={font.mono} textAnchor="middle">
                  ROVER
                </SvgText>
              </G>
            )}
          </Svg>
        )}
      </View>

      <LinearGradient colors={["rgba(0,0,0,0.35)", "transparent", "rgba(0,0,0,0.5)"]} style={StyleSheet.absoluteFill} pointerEvents="none" />

      {/* Title */}
      <View style={styles.titleWrap} pointerEvents="box-none">
        <Glass radius={999} style={styles.titlePill}>
          <LiveDot color={placements.length > 0 ? colors.fire1 : colors.inkMuted} />
          <Text style={styles.titleText}>Area View</Text>
          <Text style={styles.titleSub}>· {placements.length} {placements.length === 1 ? "zone" : "zones"}</Text>
        </Glass>
      </View>

      {/* Control cluster */}
      <View style={styles.cluster} pointerEvents="box-none">
        <Pressable accessibilityRole="button" accessibilityLabel="Top-down view" onPress={topDown}>
          <Glass radius={18} style={styles.clusterBtn}><Text style={{ color: colors.cyan, fontFamily: font.monoBold, fontSize: 11 }}>TOP</Text></Glass>
        </Pressable>
        <Glass radius={18} style={styles.zoomBox}>
          <Pressable accessibilityRole="button" accessibilityLabel="Zoom in" onPress={() => zoom(-3)} style={styles.zoomBtn}><PlusIcon size={20} color={colors.ink} /></Pressable>
          <View style={styles.zoomSep} />
          <Pressable accessibilityRole="button" accessibilityLabel="Zoom out" onPress={() => zoom(3)} style={styles.zoomBtn}><MinusIcon size={20} color={colors.ink} /></Pressable>
        </Glass>
        <Pressable accessibilityRole="button" accessibilityLabel="Reset view" onPress={resetView}>
          <Glass radius={18} style={styles.clusterBtn}><CrosshairIcon size={20} color={colors.cyan} /></Glass>
        </Pressable>
      </View>

      {/* Legend */}
      <Glass radius={20} style={[styles.legend, { left: landscape ? 76 : 16, bottom: landscape ? 16 : 96 }]}>
        <View style={styles.legendHead}><LayersIcon size={16} color={colors.inkMuted} /><Text style={styles.legendHeadText}>LEGEND</Text></View>
        {[
          [colors.fire1, "Fire"],
          [colors.smoke, "Smoke"],
          [colors.cyan, "Rover + camera view"],
          // Only claim an ultrasonic layer when there is a sensor producing one.
          ...(rangeActive ? [[colors.mint, "Measured surface"] as [string, string]] : []),
        ].map(([swatch, label]) => (
          <View key={label as string} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: swatch as string }]} />
            <Text style={styles.legendLabel}>{label}</Text>
          </View>
        ))}
        <Text style={styles.legendNote}>Grid {GRID_STEP}m · drag to orbit</Text>
      </Glass>

      {/* Status / empty state */}
      <View style={[styles.summaryWrap, { bottom: landscape ? 16 : 96, right: 16 }]} pointerEvents="box-none">
        <Glass radius={20} style={styles.summary}>
          {rangeActive && (
            <View style={styles.clearanceBlock}>
              <Text style={styles.summaryTitle}>CLEARANCE</Text>
              <Text style={[styles.summaryValue, { color: colors.mint }]}>{clearanceText}</Text>
              <Text style={styles.summaryMeta}>{clearanceMeta}</Text>
            </View>
          )}
          {!nearest ? (
            <Text style={styles.summaryEmpty}>
              {connected ? "No fire or smoke in view" : "Rover offline — connect in Settings"}
            </Text>
          ) : (
            <>
              <Text style={styles.summaryTitle}>NEAREST</Text>
              <Text style={[styles.summaryValue, { color: detectionColor(nearest.detection.kind) }]}>
                {detectionLabel(nearest.detection.kind)} · {nearest.rangeSource === "measured" ? "" : "~"}{nearest.rangeM.toFixed(1)}m
              </Text>
              <Text style={styles.summaryMeta}>
                {nearest.bearingDeg >= 0 ? `${nearest.bearingDeg.toFixed(0)}° right` : `${Math.abs(nearest.bearingDeg).toFixed(0)}° left`}
                {nearest.rangeSource === "measured" ? " · measured" : " · estimated"}
              </Text>
            </>
          )}
        </Glass>
      </View>

      {/* Detection detail */}
      <Modal visible={selected !== null} transparent animationType="fade" onRequestClose={() => setSelectedId(null)}>
        <Pressable style={styles.modalCenter} onPress={() => setSelectedId(null)}>
          {selected && (
            <Glass radius={radius.panel} borderColor={`${detectionColor(selected.detection.kind)}66`} style={styles.popover}>
              <View style={styles.popHead}>
                <Text style={{ color: detectionColor(selected.detection.kind), fontFamily: font.monoBold, fontSize: 11, letterSpacing: 1.5 }}>
                  {detectionLabel(selected.detection.kind).toUpperCase()} ZONE
                </Text>
                <Pressable accessibilityLabel="Close" onPress={() => setSelectedId(null)} hitSlop={10}><CloseIcon size={16} color={colors.inkMuted} /></Pressable>
              </View>
              <View style={styles.popThumb}>
                {selected.detection.snapshotUrl ? <Image source={{ uri: selected.detection.snapshotUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
              </View>
              {[
                ["Confidence", `${selected.detection.confidence}%`],
                ["Bearing", `${selected.bearingDeg >= 0 ? "+" : ""}${selected.bearingDeg.toFixed(1)}° from centre`],
                selected.rangeSource === "measured"
                  ? ["Range", `${selected.rangeM.toFixed(2)} m (measured)`]
                  : ["Range", `~${selected.rangeM.toFixed(1)} m (estimated)`],
                ["Detected", relativeTime(selected.detection, now)],
                ["Source", selected.detection.confirmedBySensor ? "Sensor confirmed" : "Camera model"],
              ].map(([label, value]) => (
                <View key={label} style={styles.popRow}>
                  <Text style={styles.popLabel}>{label}</Text>
                  <Text style={styles.popValue} numberOfLines={1}>{value}</Text>
                </View>
              ))}
              <Text style={styles.popNote}>
                {selected.rangeSource === "measured"
                  ? "Bearing comes from the camera's field of view. Range is an ultrasonic measurement of the nearest surface in that direction, which may be an object in front of the fire rather than the fire itself."
                  : "Bearing is measured from the camera's field of view. Range is estimated from how large the detection appears, so treat it as approximate."}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => onNavigate?.("control")}>
                <LinearGradient colors={[colors.fire1, colors.fire2]} style={styles.popBtn}>
                  <Text style={{ color: "#fff", fontFamily: font.sansBold, fontSize: 14 }}>View Live</Text>
                </LinearGradient>
              </Pressable>
            </Glass>
          )}
        </Pressable>
      </Modal>
    </AppGround>
  );
}

const styles = StyleSheet.create({
  titleWrap: { position: "absolute", top: 44, left: 0, right: 0, alignItems: "center" },
  titlePill: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  titleText: { color: colors.ink, fontFamily: font.sansBold, fontSize: 14 },
  titleSub: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 11 },
  cluster: { position: "absolute", right: 16, top: 96, gap: 8 },
  clusterBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  zoomBox: { alignItems: "center" },
  zoomBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  zoomSep: { height: 1, width: 28, backgroundColor: "rgba(255,255,255,0.12)" },
  legend: { position: "absolute", padding: 14 },
  legendHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  legendHeadText: { color: colors.inkMuted, fontFamily: font.sansBold, fontSize: 11, letterSpacing: 1.5 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  swatch: { width: 24, height: 10, borderRadius: 999 },
  legendLabel: { color: colors.ink, fontFamily: font.sans, fontSize: 12 },
  legendNote: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 10, marginTop: 4 },
  summaryWrap: { position: "absolute", alignItems: "flex-end" },
  summary: { paddingHorizontal: 14, paddingVertical: 12, width: 210 },
  summaryTitle: { color: colors.inkMuted, fontFamily: font.sansBold, fontSize: 10, letterSpacing: 1.2 },
  summaryValue: { fontFamily: font.monoBold, fontSize: 15, marginTop: 4 },
  summaryMeta: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 10, marginTop: 4 },
  summaryEmpty: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 12, lineHeight: 17 },
  clearanceBlock: { marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.hairline },
  modalCenter: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" },
  popover: { width: 288, padding: 16 },
  popHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  popThumb: { height: 112, borderRadius: 20, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.05)", marginBottom: 12 },
  popRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 5 },
  popLabel: { color: colors.inkMuted, fontFamily: font.mono, fontSize: 13 },
  popValue: { color: colors.ink, fontFamily: font.monoBold, fontSize: 13, flexShrink: 1, marginLeft: 12 },
  popNote: { color: colors.inkMuted, fontFamily: font.sans, fontSize: 11, lineHeight: 16, marginTop: 10 },
  popBtn: { borderRadius: radius.button, paddingVertical: 12, alignItems: "center", marginTop: 14 },
});
