import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

/** Looping 0→1→0 driver for pulse/glow effects. */
export function usePulse(duration = 1800) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: duration / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: duration / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [v, duration]);
  return v;
}

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
