# AR Fire Robot — React Native (Expo)

The Agni rover controller. Dark-mode glassmorphism, four screens (Control, Map,
Alerts, Settings) behind an orientation-aware shell that flips between a bottom tab
bar in portrait and a left rail with a full-bleed cockpit in landscape.


## Run it

```bash
# from a machine with Node + the Expo CLI
cd native
npm install
npx expo start        # then press i / a, or scan the QR with Expo Go
```

## Checks

```bash
npm run typecheck     # tsc --noEmit
npm run bundle        # verifies the app bundles for Android
```

## Build an installable APK

The `preview` profile in `eas.json` builds an APK for sideloading. The platform
flag is required, and the CLI package is `eas-cli` (not `eas`):

```bash
npx eas-cli login                                                  # once
npx eas-cli build --platform android --profile preview --clear-cache
```

The build runs on Expo's servers under the account in `app.json` (`owner`), and
finishes with a download link for the APK.

If you'd rather scaffold cleanly:

```bash
npx create-expo-app@latest ar-fire-robot --template blank-typescript
# copy App.tsx, index.js, app.json, theme.ts, components/, screens/ into it
# then install the deps below
```

## Dependencies

```bash
npx expo install expo-blur expo-linear-gradient expo-status-bar expo-font \
  react-native-svg react-native-safe-area-context @react-native-community/slider \
  @react-native-async-storage/async-storage
npm install @expo-google-fonts/inter @expo-google-fonts/jetbrains-mono
```

`@react-native-async-storage/async-storage` stores the rover URLs and token
between launches. It is loaded lazily — if it is missing the app still runs, it
just forgets the rover each launch.

## What maps to what (web → native)

| Web (Vite) | Native |
|---|---|
| Tailwind classes | `StyleSheet` objects + `theme.ts` tokens |
| `backdrop-blur` glass | `expo-blur` `BlurView` (`components/Glass.tsx`) |
| CSS `@keyframes` (pulse / smoke / ping) | `Animated` loops (`components/anim.ts`) |
| inline `<svg>` icons | `react-native-svg` (`components/icons.tsx`) |
| CSS radial gradients | `LinearGradient` + soft blob views (`AppGround.tsx`) |
| `matchMedia(orientation)` | `useWindowDimensions()` (`useOrientation.ts`) |
| `@import` Google Fonts | `@expo-google-fonts/*` loaded in `App.tsx` |

## Orientation

`app.json` sets `"orientation": "default"` so the device can rotate freely.
`useLandscape()` re-reads dimensions live, so the Control screen enters cockpit mode
and the nav becomes a left rail the moment the phone rotates.

## Hardware connection

The installed app connects to the companion service in `../raspberry_pi` from
Settings: **camera frame URL**, **control WebSocket URL**, and the **access token**
matching `ROVER_TOKEN` on the Pi. It displays JPEG frames from the Pi, sends
joystick motor commands with a dead-man watchdog, and receives fire/smoke
detections from the rover's YOLO model over WebSocket. The Pi service must be
running on the same Wi-Fi network as the phone.

The connection is remembered, reconnects automatically with backoff, and shows
its real state everywhere — nothing in this app displays sample data. Values the
rover has no hardware for (battery without a monitor, GPS) render as `—`.

You do not need a Raspberry Pi to try it: the service in `../raspberry_pi` runs on
a laptop with a webcam or a synthetic frame. See that folder's README.

The 3D map is a real perspective scene: the rover at the origin, its camera field of
view on the ground, and each detection placed by bearing from the lens geometry. Range
is measured when an optional ultrasonic sensor covered that bearing, and estimated
from apparent size otherwise. The app always says which of the two it is showing.
