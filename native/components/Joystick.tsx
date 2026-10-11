import { useCallback, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { colors } from "../theme";

type JoystickProps = {
  disabled?: boolean;
  /** throttle: +1 full forward, -1 full reverse. steering: +1 hard right, -1 hard left. */
  onMove: (throttle: number, steering: number) => void;
  onBlocked?: () => void;
  size?: number;
};

/** Below this the stick is treated as centred, so a resting thumb cannot creep the rover. */
const DEAD_ZONE = 0.08;

export function Joystick({ disabled = false, onMove, onBlocked, size = 168 }: JoystickProps) {
  // The knob is an Animated value, not state: it follows the finger without
  // re-rendering the component on every touch event, which is what made the
  // stick feel a frame or two behind the thumb.
  const knob = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const [active, setActive] = useState(false);

  const radius = size / 2;
  // How far the knob may travel from the centre.
  const limit = radius - size * 0.17;

  // Refs keep the gesture stable for the whole drag: rebuilding it mid-drag
  // (props change on every render) would drop the touch tracking.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const apply = useCallback((rawX: number, rawY: number) => {
    const max = limitRef.current;
    const length = Math.hypot(rawX, rawY);
    // Clamp to the circle so diagonals are not faster than the cardinals.
    const scale = length > max ? max / length : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    knob.stopAnimation();
    knob.setValue({ x, y });

    let throttle = -y / max;
    let steering = x / max;
    if (Math.hypot(throttle, steering) < DEAD_ZONE) {
      throttle = 0;
      steering = 0;
    }
    onMoveRef.current(throttle, steering);
  }, [knob]);

  const release = useCallback(() => {
    setActive(false);
    // The stop command goes out immediately; only the knob eases home.
    onMoveRef.current(0, 0);
    Animated.spring(knob, { toValue: { x: 0, y: 0 }, useNativeDriver: true, friction: 6, tension: 120 }).start();
  }, [knob]);

  // A native pan gesture, not PanResponder. PanResponder is React Native's
  // single-responder system: while a thumb held the stick, every other touch was
  // routed to the stick too, so ACCEL, SPRINT and BRAKE could not be pressed while
  // driving. Gesture handler tracks each finger on its own, like a game pad.
  const pan = useMemo(() => Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .shouldCancelWhenOutside(false)
    .runOnJS(true)
    .onBegin(event => {
      if (disabledRef.current) {
        onBlockedRef.current?.();
        return;
      }
      setActive(true);
      // Absolute position within the pad, measured from the centre: the way a
      // game stick behaves, so pressing off-centre does not start from a false zero.
      apply(event.x - radius, event.y - radius);
    })
    .onUpdate(event => {
      if (disabledRef.current) return;
      apply(event.x - radius, event.y - radius);
    })
    .onFinalize(() => {
      if (!disabledRef.current) release();
    }), [apply, radius, release]);

  const knobSize = size * 0.36;

  return (
    <GestureDetector gesture={pan}>
    <View
      accessibilityLabel="Drive joystick. Drag to steer the rover in any direction."
      accessibilityRole="adjustable"
      style={[
        styles.base,
        { width: size, height: size, borderRadius: size },
        disabled && styles.disabled,
        active && styles.active,
      ]}
    >
      <View style={[styles.ring, { width: size * 0.64, height: size * 0.64, borderRadius: size }, active && styles.ringActive]} />
      <View style={[styles.crossH, { width: size * 0.5 }]} />
      <View style={[styles.crossV, { height: size * 0.5 }]} />
      {/* Direction ticks, so forward reads as forward at a glance. */}
      <View style={[styles.tick, { top: size * 0.07 }]} />
      <View style={[styles.tick, styles.tickMuted, { bottom: size * 0.07 }]} />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.knob,
          {
            width: knobSize,
            height: knobSize,
            borderRadius: size,
            borderWidth: size * 0.03,
            transform: knob.getTranslateTransform(),
          },
          active && styles.knobActive,
        ]}
      />
    </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(14,20,34,0.62)", borderWidth: 1, borderColor: "rgba(255,255,255,0.16)" },
  disabled: { opacity: 0.45 },
  active: { borderColor: "rgba(76,201,240,0.55)", backgroundColor: "rgba(14,24,40,0.72)" },
  ring: { position: "absolute", borderWidth: 1, borderColor: "rgba(76,201,240,0.26)" },
  ringActive: { borderColor: "rgba(76,201,240,0.5)" },
  crossH: { position: "absolute", height: 1, backgroundColor: "rgba(76,201,240,0.14)" },
  crossV: { position: "absolute", width: 1, backgroundColor: "rgba(76,201,240,0.14)" },
  tick: { position: "absolute", width: 14, height: 3, borderRadius: 2, backgroundColor: "rgba(76,201,240,0.7)" },
  tickMuted: { backgroundColor: "rgba(255,255,255,0.25)" },
  knob: { position: "absolute", backgroundColor: colors.cyan, borderColor: "rgba(255,255,255,0.76)", opacity: 0.85, shadowColor: colors.cyan, shadowOpacity: 0.65, shadowRadius: 14, elevation: 5 },
  knobActive: { opacity: 1 },
});
