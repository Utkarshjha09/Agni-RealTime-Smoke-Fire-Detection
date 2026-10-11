import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** True when the device is wider than it is tall. Reacts live to rotation. */
export function useLandscape() {
  const { width, height } = useWindowDimensions();
  return width > height;
}

/** Height the portrait tab bar takes above the bottom inset, from App.tsx's styles. */
const TAB_BAR_CLEARANCE = 84;
/** Width the landscape nav rail takes, from App.tsx's styles. */
const RAIL_CLEARANCE = 72;

/** Padding that keeps a screen's content clear of the notch, the home indicator
 * and the app's own navigation, in either orientation.
 *
 * Screens used to hard-code a 44pt top and 96pt bottom, which overlapped tall
 * notches and wasted space on phones without one.
 */
export function useScreenInsets(landscape: boolean) {
  const insets = useSafeAreaInsets();
  return {
    top: insets.top + 12,
    bottom: landscape ? insets.bottom + 16 : insets.bottom + TAB_BAR_CLEARANCE,
    left: landscape ? Math.max(insets.left, 12) + RAIL_CLEARANCE : 16,
    right: landscape ? Math.max(insets.right, 16) : 16,
  };
}
