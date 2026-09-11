import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";

type Props = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  /** Softer variant used for panels floating over other glass. */
  dim?: boolean;
  borderColor?: string;
  glow?: string; // colored shadow
};

/**
 * Frosted-glass surface. Uses a real backdrop BlurView plus a subtle top-light
 * gradient and a 1px inner-highlight border to mimic light catching the edge.
 */
export function Glass({ children, style, radius = 24, intensity = 40, dim, borderColor, glow }: Props) {
  return (
    <View
      style={[
        styles.wrap,
        { borderRadius: radius, borderColor: borderColor ?? colors.glassBorder },
        glow ? { shadowColor: glow, shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 0 }, elevation: 12 } : styles.shadow,
        style,
      ]}
    >
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={dim ? ["rgba(14,20,34,0.55)", "rgba(14,20,34,0.55)"] : ["rgba(255,255,255,0.12)", "rgba(255,255,255,0.05)"]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* inner top highlight */}
      <View style={styles.innerHighlight} pointerEvents="none" />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    overflow: "hidden",
  },
  shadow: {
    shadowColor: "#000",
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 18 },
    elevation: 10,
  },
  innerHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
});
