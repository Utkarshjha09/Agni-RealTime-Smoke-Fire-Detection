import { useWindowDimensions } from "react-native";

/** True when the device is wider than it is tall. Reacts live to rotation. */
export function useLandscape() {
  const { width, height } = useWindowDimensions();
  return width > height;
}
