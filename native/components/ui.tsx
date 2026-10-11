import { Animated, View } from "react-native";
import { useLoop } from "./anim";
import { colors } from "../theme";

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
