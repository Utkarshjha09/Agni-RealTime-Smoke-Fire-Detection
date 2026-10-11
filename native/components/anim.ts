import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

/** Continuous 0→1 driver (restarts) for ping rings / drifting particles. */
export function useLoop(duration = 2000, delay = 0) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration, delay, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [v, duration, delay]);
  return v;
}
