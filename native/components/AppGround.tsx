import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "../theme";

/** Deep charcoal-navy gradient with soft fire/cyan ambient light blobs. */
export function AppGround({ children }: { children?: ReactNode }) {
  return (
    <View style={styles.root}>
      <LinearGradient colors={[colors.bg1, colors.bg0, "#090C15"]} locations={[0, 0.55, 1]} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={[styles.blob, { top: -80, left: -60, backgroundColor: "rgba(255,107,53,0.20)" }]} />
      <View style={[styles.blob, { bottom: -100, right: -70, backgroundColor: "rgba(76,201,240,0.18)" }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  blob: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 300,
    // RN can't blur a plain View; a very soft radial feel via low opacity + large size.
    opacity: 0.9,
  },
});
