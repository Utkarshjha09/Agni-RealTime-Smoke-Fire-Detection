import { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
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
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  const radius = size / 2;
  // How far the knob may travel from the centre.
  const limit = radius - size * 0.17;

  // Refs keep the PanResponder stable for the whole gesture: rebuilding it
  // mid-drag (props change on every render) used to drop the touch tracking.
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
    setKnob({ x, y });

    let throttle = -y / max;
    let steering = x / max;
    if (Math.hypot(throttle, steering) < DEAD_ZONE) {
      throttle = 0;
      steering = 0;
    }
    onMoveRef.current(throttle, steering);
  }, []);

  const release = useCallback(() => {
    setActive(false);
    setKnob({ x: 0, y: 0 });
    onMoveRef.current(0, 0);
  }, []);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    // Never hand the gesture to a parent scroll/press mid-drive: losing it
    // silently would leave the motors running until the rover watchdog fires.
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,

    onPanResponderGrant: (event: GestureResponderEvent) => {
      if (disabledRef.current) {
        onBlockedRef.current?.();
        return;
      }
      setActive(true);
      // Track the finger's absolute position within the pad, measured from the
      // centre -- the way a game stick behaves. The previous version used the
      // gesture delta, so pressing off-centre started from a false zero.
      const { locationX, locationY } = event.nativeEvent;
      apply(locationX - radius, locationY - radius);
    },
    onPanResponderMove: (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (disabledRef.current) return;
      const { locationX, locationY } = event.nativeEvent;
      // locationX is relative to whichever view reports the touch, so fall back
      // to grant-point + delta when it looks out of range.
      const withinPad = locationX >= -radius && locationX <= size + radius;
      if (withinPad) {
        apply(locationX - radius, locationY - radius);
      } else {
        apply(gesture.dx, gesture.dy);
      }
    },
    onPanResponderRelease: release,
    onPanResponderTerminate: release,
  }), [apply, radius, release, size]);

  const magnitude = Math.min(1, Math.hypot(knob.x, knob.y) / limit);

  return (
    <View
      {...responder.panHandlers}
      accessibilityLabel="Drive joystick. Drag to steer the rover in any direction."
      accessibilityRole="adjustable"
      style={[
        styles.base,
        { width: size, height: size, borderRadius: size },
        disabled && styles.disabled,
        active && styles.active,
      ]}
    >
      <View style={[styles.ring, { width: size * 0.64, height: size * 0.64, borderRadius: size }]} />
      <View style={[styles.crossH, { width: size * 0.5 }]} />
      <View style={[styles.crossV, { height: size * 0.5 }]} />
      <View
        style={[
          styles.knob,
          {
            width: size * 0.36,
            height: size * 0.36,
            borderRadius: size,
            borderWidth: size * 0.03,
            transform: [{ translateX: knob.x }, { translateY: knob.y }],
            opacity: 0.75 + magnitude * 0.25,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(14,20,34,0.62)", borderWidth: 1, borderColor: "rgba(255,255,255,0.16)" },
  disabled: { opacity: 0.45 },
  active: { borderColor: "rgba(76,201,240,0.5)" },
  ring: { borderWidth: 1, borderColor: "rgba(76,201,240,0.26)" },
  crossH: { position: "absolute", height: 1, backgroundColor: "rgba(76,201,240,0.14)" },
  crossV: { position: "absolute", width: 1, backgroundColor: "rgba(76,201,240,0.14)" },
  knob: { position: "absolute", backgroundColor: colors.cyan, borderColor: "rgba(255,255,255,0.76)", shadowColor: colors.cyan, shadowOpacity: 0.65, shadowRadius: 14, elevation: 5 },
});
