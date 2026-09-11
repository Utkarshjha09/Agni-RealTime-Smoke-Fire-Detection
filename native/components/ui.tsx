import type { ReactNode } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useLoop } from "./anim";
import { colors, font } from "../theme";

export function ProgressRing({
  value,
  size = 44,
  stroke = 3.5,
  color = colors.cyan,
  label,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (value / 100) * c;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.14)" strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={off}
        />
      </Svg>
      <View style={StyleSheet.absoluteFill}>
        <Text style={{ color, fontFamily: font.monoBold, fontSize: 10, textAlign: "center", lineHeight: size }}>
          {label ?? `${value}%`}
        </Text>
      </View>
    </View>
  );
}

export function LiveDot({ color = colors.fire1, size = 8 }: { color?: string; size?: number }) {
  const v = useLoop(2000);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.7, 2.4] });
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] });
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size,
          backgroundColor: color,
          transform: [{ scale }],
          opacity,
        }}
      />
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}
