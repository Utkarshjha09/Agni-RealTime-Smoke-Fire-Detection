# Agni: AR Smart Fire Detection Rover

A Raspberry Pi rover that looks for fire and smoke with a YOLO model running **on the
rover itself**, and an Android/iOS app that drives it, shows the live camera with AR
detection boxes drawn over it, places every detection in a 3D view of the area, and
keeps a log of what it found.

Three parts, no cloud, no web app, no simulated data anywhere.

```
native/         Expo app      drive, live video + AR boxes, 3D map, alerts, settings
raspberry_pi/   Pi service    camera, video stream, motors, telemetry, fire/smoke model
model/          Offline only  dataset, training, export, and a webcam test for the model
```

> **This is a student prototype, not a certified fire-detection product.** It must not
> be relied on to protect people or property. Read [Safety](#safety) before wiring
> anything to a motor driver.

---

## Download the app

**[Download Agni for Android (`release/agni-rover.apk`)](release/agni-rover.apk)**

| | |
|---|---|
| Version | 1.0.0, built 2026-10-11 |
| Size | 61 MB |
| Platform | Android. On an iPhone, run it with Expo Go instead ([Step 7](#step-7-run-the-app)) |
| Package | `com.nature21.agni` |
| SHA-256 | `3400c33c61e879bba0fe349a99a5ddd2102de4471f23b511acb538da53aa6c79` |

This build contains everything described in this README: the signed control link, the
rover-drawn fire boxes on a native video view, the multi-touch drive buttons with cruise
and reverse, and the token kept in the phone's keystore.

**Install it**

1. Open the link above **on the phone** and download the file.
2. Open the downloaded `agni-rover.apk`. Android asks to allow installs from this source
   (your browser or file manager): allow it for this install.
3. If **Play Protect** warns that the app is from an unknown developer, that is because
   it is not from the Play Store. Check the SHA-256 below first, then choose **Install
   anyway**.
4. Open **Agni**, go to **Settings**, enter the **Pi address** and **access token**, and
   press **Connect rover** ([Step 8](#step-8-connect-the-app)).

**Check the download** before installing it, so you know it is this exact file. On a
computer:

```powershell
Get-FileHash agni-rover.apk -Algorithm SHA256      # Windows PowerShell
```

```bash
sha256sum agni-rover.apk                            # macOS: shasum -a 256 agni-rover.apk
```

The result must equal the SHA-256 in the table. If it does not, do not install it.

**It needs a rover running the matching version.** The app proves its token with a
challenge and signs every command; a rover deployed before that change cannot answer
it, and the app refuses a rover that does not ask. Deploy the rover from this same
version of the repo ([Updating the rover](#updating-the-rover-after-a-code-change)).

**Updating.** Install a newer APK over this one; your saved address, token and settings
stay. Android only allows this when the new APK is signed with the same key. If it says
*App not installed*, uninstall the old one first and enter the address and token again.

> **On GitHub.** The APK is stored with Git LFS (61 MB). GitHub's free LFS bandwidth is
> 1 GB a month, about 15 downloads. For a project people will download, attach the APK
> to a **GitHub Release** instead (**Releases → Draft a new release → attach the file**)
> and point the link above at it; Releases have no such limit.

---

## See the model detect fire

[![The fire model drawing a FIRE 68% box around a lighter flame, live on a webcam. Click to play the 38 second video.](docs/media/model-live-test.jpg)](docs/media/model-live-test.mp4)

*Click the picture to play the video (38 seconds, 1920×1020, 41 MB).*

**What it shows.** The fire and smoke model watching a laptop webcam, live, through
`model/live_test.py` in a browser. It is the same model the rover runs
(`best_nano_111`, YOLO11n exported to NCNN at 640 px), with the same confidence floor
(25 %). Recorded on 2026-10-11.

1. **An ordinary room.** The status line under the picture reads *nothing detected*.
   That is the correct answer, and the one the model gives most of the time.
2. **A lighter is lit in front of the camera.** An orange **FIRE** box appears around
   the flame with the model's confidence, 68 % in the picture above, and the status line
   switches to *1 detection(s)* with the time the pass took.
3. **The flame moves.** The box follows it from frame to frame.
4. **The flame goes out.** The box disappears and the status returns to *nothing
   detected*.

**How the model finds the fire**, on every frame:

| Step | What happens |
|---|---|
| Resize | the frame is scaled into a 640 × 640 square, padded rather than stretched, so a flame keeps its shape |
| Look | YOLO11n looks at the whole image in one pass and proposes boxes, each with a class (**Fire** or **Smoke**) and a confidence from 0 to 100 % |
| Filter | proposals below 25 % confidence are dropped |
| Merge | overlapping boxes for the same flame are merged into the strongest one (non-maximum suppression, overlap 0.45) |
| Draw | each remaining box is drawn with its class and confidence: orange for fire, grey-blue for smoke |

On the rover the same steps run on the Pi camera, plus three more: a second confidence
gate set by the app's sensitivity slider, tracking so one fire stays one alert, and
drawing the boxes onto the video the app shows. See [The detection model](#the-detection-model).

**What this video does not show.** Smoke (there is none in it), the Pi camera (this is
a laptop webcam, where one pass takes far less time than on a Pi 4), or performance at a
distance or in daylight. A lighter at arm's length is the easy case; treat the video as
proof that the model works, not as a measure of how well.

**Run it yourself**, with any flame or a fire video on another screen:

```bash
cd model
python live_test.py            # then open http://127.0.0.1:8777
```

> **Playing it on GitHub.** The picture links to the video file in the repo, which
> GitHub offers to view or download. For a player inside the README itself, edit this
> file on github.com and drag `docs/media/model-live-test.mp4` into the editor: GitHub
> uploads it and inserts a link that plays in place. Both files are stored with Git LFS,
> as `.gitattributes` sets for `.mp4` and `.jpg`.

---

## Screenshots

All screenshots are from the app on an Android phone, 2026-10-11. The app has four tabs:
**Control**, **Map**, **Alerts** and **Settings**.

### Control, driving

![The Control screen in landscape: the rover's live camera fills the screen, with the status bar at the top, the joystick bottom left, the L and R wheel bars and the ACCEL, SPRINT and BRAKE buttons bottom right, and the navigation rail on the left.](docs/screenshots/control-landscape.jpg)

The cockpit, with the phone turned sideways and the rover's camera filling the screen.

| Where | What it is |
|---|---|
| Top centre | status bar: Wi-Fi signal from the Pi (`-40dB`), battery (`—`, because no battery monitor is wired), GPS, **AI** (the model is running on the rover) and **LINK** (connected) |
| Top right | **MOTORS OFF ON ROVER**: `MOTOR_OUTPUT=0`, so drive commands arrive but the wheels are not driven; and the AR button |
| Left | the navigation rail: Control, Map, Alerts, Settings |
| Bottom left | the joystick |
| Bottom right | the L and R wheel bars, then **ACCEL**, **SPRINT** and **BRAKE** ([how they combine](#the-drive-buttons)) |

Taken early in bring-up. Two things have changed since: the pink tint came from the
camera's colour profile (see [Step 11](#step-11-tune-it)), and fire boxes are now drawn
into the video by the rover.

### Control, rover offline

![The Control screen in landscape with no rover connected: the status bar reads dashes, NO GPS, NO AI and OFF; the middle says Rover offline, Enter the Pi's address and token in Settings, then connect, with an Open Settings button; the joystick and drive buttons are dimmed.](docs/screenshots/control-offline-landscape.jpg)

With no rover, the screen says so rather than showing an empty or frozen picture. The
status bar shows dashes, **NO AI** and **OFF**, the drive controls are dimmed, and
**Open Settings** goes straight to where the address and token are entered.

### Map, Alerts and Settings

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/map-portrait.jpg" alt="The Map tab in portrait: an Area View title with 0 zones, a legend for fire, smoke and the rover with its camera view, a 2 metre ground grid with the rover at the origin and its camera's field of view drawn as a wedge, and TOP, zoom, reset and clear buttons on the right." width="260"></td>
    <td align="center" width="33%"><img src="docs/screenshots/alerts-portrait.jpg" alt="The Alerts tab in portrait: an All, Fire and Smoke filter, 0 events, and a card reading Rover offline, Reconnecting to rover, with an Open Settings button." width="260"></td>
    <td align="center" width="33%"><img src="docs/screenshots/settings-portrait.jpg" alt="The Settings tab in portrait: the Raspberry Pi rover connection card with the Pi address, a hidden access token and a Connecting button; the detection model status; detection sensitivity, auto-siren, in-app alerts and detection location; camera quality 720p; and About." width="200"></td>
  </tr>
  <tr>
    <td align="center"><b>Map</b></td>
    <td align="center"><b>Alerts</b></td>
    <td align="center"><b>Settings</b></td>
  </tr>
</table>

**Map.** The 3D area view, empty here because nothing has been detected (*0 zones*).
The rover sits at the origin of a 2 metre grid, with its camera's real field of view
drawn as the wedge in front of it; detections appear as markers placed by bearing. On the
right: **TOP** for a top-down view, zoom in and out, reset the view, and clear the map.
The note at the bottom says the rover is offline.

**Alerts.** Every fire and smoke detection of the session, filtered by **All**, **Fire**
or **Smoke**. Here there are none, and the card says why: the rover is offline and the
app is reconnecting, with a shortcut to Settings. No sample alerts are ever shown.

**Settings.** The connection card at the top: the **Pi address** (the app builds the
URLs from it; **Show full URLs** reveals them), the **access token**, hidden as it is
typed, and the connect button, here reading *Connecting* while the app retries. Below:
the on-device model's status and inference time (dashes while offline), detection
sensitivity at 74, auto-siren, in-app alerts and detection location, camera quality at
720p, and About. **Camera colour** appears under Camera once a Pi camera is connected.

These three were taken with the rover offline, which is the state they show.

---

## The rover

<table>
  <tr>
    <td width="50%"><img src="docs/photos/rover-overview.jpg" alt="The rover from above: a clear acrylic four-wheel chassis with yellow gear motors and black tyres, a three-cell lithium battery holder on the left, a red L298N motor driver in the middle, and a Raspberry Pi 4 on the right with the camera's white ribbon cable." width="100%"></td>
    <td width="50%"><img src="docs/photos/rover-side.jpg" alt="The rover from the side: the large yellow wheels, the Raspberry Pi 4 and the L298N with its wiring, and the three-cell battery holder." width="100%"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/photos/rover-electronics.jpg" alt="A closer view of the electronics: the Raspberry Pi 4, the camera ribbon cable leaving it, and the L298N motor driver with the jumper wires between them." width="100%"></td>
    <td width="50%"><img src="docs/photos/rover-top.jpg" alt="The rover from above, front to back: the Raspberry Pi 4 at the front, the L298N in the middle, and the three-cell battery holder at the back." width="100%"></td>
  </tr>
</table>

The build in these photos:

| Part | In the photos |
|---|---|
| Chassis | clear acrylic, four wheels, four yellow TT gear motors |
| Computer | Raspberry Pi 4 Model B |
| Camera | Camera Module v2 (imx219) on the white ribbon cable |
| Motor driver | L298N, the red board, wired as in [Step 9](#step-9-wire-the-motors) |
| Motor battery | three 18650 lithium cells in a holder, 11.1 V nominal |

Keep the camera ribbon away from the wheels and fixed to the chassis: on this rover it
worked loose while the motors were being wired, and the Pi stopped seeing the camera
(see [Troubleshooting](#troubleshooting)).

---

## Table of contents

- [Download the app](#download-the-app)
- [See the model detect fire](#see-the-model-detect-fire)
- [Screenshots](#screenshots)
- [The rover](#the-rover)
- [What it does, end to end](#what-it-does-end-to-end)
- [Architecture](#architecture)
- [Measured performance](#measured-performance)
- [Repository structure](#repository-structure)
- [Build it, step by step](#build-it-step-by-step)
- [Updating the rover after a code change](#updating-the-rover-after-a-code-change)
- [Using the app](#using-the-app)
- [The protocol](#the-protocol)
- [The detection model](#the-detection-model)
- [The 3D area view](#the-3d-area-view)
- [Ultrasonic range finding](#ultrasonic-range-finding)
- [Hardware and wiring](#hardware-and-wiring)
- [Configuration reference](#configuration-reference)
- [Design rules](#design-rules)
- [Safety](#safety)
- [Security](#security)
- [Development and verification](#development-and-verification)
- [Troubleshooting](#troubleshooting)
- [Change log](#change-log)
- [What to do next](#what-to-do-next)

---

## What it does, end to end

This is the product. Every change to this repo is judged against it.

1. **Connect, securely.** The app reaches the rover over Wi-Fi. You type the Pi's
   address and a token once; the app remembers them (the token in the phone's secure
   keystore), reconnects on its own with exponential backoff, and shows the real
   connection state on every screen. The token itself never crosses the network: the
   app answers a challenge, and every command after that is signed. See
   [Security](#security).
2. **Live video.** The Pi streams continuous MJPEG video, about 14 frames per second at
   720p on a Pi 4, captured and encoded once for every viewer. The app shows it with a
   native `<img>`, the way a browser shows `model/live_test.py`, so it neither blinks nor
   waits on script. A camera that stops delivering is reported as stopped, not left on
   screen looking live.
3. **Detect.** A YOLO model on the rover finds fire and smoke. The rover draws each box
   **onto the video frame itself**, so a box can never drift from the fire it marks, and
   the app shows a **Fire Detected** warning. Boxes leave the picture a few seconds after
   the model stops seeing them. The AR button switches between the boxed and the plain
   video.
4. **Map.** The same detections appear in a 3D scene you can orbit. Each one is placed by
   **bearing** from real lens geometry, at a range that is either **measured** by the
   ultrasonic sensor or **estimated** from apparent size. The two are never blurred.
5. **Drive.** A PUBG-style joystick drives the motors in any direction. ACCEL, SPRINT and
   BRAKE work **while your thumb is on the stick**, because every control tracks its own
   finger. BRAKE is a real hard stop, not just cutting power.
6. **Respond.** An optional flashlight and siren, the siren behind a confirmation because
   it is loud, plus an auto-siren on a fire detection. Each button appears only when its
   pin is wired, and shows the rover's real state.
7. **Adapt.** The UI fits phone and tablet, portrait and landscape, and respects notches
   and home indicators. Rotating the phone turns the Control screen into a full-screen
   cockpit with a side rail.

---

## Architecture

```
                 ┌──────────────────────── Raspberry Pi ────────────────────────┐
                 │                                                               │
  Pi Camera ────►│  rover_server.py  (one process: frame hub, HTTP, WebSocket,  │
  HC-SR04  ─────►│                    motors, watchdog, telemetry, security)    │
  L298N ◄────────│        │   ▲     frame hub: capture once, draw boxes,        │
                 │        │   │     encode once, push to every viewer           │
                 │        ▼   │ frames in, boxes out                            │
                 │  detector process  (fire_detector.py, YOLO on NCNN,          │
                 │                     2 threads, lower CPU priority)           │
                 └───────┬──────────────────┬──────────────────┬────────────────┘
                         │                  │                  │
               GET /stream.mjpg     GET /frame.jpg     WebSocket /control
               (one-time ticket)    (ticket or token)  (challenge, then signed)
                         │                  │                  │
                         ▼                  ▼                  ▼
                 ┌──────────────────────────────────────────────────────┐
                 │                 Expo app (native/)                   │
                 │        Control · Map · Alerts · Settings             │
                 └──────────────────────────────────────────────────────┘
```

Four design decisions shape the whole system.

**The server owns the camera; the model runs in a process of its own.** Picamera2 cannot
be opened by two processes, so `rover_server.py` holds the camera and hands frames to
the detector. The detector runs in a separate process because the NCNN inference
library holds Python's interpreter lock for its whole pass. When the model ran inside
the server, every 0.4 second pass froze the video, the telemetry and the drive
commands with it. In its own process it can take as long as it likes and the server
stays responsive.

**Video is a stream, captured once and shown natively.** One loop on the Pi reads the
camera, draws the detection boxes onto the frame, encodes it once, and pushes it to
every viewer the moment it exists; the model takes its frames from the same loop. The
app shows the stream with a plain `<img>`, decoded by the browser engine, exactly as
`model/live_test.py` shows a laptop webcam. Earlier versions swapped single photos
(Android blanked the picture on every swap) and then painted frames from script (extra
work per frame on the phone).

**The token never travels; every command is signed.** There is no TLS on a rover's local
Wi-Fi, so the protocol assumes someone else on the network can read every packet. The
app proves it holds the token by answering a random challenge, the rover proves the
same back, and every message after that is numbered and signed with a key for that
connection alone. Video opens with one-time tickets. A lost link can only ever stop
the car.

**The app is a thin, honest client.** It never invents data. Everything on screen came
from the rover, or is explicitly marked as an estimate, or is marked unavailable.

---

## Measured performance

Measured on a **Raspberry Pi 4 Model B (8 GB), Camera Module v2, Raspberry Pi OS 64-bit
(Debian 13 "trixie"), 2026-10-11**, with the app's video stream running, over Wi-Fi.

| What | Result |
|---|---|
| Live video stream | **13.9 to 14.8 fps**, about 80 to 88 KB per 720p frame |
| One frame from `/frame.jpg` | 130 to 200 ms |
| Server response time (`/status`) while the model runs | **about 3 ms** |
| Fire model, one pass at 640 px, 2 threads set at load, stream running | **about 670 ms** |
| Security and protocol checks (`verify_rover.py`, over Wi-Fi) | **22 of 22 pass** |
| SD card used after a full install | 8.6 to 8.8 GB of 29 GB |
| CPU temperature, model running, no heatsink | 67 to 74 °C |

How those numbers moved, on the same Pi:

| Change | Before | After |
|---|---|---|
| Model moved to its own process | video 1.9 fps, `/status` 340 ms | video 14.3 fps, `/status` 3 ms |
| Model threads limited to 2 (set after load) | 6,572 ms per pass | about 800 ms |
| Threads set **before** load, so they take effect | about 870 ms, 61,000 log warnings in 10 min | about 670 ms, no warnings |
| CPU-only PyTorch, no pip cache | 17.3 GB used | 8.8 GB used |

With 3 model threads instead of 2 the model was no faster and the video slightly slower,
which is why 2 is the default.

These are numbers from one setup. Run `verify_rover.py` against your own rover to get
yours.

---

## Repository structure

```
.
├── native/                      Expo / React Native app (TypeScript)
│   ├── App.tsx                  Root: fonts, gesture root, orientation shell, tabs
│   ├── app.json                 Expo config; allows http/ws to the rover on Android
│   ├── eas.json                 Build profiles; "preview" builds a sideloadable APK
│   │
│   ├── screens/
│   │   ├── ControlScreen.tsx    Live video, AR boxes, joystick, ACCEL/SPRINT/BRAKE,
│   │   │                        wheel bars, devices, status bar, fire warning
│   │   ├── MapScreen.tsx        Orbitable 3D scene, detections, ultrasonic, clear map
│   │   ├── HistoryScreen.tsx    Alert log for the session
│   │   └── SettingsScreen.tsx   Pi address, token, sensitivity, siren, camera
│   │
│   ├── domain/                  Pure logic: no React, no network, testable on numbers
│   │   ├── robot.ts             THE CONTRACT: every type that crosses the wire
│   │   ├── crypto.ts            SHA-256, HMAC and the signed-message session;
│   │   │                        the app's half of raspberry_pi/security.py
│   │   ├── drive.ts             Tank-drive mix, identical to the Pi's
│   │   ├── detectionView.ts     Box-to-screen mapping, live-box window, labels, times
│   │   ├── geometry.ts          Frame position to bearing; range measured or estimated
│   │   ├── rangeMap.ts          Ultrasonic pings to fading points in the scene
│   │   └── scene3d.ts           Orbit camera, perspective projection, near-plane clip
│   │
│   ├── features/robot/
│   │   └── RobotContext.tsx     Session: connection, telemetry, detections, drive
│   │                            commands, video stream state, map clearing
│   ├── services/
│   │   ├── robotGateway.ts      WebSocket lifecycle, challenge-response, signed
│   │   │                        messages, video tickets, backoff, message routing
│   │   └── storage.ts           Remembers the rover and settings; token in the
│   │                            Android Keystore / iOS Keychain
│   │
│   ├── components/
│   │   ├── LiveStream.tsx       Shows /stream.mjpg in a native <img>, as a browser does
│   │   ├── Joystick.tsx         Multi-touch stick on react-native-gesture-handler
│   │   ├── useOrientation.ts    Landscape detection and safe-area screen padding
│   │   └── Glass.tsx, icons.tsx, ui.tsx, anim.ts, AppGround.tsx
│   └── theme.ts                 Colour, font and radius tokens
│
├── raspberry_pi/                The rover service (Python, aiohttp)
│   ├── rover_server.py          Camera and frame hub, MJPEG stream with drawn boxes,
│   │                            WebSocket, motors, brake, driver lock, watchdog,
│   │                            telemetry, detector process management
│   ├── security.py              Challenge-response, signed messages, video tickets,
│   │                            lockout, strict JSON (the rover's half of crypto.ts)
│   ├── fire_detector.py         YOLO inference, thread limit, box tracking,
│   │                            detector-process entry
│   ├── range_sensor.py          HC-SR04 ultrasonic driver
│   ├── deploy.sh                Deploy to a Pi over SSH, with byte-for-byte checks
│   ├── verify_rover.py          Exercises every endpoint the app uses, attacks the
│   │                            control link, and reports each result
│   ├── agni-rover.service       systemd unit: starts at boot, sandboxed
│   ├── rover.env.example        Every setting, commented; becomes rover.env on the Pi
│   ├── requirements.txt
│   └── README.md                Rover-only details: endpoints, tuning, sensors
│
├── model/                       Offline. Nothing here is installed on the Pi.
│   ├── fetch_pretrained.py      Download already-trained weights
│   ├── export.py                Convert weights to NCNN for the Pi
│   ├── live_test.py             Watch the model detect live on your laptop webcam
│   ├── download_dataset.py      Fetch the Roboflow dataset (only to train)
│   ├── train.py                 Train YOLO11 locally (only to train)
│   ├── train_colab.ipynb        The same run on a free Colab or Kaggle GPU
│   ├── weights/                 Your weights and the NCNN export (not in git)
│   └── README.md
│
├── release/                     agni-rover.apk, the installable Android app (Git LFS)
├── docs/media/                  The model demo video and its preview picture (Git LFS)
├── docs/screenshots/            Screenshots of each app screen (Git LFS)
├── docs/photos/                 Photos of the built rover (Git LFS)
│
├── AGENTS.md                    Standing rules for anyone editing this repo
└── README.md                    You are here
```

`native/domain/robot.ts` and `raspberry_pi/rover_server.py` are **one contract**. Change
a field in either and change it in the other, then re-test the round trip. A silently
renamed field looks exactly like a sensor that stopped working.

---

## Build it, step by step

The whole path, in order, from an empty SD card to driving the rover from your phone
with fire boxes on the live video. Each step ends with a check.

| Step | You end up with | Takes |
|---|---|---|
| [0. What you need](#step-0-what-you-need) | parts and tools | |
| [1. Try it with no hardware](#step-1-try-it-with-no-hardware) | the whole stack on your laptop | 15 min |
| [2. Get the model](#step-2-get-the-model) | weights exported for the Pi | 10 min |
| [3. Train your own (optional)](#step-3-train-your-own-optional) | weights you trained | hours |
| [4. Prepare the Pi](#step-4-prepare-the-pi) | a Pi on Wi-Fi with camera and SSH | 30 min |
| [5. Set up SSH keys](#step-5-set-up-ssh-keys) | passwordless login from your PC | 5 min |
| [6. Deploy to the Pi](#step-6-deploy-to-the-pi) | the rover service running at boot | 20 min |
| [7. Run the app](#step-7-run-the-app) | the app on your phone | 10 min |
| [8. Connect the app](#step-8-connect-the-app) | live video and fire boxes | 5 min |
| [9. Wire the motors](#step-9-wire-the-motors) | an L298N wired to the Pi | 1 hour |
| [10. Enable and test the motors](#step-10-enable-and-test-the-motors) | a rover you can drive | 15 min |
| [11. Tune it](#step-11-tune-it) | right colours, right angles, right speed | |

---

### Step 0. What you need

**On your computer**

- Python 3.9 or newer, and Node.js 18 or newer.
- `ssh` and `tar`. macOS and Linux have both. On Windows, install
  [Git for Windows](https://git-scm.com/), which provides **Git Bash** with both.
- A phone on the same Wi-Fi as the Pi, with **Expo Go** installed, or an Expo account
  for a cloud APK build.

**Hardware**

| Part | Notes |
|---|---|
| Raspberry Pi 4 (2 GB or more) or Pi 5 | a Pi Zero 2 W runs the camera but not the model at a useful rate |
| Pi Camera Module v2 or v3 | a USB webcam also works |
| microSD card, 32 GB | the full install uses about 9 GB |
| Pi power supply or USB-C power bank, 5 V 3 A | **separate from the motor battery** |
| L298N motor driver | or a TB6612FNG |
| Chassis with 2 or 4 DC motors | yellow "TT" gear motors are typical |
| Motor battery, 7 to 12 V | e.g. 2 or 3 Li-ion 18650 cells in series |
| Jumper wires, female to female | about 7 |
| Heatsink or fan for the Pi | recommended; the model keeps the CPU busy |
| HC-SR04 ultrasonic sensor | optional, gives measured range |
| Resistors, 1 kΩ and 2 kΩ | required if you fit the HC-SR04 |

---

### Step 1. Try it with no hardware

Do this first even if your Pi is on the desk. It proves the app and the protocol work
before anything can be blamed on wiring. The rover service falls back to a webcam when
there is no Pi camera, and to a synthetic test frame when there is no webcam.

```bash
cd raspberry_pi
python -m pip install -r requirements.txt
ROVER_TOKEN=devtoken DETECTOR=1 python rover_server.py
```

In a second terminal:

```bash
cd raspberry_pi
python verify_rover.py --token devtoken --drive
```

`verify_rover.py` first checks the security code on known values, then walks the same
path the app does: the token, a camera frame, the live stream, the challenge-response
handshake, telemetry, the settings round trip, the flashlight if wired, and with
`--drive` a drive command, the driver lock, brake from a second device and the safety
watchdog. Along the way it attacks the link as someone else on the Wi-Fi could, with
a wrong token, a replayed command, a forged one, an unsigned one and a reused video
ticket, and checks each is refused. It exits non-zero if anything failed.

**How you know it worked.** Every line says `PASS` or an explained `WARN`, and the
`Live stream` line shows a frame rate.

To see **just the model** detecting on your webcam, without the rover at all:

```bash
cd model
python live_test.py            # opens http://127.0.0.1:8777 in your browser
```

Hold a phone playing a fire video in front of the webcam and boxes appear. The rover
draws its boxes the same way, and the app shows the rover's stream the same way this
page does, with a plain `<img>`.

---

### Step 2. Get the model

**You do not have to train anything.** The reference project publishes weights already
trained on a 10,463-image fire and smoke dataset.

```bash
cd model
python -m pip install -r requirements.txt     # install PyTorch first, see model/README.md
python fetch_pretrained.py                    # 5.5 MB, classes Fire and Smoke
python export.py --weights weights/best_nano_111.pt
```

`export.py` converts the weights to **NCNN**, which runs several times faster than raw
PyTorch on the Pi's ARM CPU at the same accuracy. It writes
`model/weights/best_nano_111_ncnn_model/`, which `deploy.sh` copies to the Pi.

**How you know it worked.** `fetch_pretrained.py` prints `classes: ['Fire', 'Smoke']`,
and the export folder contains `model.ncnn.bin`, `model.ncnn.param` and
`metadata.yaml`.

**The input size is baked into the export.** `export.py` defaults to 640, so the rover
runs with `DETECT_IMGSZ=640`, which `rover.env` sets.

---

### Step 3. Train your own (optional)

Skip this unless you want to fine-tune on your own footage. Training on the same
dataset reproduces the pretrained weights rather than improving on them. You need a GPU.

```bash
cd model
ROBOFLOW_API_KEY=xxxx python download_dataset.py    # free key, about 1 GB
python train.py                                     # yolo11n, 640 px, early stopping
python export.py --weights runs/agni-fire-smoke/weights/best.pt
```

No GPU? Use `model/train_colab.ipynb` on a free Colab or Kaggle T4. Read the recall plot
before trusting a result: for a fire detector, **recall on `Fire` matters more than a
headline mAP**. Details are in [`model/README.md`](model/README.md).

---

### Step 4. Prepare the Pi

**Flash the SD card** with [Raspberry Pi Imager](https://www.raspberrypi.com/software/):

1. Choose your board, then **Raspberry Pi OS (64-bit)**. It must be 64-bit; PyTorch does
   not install on 32-bit. The Lite version is enough; the desktop version is easier if
   you will use a monitor.
2. Choose **Edit settings** when asked about customisation:
   - **Hostname:** for example `agni-rover`
   - **Username:** `pi`. The service file assumes it; another name works but needs care.
   - **Wi-Fi:** the network your **phone** will also use, and your country
   - **Services:** tick **Enable SSH**, with password authentication
3. Write the card, put it in the Pi and power on. The first boot takes 2 to 3 minutes.

**Connect the camera** with the Pi **powered off**. The ribbon's contacts face the board.
A Pi 5 uses the smaller 22-pin cable.

**Using a monitor (optional).** Plug a micro-HDMI cable into **HDMI 0**, the port
nearest the USB-C power socket, before powering on. If the screen stays blank, add
`video=HDMI-A-1:1920x1080@60` to the end of the single line in `cmdline.txt` on the
card's boot partition.

**Log in**, from your computer's terminal or directly at the monitor:

```bash
ssh pi@agni-rover.local        # or pi@<the Pi's IP address>
```

Then on the Pi:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

After it restarts, log in again and check the camera, the GPIO library and the address:

```bash
rpicam-hello --list-cameras             # your camera must be listed
python3 -c "import RPi.GPIO as G; print('GPIO ok', G.VERSION)"
hostname -I                             # the first number is the Pi's IP address
```

**GPIO on current Raspberry Pi OS.** Recent releases ship `python3-rpi-lgpio`, a
drop-in replacement for `RPi.GPIO` that works on both the Pi 4 and the Pi 5 with
current kernels. If the GPIO check fails, install it:

```bash
sudo apt install -y python3-rpi-lgpio
```

Do **not** install `python3-rpi.gpio` instead. On a current kernel the old library can
fail to drive the motors, and installing it removes `python3-rpi-lgpio`.

**Give the Pi a fixed address.** In your router's settings, add a DHCP reservation for
the Pi. Otherwise its address can change after a restart and the app will point at the
wrong machine.

**How you know it worked.** SSH gives you a `pi@agni-rover:~ $` prompt, the camera is
listed, `GPIO ok` prints, and you have written down the IP address.

---

### Step 5. Set up SSH keys

`deploy.sh` connects to the Pi a dozen times. A key lets it log in without asking for
the password each time. Run these **on your computer**, not on the Pi. On Windows, use
PowerShell; the prompt starts with `PS C:\`.

```powershell
ssh-keygen -t ed25519
```

Press Enter three times. Then send the key to the Pi, entering the Pi's password one
last time:

```powershell
# Windows PowerShell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@agni-rover.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

```bash
# macOS, Linux or Git Bash
cat ~/.ssh/id_ed25519.pub | ssh pi@agni-rover.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

**How you know it worked.** `ssh pi@agni-rover.local` logs in **without asking for a
password**.

> **Which terminal am I in?** A prompt like `PS C:\Users\you>` or `you@PC MINGW64 ~`
> is your computer. `pi@agni-rover:~ $` is the Pi. Run `deploy.sh` and
> `verify_rover.py` on your computer; run `sudo`, `apt` and `journalctl` on the Pi.

---

### Step 6. Deploy to the Pi

`deploy.sh` copies the service and your model, installs the dependencies, writes
`rover.env` with a freshly generated token, installs the systemd service so the rover
starts at boot, and checks that it answers.

On Windows, open the `raspberry_pi` folder in File Explorer, right-click an empty area,
choose **Show more options**, then **Open Git Bash here**. On macOS or Linux, `cd` into
`raspberry_pi`. Then:

```bash
bash deploy.sh pi@agni-rover.local
```

> **Type commands into Git Bash rather than pasting them.** Pasting from a web page or
> chat can carry invisible characters, which show up as errors like
> `bash: $'\302\226cd': command not found`.

The first run takes **10 to 20 minutes**, most of it PyTorch. The script installs the
**CPU-only** PyTorch build: the default build for ARM pulls in about 4 GB of NVIDIA GPU
libraries that a Pi cannot use. It also keeps no download cache, which would cost
another 3 GB of SD card.

Every copy is **checked byte for byte**. If a file arrives different, or empty, the
script stops with an error and restarts nothing.

**When the script ends with `== Deployed.`** it prints the address and token for the
app. Write the token down.

**If `sudo` on your Pi asks for a password,** the script cannot install the service by
itself and stops with `sudo: a password is required`. Everything else is already done.
Finish by hand on the Pi:

```bash
sudo cp ~/agni/agni-rover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agni-rover
```

What that does: the first line gives the service file to systemd, Linux's service
manager. The second makes systemd read it. The third (`enable`) starts the rover at
every boot and (`--now`) starts it immediately. From then on the rover restarts itself
three seconds after any crash, stops the motors when it is stopped, and logs to the
system journal. The unit also **sandboxes** the rover: it cannot gain privileges (no
`sudo` from inside it) and system folders are read-only to it.

Run the same three lines again whenever `agni-rover.service` itself changes; a deploy
copies the file but only you can install it.

**How you know it worked.**

```bash
systemctl status agni-rover        # on the Pi: shows "active (running)"
journalctl -u agni-rover -n 30 --no-pager
```

The log should include:

```
Camera tuning: imx219_noir.json                     (only if CAMERA_TUNING is set)
Camera sensor mode: 1640x1232, full field of view
Camera source: picamera2
Fire detector running in its own process, classes=['Fire', 'Smoke']
```

If it says `Camera source: none` instead, the Pi did not find the camera at boot; see
[Troubleshooting → Video](#video).

And from your computer, the full check:

```bash
python verify_rover.py --host <pi-ip> --token <your-token>
```

Useful variants of the deploy:

```bash
bash deploy.sh pi@agni-rover.local --no-deps --no-service   # code only; see below
bash deploy.sh pi@agni-rover.local --model <path to an NCNN folder>
bash deploy.sh pi@agni-rover.local --no-model                # let the Pi download weights
```

**Re-running is always safe.** An existing `rover.env` is never overwritten, so your
token and settings survive every deploy.

---

### Step 7. Run the app

**With Expo Go**, for development and testing, which needs no build:

```bash
cd native
npm install
npx expo start
```

Scan the QR code with **Expo Go** (Android: the scan button inside Expo Go; iPhone: the
Camera app). The app reloads by itself when the code changes.

After installing a new native package, or pulling a version that added one, stop the
server with **Ctrl+C** and start it with `npx expo start --clear`; a running server does
not pick up new native modules, and `--clear` drops the old app code it cached. Then
close Expo Go fully on the phone and scan the QR code again.

**The app and the rover must be updated together** when the control link changes. An
app older than the rover cannot answer its challenge: the rover drops it after 5 seconds
and logs `no answer to the challenge (an app older than this rover)`.

The app uses these native modules, all included in Expo Go: `react-native-webview`
(video), `react-native-gesture-handler` (multi-touch controls), `expo-crypto` (secure
random numbers for the handshake) and `expo-secure-store` (the token in the keystore).

**A ready-built APK** is in the repo: see [Download the app](#download-the-app). Build
your own only after changing the app.

**As an installable APK**, to keep on the phone:

```bash
cd native
npx eas-cli login
npx eas-cli build --platform android --profile preview
```

It builds on Expo's servers in 10 to 20 minutes and gives you a download link. An APK
contains the code it was built with, so **rebuild after any app change**. Your saved
rover address and token survive reinstalling over the old version. To publish a new
build, replace `release/agni-rover.apk`, then update the version, date, size and
SHA-256 in [Download the app](#download-the-app).

The app allows plain `http://` and `ws://` traffic to the rover on Android
(`usesCleartextTraffic` in `app.json`). Release builds block it by default, and without
this setting an installed APK cannot reach the rover at all.

---

### Step 8. Connect the app

Your phone must be on **the same Wi-Fi as the Pi**.

In the app, open **Settings** and enter:

| Field | Value |
|---|---|
| Pi address | the Pi's IP from `hostname -I`, for example `10.106.61.214` |
| Access token | `ROVER_TOKEN` from `~/agni/rover.env`, printed by `deploy.sh` |

Press **Connect rover**. The app builds both URLs from the address
(`http://<ip>:8000/frame.jpg` and `ws://<ip>:8000/control`). Add `:port` to the address
if you changed `HTTP_PORT`. **Show full URLs** reveals them for hand editing. The token
is stored in the phone's keystore and never sent: Settings shows **Connected to rover
(authenticated)** once the handshake succeeds.

**How you know it worked**, in this order:

1. The status bar on **Control** shows **LINK** in green.
2. The live video appears and moves smoothly.
3. **AI** shows in orange: the model is running on the rover.
4. Battery shows `—`: no battery monitor is wired, so there is no number to show. That
   is correct, not a bug.
5. **MOTORS OFF ON ROVER** shows in orange until you enable the motors in Step 10.
6. Play a fire video on another screen and point the Pi camera at it. An orange
   **FIRE** box appears on the flames, drawn into the video by the rover, the **Fire
   Detected** warning appears, the detection is listed under **Alerts** and placed on
   the **Map**. The AR button turns the boxes off and on.

If it does not connect: check the address, check that the phone is on the same network,
and check that the network has no **client isolation**, which many guest and campus
networks use. A phone hotspot with the Pi joined to it is a quick way around that.

---

### Step 9. Wire the motors

Do this with **everything powered off**. The pin numbers are fixed in
`raspberry_pi/rover_server.py`; wire to exactly these.

**Signal wires, Pi to L298N**

| L298N pin | Pi GPIO (BCM) | Pi physical pin | Controls |
|---|---|---|---|
| ENA | GPIO 12 | **32** | left motor speed (PWM) |
| IN1 | GPIO 17 | **11** | left motor direction |
| IN2 | GPIO 27 | **13** | left motor direction |
| ENB | GPIO 13 | **33** | right motor speed (PWM) |
| IN3 | GPIO 22 | **15** | right motor direction |
| IN4 | GPIO 23 | **16** | right motor direction |
| GND | GND | **6** (or 9, 14, 20, 25, 30, 34, 39) | shared ground |

Physical pin 1 is the corner of the GPIO header marked with a square pad. Odd numbers
run along the inner row, even numbers along the board edge. `pinout` on the Pi prints
a map.

**On the L298N board**

- **Remove the two jumper caps on ENA and ENB.** With them on, the motors only run at
  full speed. Connect the Pi's wires to the ENA and ENB signal pins they uncover.
- **Keep the 5V-EN jumper** (next to the power terminals) if your motor battery is
  12 V or less. It powers the board's own logic.
- **Leave the board's 5V terminal unconnected.** Never connect it to the Pi's 5 V
  pins, and never power the Pi from it: it supplies about 0.5 A and a Pi 4 needs up
  to 3 A, so the Pi would reboot whenever the motors start.

**Power**

```
 Motor battery (+) ────────► L298N 12V terminal
 Motor battery (–) ──┬─────► L298N GND terminal
                     └─────► Pi GND (pin 6)      shared ground: required
 Power bank, USB-C ────────► Pi power port       the Pi has its own supply
```

The **shared ground** is essential. Without it the L298N cannot read the Pi's signals,
and "motors do nothing" is almost always this.

**Motors**

| L298N output | Connect to |
|---|---|
| OUT1, OUT2 | left motor, or both left motors in parallel |
| OUT3, OUT4 | right motor, or both right motors in parallel |

Which way round each motor's two wires go does not matter yet; Step 10 fixes direction.

**Battery voltage.** The L298N drops about 2 V. With 3 Li-ion cells (11.1 V nominal,
12.6 V full) the motors see up to about 9 V at full duty. `MAX_DUTY=0.65` keeps normal
driving near 6 V, right for TT motors; sprint at `0.9` goes above that, which is fine in
short bursts.

---

### Step 10. Enable and test the motors

The motors are off in software (`MOTOR_OUTPUT=0`) until you turn them on.

1. **Put the car on blocks**, so every wheel spins freely in the air.
2. Connect and switch on the motor battery.
3. On the Pi, set `MOTOR_OUTPUT=1`:

   ```bash
   nano ~/agni/rover.env        # change MOTOR_OUTPUT=0 to MOTOR_OUTPUT=1
   ```

   Save with Ctrl+O, Enter, then exit with Ctrl+X.
4. Restart the rover. It reads `rover.env` only when it starts:

   ```bash
   sudo systemctl restart agni-rover
   ```

5. From your computer, run the motion check. It sends one brief left-turn command and
   confirms the watchdog cuts power by itself afterwards:

   ```bash
   python verify_rover.py --host <pi-ip> --token <your-token> --drive
   ```

6. In the app, **MOTORS OFF ON ROVER** disappears. Try each control, still on blocks:

| Test | Expected |
|---|---|
| Stick forward | both sides spin forward |
| Stick fully left or right | one side forward, the other backward: a tank turn |
| Hold the stick, tap **SPRINT** | wheels speed up; SPRINT stays lit until tapped again |
| Hold **ACCEL** with the other thumb | forward drive while the stick steers |
| **SPRINT** on, then tap **ACCEL** and let go | **CRUISE**: wheels keep spinning forward with no thumb on a control |
| **BRAKE** during cruise | wheels stop sharply; CRUISE and SPRINT go out |
| Hold **ACCEL + BRAKE** | wheels spin **backward**; the button reads REVERSE |
| **BRAKE** while driving | wheels stop sharply |
| Let go of everything | wheels stop within half a second |

**If something is wrong**

| On blocks | Fix |
|---|---|
| Only the right side runs backwards | set `RIGHT_REVERSED=1` in `rover.env`, restart |
| Only the left side runs backwards | swap that motor's two wires at OUT1/OUT2 |
| Left and right are swapped | swap the motor pairs between OUT1/OUT2 and OUT3/OUT4 |
| Nothing moves | check the shared ground, the ENA/ENB caps, `MOTOR_OUTPUT=1`, the restart, and the battery switch |

**If the wheels turn on blocks but the car will not rotate on the floor,** the motors
lack the torque to skid-turn at 65 %, common on carpet. Raise `MAX_DUTY` a little, or
turn with SPRINT on.

**If anything spins wildly or will not stop, switch off the motor battery.** That stops
the motors whatever the software is doing.

---

### Step 11. Tune it

**Camera colour.** If the video looks slightly pink or blue, open **Settings → Camera →
Camera colour** in the app and pick a preset. It changes live. **Daylight** is the
default, because automatic white balance turned a white wall pink in testing.

If **every** preset looks strongly pink or purple, it is not white balance. Measured on
the test rover, the green channel averaged 0.6 to 21 out of 255 in every preset, against
about 220 for red: green was being removed, not mis-weighted. That happens when the
colour profile does not match the sensor, typically a **Camera Module v2 NoIR** (no
infrared filter, usually a **black** board; the standard v2 is green) running the
standard profile. Set the NoIR profile in `rover.env` and restart:

```bash
CAMERA_TUNING=imx219_noir.json        # Camera Module v2 NoIR
```

The log then starts with `Camera tuning: imx219_noir.json`. If colours get worse, the
camera is a standard one: set `CAMERA_TUNING=` back to empty.

**Camera field of view.** Set `CAMERA_HFOV` to your lens, or the 3D map places every
detection at the wrong angle: Camera v2 is 62.2, v3 is 66, v3 Wide is 102. The rover
selects the sensor mode that uses the **whole sensor**. Left to choose, the camera picks
a 1920×1080 centre crop on the v2, which sees about 39° of its 62° and misses fires near
the edges.

**Detection sensitivity.** The slider in the app is a second, server-side confidence
gate on top of `DETECT_CONF`. 100 shows everything the model reports, including weak
guesses; around 70 is a good everyday setting. Filtered results are counted in
telemetry, not silently dropped.

**Speed.** `DETECT_INTERVAL` sets the pause between model passes, `DETECT_THREADS` the
model's CPU threads (2 is best on a Pi 4), `STREAM_FPS` the video frame rate. The thread
count is applied **when the model loads**: NCNN fixes it then, and changing it later
only produced a warning per layer per pass. If the Pi runs hot, fit a heatsink or fan:
a Pi 4 slows itself down from about 80 °C.

**Measured range.** Fit the ultrasonic sensor for measured rather than estimated
distance. See [Ultrasonic range finding](#ultrasonic-range-finding).

---

## Updating the rover after a code change

The Pi has its **own copy** of the rover code on its SD card. Changing a file on your
computer does not change the Pi's copy until you deploy it, and the running rover keeps
using the old code until it restarts. So an update is always three steps:

**1. Copy the code** (Git Bash in `raspberry_pi`, on your computer):

```bash
bash deploy.sh pi@agni-rover.local --no-deps --no-service
```

`--no-deps` skips reinstalling packages, so it takes seconds. `--no-service` skips the
step that needs `sudo`. Your `rover.env` is kept. The copy is verified byte for byte.

**2. Restart the rover** (on the Pi):

```bash
sudo systemctl restart agni-rover
```

**3. Check it** (on the Pi):

```bash
journalctl -u agni-rover -n 30 --no-pager
```

App changes reach Expo Go through `npx expo start` (with `--clear` after a native module
changes); an installed APK needs rebuilding. When the rover's protocol changes, update
the rover **and** the app before expecting them to connect.

**If `agni-rover.service` changed** (the deploy copies it but cannot install it):

```bash
sudo cp ~/agni/agni-rover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart agni-rover
```

**Day-to-day commands on the Pi**

| To | Command |
|---|---|
| See if the rover is running | `systemctl status agni-rover` |
| Watch the live log | `journalctl -u agni-rover -f` (Ctrl+C stops watching, not the rover) |
| Restart after editing `rover.env` | `sudo systemctl restart agni-rover` |
| Stop the rover | `sudo systemctl stop agni-rover` |
| Stop it starting at boot | `sudo systemctl disable agni-rover` |
| Find the Pi's address | `hostname -I` |
| Check free space | `df -h /` |
| Check temperature | `vcgencmd measure_temp` |
| Is the camera detected? | `rpicam-hello --list-cameras` (with the rover stopped) |
| Shrink the log | `sudo journalctl --vacuum-size=20M` |

---

## Using the app

**Control**

- The status bar shows Wi-Fi signal, battery, GPS, **AI** (the model is running on the
  rover) and **LINK** (connected). A value with no hardware behind it shows `—`.
- The **joystick** drives in any direction: push forward to go, to the side to turn on the
  spot, diagonally to curve. It springs back and stops the car when released.
- **ACCEL**, **SPRINT** and **BRAKE** are pedals for the other thumb, and combine as in
  [The drive buttons](#the-drive-buttons) below. Each tracks its own finger, so any of
  them works while the stick, or another button, is held.
- The **L/R bars** show what each side of the car is being told to do right now: green
  forward, red reverse, blue while sprinting. They use the same mix as the Pi.
- The **AR** button switches the video between the rover's boxed stream and the plain
  camera. The flashlight and siren buttons appear only when their pins are wired; the
  siren asks before it sounds.
- **ANOTHER DEVICE IS DRIVING** appears when a second phone holds the controls. Your
  stick does nothing until it lets go (3 seconds after its last command); BRAKE still
  works.
- **MOTORS OFF ON ROVER** appears while `MOTOR_OUTPUT=0`: commands arrive, the wheels
  are deliberately not driven.
- A **Fire Detected** or **Smoke Detected** warning shows the latest detection, how
  long ago it was seen, and a button to see it on the map.
- Switching tabs or leaving the app while driving stops the car.

### The drive buttons

| Press | The car | Button shows |
|---|---|---|
| Hold **ACCEL** | drives forward while held | ACCEL lit |
| Tap **SPRINT** | raises the speed ceiling from `MAX_DUTY` to `SPRINT_DUTY`; tap again to drop it | SPRINT ON |
| **SPRINT** on, then **ACCEL** | **cruise**: drives forward at sprint speed, and **keeps going after you let go of ACCEL** | **CRUISE** |
| Hold **ACCEL + BRAKE** together | **reverses** while both are held | **REVERSE** |
| Let go of ACCEL while BRAKE is still held | ends the reverse in a hard stop | BRAKE |
| Let go of BRAKE while ACCEL is still held | back to forward | ACCEL |
| **BRAKE** alone | hard stop: both motors shorted for 0.5 s; also ends cruise and sprint | BRAKE |
| The joystick, with any of the above | steers: cruise or reverse plus a sideways push curves the car | |

The L and R bars under the label show the mode: **DRIVE**, **SPRINT**, **CRUISE** (blue)
or **REVERSE** (red).

**Cruise stops** on BRAKE, on turning SPRINT off, when the link drops, when you leave the
Control screen or the app, and, as for any command, when the rover hears nothing for
0.45 s. It is the one way the car keeps moving with no thumb on a control, so practise
it on blocks first.

**Map.** Drag to orbit, **+** and **−** to zoom, **TOP** for a top-down view, the
crosshair to reset. The bin button clears the map; the Alerts tab keeps every detection.

**Alerts.** Every detection of the session, filterable by fire or smoke, with its
confidence and time. **Clear this session** empties it.

**Settings.** The Pi address and token, the connection button and its status message,
the model status and inference time, detection sensitivity, auto-siren, in-app alerts,
camera quality (480p, 720p, 1080p) and camera colour (shown only for the Pi camera).

---

## The protocol

### HTTP

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /stream.mjpg` | continuous MJPEG video at up to `STREAM_FPS`; `?overlay=1` draws the fire and smoke boxes onto it, as the app shows it | one-time ticket, or token |
| `GET /frame.jpg` | one JPEG frame | frame ticket, or token |
| `GET /control` | WebSocket upgrade, see below | challenge-response |
| `POST /detections` | publish a detection from an external detector | token |
| `GET /status` | liveness probe; the details need the token | open, minimal |

**The app never sends the token.** It authenticates the control socket by answering a
challenge, then asks over that socket for a **ticket** to open the video. A stream
ticket opens one stream and is then spent; a frame ticket lasts 30 seconds. Tools such
as `curl` and `verify_rover.py` may still send the token itself, as an `Authorization:
Bearer` header or a `?token=` parameter, but it then crosses the network in clear.

Ten failed attempts from one address within a minute lock that address out for a
minute (HTTP 429). The stream carries `Access-Control-Allow-Origin: *` because the app
reads it from a local page with no origin of its own; a ticket or the token still
gates every request.

Each part of the stream has a `Content-Length` header, and the app reads parts by
length rather than by searching for JPEG markers.

### WebSocket, connecting

`raspberry_pi/security.py` and `native/domain/crypto.ts` implement the same protocol
and are checked against each other on known values.

1. The rover sends `{"type": "challenge", "nonce": <128 random bits>}`.
2. The app picks its own random `clientNonce` and replies
   `{"type": "auth", "clientNonce", "mac": HMAC-SHA256(token, "agni-auth|nonce|clientNonce")}`.
   The token itself is never sent.
3. The rover checks the signature. A wrong one, or none within 5 seconds, closes the
   socket with code `4401` and counts towards the lockout.
4. Both sides derive a key for this connection only:
   `HMAC-SHA256(token, "agni-session|nonce|clientNonce")`. The rover replies
   `{"type": "authOk", "proof": HMAC-SHA256(key, "agni-server")}`, proving it holds
   the token too. The app refuses a rover that cannot, so an impostor at the rover's
   address is caught.
5. Every message after that, both ways, is an envelope
   `{"seq": n, "body": "<JSON as a string>", "mac": HMAC-SHA256(key, "c2r|n|body")}`
   (`r2c` from the rover). The sequence must increase, so a replayed packet is dropped,
   and a packet signed without the key is dropped, without closing the connection.

A rover with no `ROVER_TOKEN` skips this and sends `{"type": "hello", "auth": "none"}`.
An app that holds a token refuses such a rover, so the protection cannot be stripped
by something pretending to be an open rover.

Numbers must be finite: `NaN` and `Infinity` are refused at parse time, because the
drive clamp once turned a `NaN` throttle into full speed. Messages over 16 KB close
that one connection.

### WebSocket, app to rover

| Message | Fields | Effect |
|---|---|---|
| `drive` | `throttle`, `steering`, `sprint` | sets motor power and refreshes the watchdog; only from the device holding the controls |
| `brake` | none | hard stop: both motors shorted for 0.5 s, then released; accepted from **any** connected device |

Cruise and reverse need nothing new on the wire: the app sends them as ordinary `drive`
commands (throttle `1` or `-1`), repeated like any held command, so the watchdog still
stops the car if they stop arriving.
| `ticket` | `purpose` (`stream` or `frame`) | asks for a ticket to open the video |
| `device` | `device` (`flash` or `siren`), `enabled` | switches a GPIO output; telemetry confirms |
| `settings` | `settings` object | sensitivity, auto-siren, location, camera quality, white balance |

**One device drives at a time.** The first device to send `drive` holds the controls
while its commands keep arriving. Another device's `drive` is refused, and that device
is told so, until the holder has sent nothing for 3 seconds or disconnects. BRAKE is
never locked out: anyone connected can stop the car.

The app sends at most one `drive` every 50 ms, and repeats a held command every 120 ms.
That repeat is the heartbeat the rover's watchdog listens for. A stop is always sent at
once. A zero `drive` during a brake does not cut the brake short; any real stick
movement takes over from it immediately.

### WebSocket, rover to app

| Message | Carries |
|---|---|
| `telemetry` | rover name, battery, signal, motor output state, flashlight and siren availability and state, camera source, field of view, age of the newest camera frame, white balance availability, model status and inference time, ultrasonic status |
| `detection` | one fire or smoke event: kind, confidence, percent-of-frame box, time |
| `range` | one ultrasonic ping: distance, bearing, beam width, maximum range |
| `settings` | the rover's settings after applying yours |
| `ticket` | a ticket for the video, and how long it lasts |
| `control` | whether this device holds the controls, and why not |

Telemetry is sent on connect, every `TELEMETRY_INTERVAL` seconds, and immediately when
a device changes state, including the auto-siren starting or timing out.
`cameraFrameAgeMs` says how old the newest camera frame is: over 5 seconds, the app
shows the camera as failed and reopens the stream.

### Unavailable is an em dash, never zero

Any value with no hardware behind it is sent as `-1` and shown as `—`. A fabricated
battery reading of zero percent on a fire robot reads as a dead battery, and a range of
zero metres reads as an imminent collision.

---

## The detection model

**Which weights.** `best_nano_111` is YOLO11n trained by the reference project on the
Roboflow dataset below, with classes `Fire` and `Smoke`, exported to NCNN at 640 px.
`deploy.sh` copies it to `/home/pi/agni/model/` and points `MODEL_PATH` at it. Without
`MODEL_PATH`, the rover downloads pretrained YOLOv10 weights from Hugging Face on first
start and caches them.

**How it runs on the rover.** The server starts the model in a separate process
(`spawn`, not `fork`, so the child never inherits the camera's threads). Each pass, it
takes the frame hub's newest frame, shrinks it to the model's input width, and hands it
over; the model returns boxes as percentages of the frame. The process runs with
`DETECT_THREADS` threads, set before the network loads, at a lower CPU priority, so
video and drive commands always come first. If it crashes, the server reports it in
telemetry and starts a new one; the rover keeps driving throughout.

**Tracking.** A box overlapping one from the previous pass keeps the same ID, so one
fire updates one alert instead of creating a new one every pass. A track is forgotten
`DETECT_TRACK_TTL` seconds after it was last seen.

**On screen.** Boxes that pass the sensitivity gate are drawn **onto the video** by the
rover, in the same style as `model/live_test.py`, so the video shows exactly what the
alerts show. A box stays for a few passes after it was last seen (at least 3 seconds,
longer when inference is slow) so it does not blink between passes. The app draws
boxes itself only for a camera URL that is not the rover's.

**Format and size.** NCNN runs several times faster than a PyTorch checkpoint on the
Pi. An export bakes its input size in, so `DETECT_IMGSZ` must match it. Class names are
matched loosely: `Fire`, `fire`, `flame` and `smoke` all map onto the two kinds the app
draws; any other class is ignored.

To swap weights, use [`model/`](model/README.md) and deploy with `--model <folder>`.

---

## The 3D area view

The map is a real perspective scene. Drag to orbit, zoom with the buttons, or snap to
top-down; the bin button clears it.

**Bearing is real geometry.** Given the camera's horizontal field of view, a box's
position across the frame maps exactly to an angle, by undoing the perspective
projection rather than scaling linearly.

**Range is measured when it can be, and estimated otherwise.** If an ultrasonic ping
covered that bearing recently, the app uses the measurement and labels it measured.
Otherwise it estimates distance from apparent size, labels it estimated, and prefixes
it with a tilde. An estimate is good for ordering detections, not for navigating to
them.

| Camera | `CAMERA_HFOV` |
|---|---|
| Camera Module v2 | `62.2` (default) |
| Camera Module v3 | `66` |
| Camera Module v3 Wide | `102` |
| HQ Camera | depends on the lens |

Positions are rover-relative and true **at detection time**. Without wheel odometry the
app cannot know how far the rover has moved since, so the view is rover-centric rather
than pretending to be a world map.

---

## Ultrasonic range finding

An HC-SR04 turns range from a guess into a measurement, for the narrow cone it covers.
It stays off until you set both pins in `rover.env`:

```bash
RANGE_TRIG_PIN=5        # physical pin 29
RANGE_ECHO_PIN=6        # physical pin 31, behind a voltage divider
```

Bench-test it alone first, with the rover stopped:

```bash
RANGE_TRIG_PIN=5 RANGE_ECHO_PIN=6 python3 ~/agni/range_sensor.py
```

**The echo line needs a voltage divider:** 1 kΩ from ECHO to the Pi pin, 2 kΩ from the
Pi pin to ground. The sensor outputs 5 V and the Pi's GPIO is 3.3 V only. This is the one
step you cannot skip.

It measures one direction; it is **not** a scanner. Measured points fade after a few
seconds rather than leaving a trail that looks like a map and is not one. Every reading
carries its own bearing, so a sensor on a sweeping servo would draw a real map with no
app change.

A distance of `-1` means no echo: nothing in range, or a surface too soft or angled to
reflect. Flame reflects ultrasound poorly, so expect lost echoes pointing straight at a
fire. And the echo is the nearest surface in the cone, which may be in front of the fire.

---

## Hardware and wiring

| Part | Where |
|---|---|
| L298N motor driver | [Step 9](#step-9-wire-the-motors): full pin table, jumpers and power |
| Camera | ribbon connector, Pi off; `CAMERA_HFOV` and camera colour in [Step 11](#step-11-tune-it) |
| HC-SR04 | [Ultrasonic range finding](#ultrasonic-range-finding) |
| Flashlight | `FLASH_PIN`, for example BCM 24 (physical 18), through a transistor or relay |
| Siren or buzzer | `SIREN_PIN`, for example BCM 25 (physical 22), through a transistor or relay |
| Battery gauge | any command printing 0 to 100, in `BATTERY_CMD` |

A GPIO pin cannot power a lamp or a siren directly; switch the load with a transistor or
a relay module. The flashlight and siren work whether or not `MOTOR_OUTPUT` is on.

---

## Configuration reference

Every setting is an environment variable. On a deployed Pi they live in
`/home/pi/agni/rover.env`, created from
[`rover.env.example`](raspberry_pi/rover.env.example). Edit it on the Pi with
`nano ~/agni/rover.env`, then `sudo systemctl restart agni-rover`.

### Core

| Variable | Default | Effect |
|---|---|---|
| `ROVER_TOKEN` | none | shared secret. Without it the rover is **open** to the network |
| `ROVER_NAME` | `Ranger-01` | name shown in the app |
| `HTTP_PORT` | `8000` | listening port |
| `TELEMETRY_INTERVAL` | `2.0` | seconds between telemetry broadcasts |
| `BATTERY_CMD` | none | shell command printing 0 to 100; battery shows `—` without it |

### Camera and video

| Variable | Default | Effect |
|---|---|---|
| `STREAM_FPS` | `15` | frame rate of the `/stream.mjpg` live video the app shows |
| `CAMERA_HFOV` | `62.2` | lens field of view, in degrees; the map needs it |
| `CAMERA_AWB` | `daylight` | white balance at start; the app can switch it live |
| `CAMERA_TUNING` | none | libcamera tuning file, e.g. `imx219_noir.json` for a NoIR camera |
| `WEBCAM_INDEX` | `0` | which webcam to use when there is no Pi camera |

### Motors

| Variable | Default | Effect |
|---|---|---|
| `MOTOR_OUTPUT` | `0` | **dry run by default**; `1` actually drives the pins |
| `CONTROL_TIMEOUT` | `0.45` | seconds without a command before the motors stop |
| `MAX_DUTY` | `0.65` | normal speed ceiling, 0 to 1 |
| `SPRINT_DUTY` | `0.9` | sprint speed ceiling, 0 to 1 |
| `RIGHT_REVERSED` | `0` | flip the right motor's direction |
| `FLASH_PIN`, `SIREN_PIN` | `-1` | optional BCM outputs; `-1` hides the button in the app |
| `SIREN_HOLD` | `5.0` | seconds an auto-siren holds; a new fire extends it |

### Detector

| Variable | Default | Effect |
|---|---|---|
| `DETECTOR` | `0` | `1` runs the model on the rover (`rover.env` sets 1) |
| `MODEL_PATH` | none | local weights; without it, pretrained weights are downloaded |
| `DETECT_IMGSZ` | `320` | model input size; must match the export (`rover.env` sets 640) |
| `DETECT_INTERVAL` | `0.8` | seconds from the start of one pass to the next |
| `DETECT_THREADS` | `2` | CPU threads for the model; leaves cores for camera and video |
| `DETECT_CONF` | `0.25` | the model's own confidence floor |
| `DETECT_TRACK_TTL` | `3.0` | seconds a track survives after it was last seen |

### Ultrasonic

| Variable | Default | Effect |
|---|---|---|
| `RANGE_TRIG_PIN` | `-1` | BCM trigger pin; `-1` disables the sensor |
| `RANGE_ECHO_PIN` | `-1` | BCM echo pin, behind a divider |
| `RANGE_INTERVAL` | `0.25` | seconds between pings |
| `RANGE_SAMPLES` | `3` | pings per reading; the median is sent |
| `RANGE_BEARING` | `0` | degrees off the forward axis |
| `RANGE_BEAM_DEG` | `15` | cone width, used to match a detection to a ping |
| `RANGE_MAX_M` | `4.0` | beyond this an echo is lost, not far away |
| `RANGE_AIR_TEMP_C` | `20` | the speed of sound shifts about 0.6 m/s per degree C |

---

## Design rules

This is a public repo for a safety-critical demo. People will read it as a working
system, so it has to be one. The rules are written out in full in
[`AGENTS.md`](AGENTS.md).

1. **Nothing fake may look live.** No hardcoded detections, telemetry or alerts. No data
   means an empty state, never sample data.
2. **Every control must do something real.** A control whose feature does not exist, or
   whose hardware is not wired, does not appear.
3. **Unavailable is an em dash, not a zero.**
4. **Keep the contracts in sync.** The app's types and the Pi's JSON are one contract.
5. **Every state needs a state.** Loading, empty, error and offline are part of the
   feature.
6. **The rover is a physical machine.** Keep the watchdog, the dry-run default and token
   auth. Loud or physical actions get a confirmation.
7. **Verify, then report.** Compiling is not working.

---

## Safety

- **Motor output is off by default.** Set `MOTOR_OUTPUT=1` only after checking your
  wiring, and test with the car on blocks first.
- **The motors stop themselves** if no command arrives for 0.45 seconds, when the last
  app disconnects, when you switch tabs or leave the app while driving, and when the
  rover service stops.
- **The motor battery switch is the emergency stop.** It works whatever the software is
  doing.
- **Set `ROVER_TOKEN`.** Without it anyone on the network can drive the rover, sound the
  siren, and publish fake fire alerts. `deploy.sh` generates one.
- **Never power the Pi from the L298N's 5 V terminal**, and never connect that terminal
  to the Pi.
- **Fit the voltage divider** on the HC-SR04 echo line before connecting it.
- **This is a prototype.** It is not a certified fire-detection product. Do not test it
  against real fire without supervision and an extinguisher within reach. A fire video
  on a screen is enough to test detection.

---

## Security

### What is protected

| Threat | What stops it |
|---|---|
| Someone on the Wi-Fi reads your token from the traffic | it is never sent: the app answers a challenge instead |
| Someone replays a captured command later | every message is numbered; an old number is refused |
| Someone injects their own command into your connection | every message is signed with a per-connection key they do not have |
| A device pretends to be the rover to take your app's commands | the rover must prove it holds the token; the app refuses one that cannot |
| A captured video link is reused | video tickets work once (stream) or for 30 seconds (frame) |
| Someone guesses the token | 128 random bits, and ten failures lock that address out for a minute |
| A second phone with the token takes over mid-drive | one device drives at a time; the other is told, and can still brake |
| A malformed command (`NaN`, huge numbers, 1 MB of junk) | refused at parse time; numbers must be finite; messages over 16 KB are dropped |
| A slow or stuck phone stalls the rover for everyone | each client gets a 1 second send timeout and is dropped if it cannot keep up |
| A connection that never authenticates | dropped after 5 seconds |
| The token stored on the phone | in the Android Keystore or iOS Keychain, not plain storage |
| The rover process is compromised | systemd sandboxing: no privilege gain, system folders read-only |

`verify_rover.py` runs these attacks against a live rover and reports each one.

### What is not protected, and why

- **The video and telemetry are not encrypted.** Anyone on the Wi-Fi can watch the
  stream. Encrypting it needs TLS, and the app cannot trust a self-signed certificate
  without a native rebuild per rover. Treat the rover's Wi-Fi as able to see what the
  camera sees.
- **Nothing on Wi-Fi can stop someone jamming it** or forcing devices off the network
  with deauthentication frames. What this design guarantees is that losing the link can
  only ever **stop** the car: the watchdog cuts the motors 0.45 s after the last command.
  A router with WPA3, or WPA2 with **Protected Management Frames (802.11w)** enabled,
  makes forced disconnects much harder.
- **Anyone who learns the token has full control.** Keep `rover.env` private (it is
  `chmod 600`), do not paste the token into chats or screenshots, and change it if it
  leaks: generate a new one with `openssl rand -hex 16`, put it in `ROVER_TOKEN`,
  restart, and enter it in the app.
- **Tools that send the token directly** (`curl`, `verify_rover.py`) expose it on the
  network. Run them on a network you trust.

### Hardening the Pi

Run these on the Pi. Each one is optional, and each makes the rover harder to attack.

**1. SSH keys only, no passwords.** Do this only after [Step 5](#step-5-set-up-ssh-keys)
works, or you will lock yourself out:

```bash
echo "PasswordAuthentication no" | sudo tee /etc/ssh/sshd_config.d/10-keys-only.conf
sudo systemctl restart ssh
```

Check from your computer, in a **new** terminal, that `ssh pi@agni-rover.local` still
logs in before closing the old one.

**2. A firewall that allows only SSH and the rover:**

```bash
sudo apt install -y ufw
sudo ufw allow 22/tcp
sudo ufw allow 8000/tcp
sudo ufw enable
```

**3. The sandboxed service file.** After deploying, install the updated unit and
restart:

```bash
sudo cp ~/agni/agni-rover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart agni-rover
journalctl -u agni-rover -n 30 --no-pager      # check the camera and model started
```

**4. Keep it updated:** `sudo apt update && sudo apt full-upgrade -y` now and then.

**5. A strong Pi password**, even with SSH keys, for the monitor and `sudo`: `passwd`.

---

## Development and verification

```bash
# App
cd native
npm install
npx tsc --noEmit                        # type-check
npx expo export --platform android      # verify it bundles
npx expo start                          # run on a device with Expo Go

# Rover service, on a laptop
cd raspberry_pi
python -m pip install -r requirements.txt
ROVER_TOKEN=devtoken DETECTOR=1 python rover_server.py

# Rover checks, in another terminal. Exits non-zero if anything failed.
python verify_rover.py --token devtoken            # read-only, safe on a live rover
python verify_rover.py --token devtoken --drive    # also tests motion; use blocks
python verify_rover.py --host <pi-ip> --token <token>

# The model alone, on your webcam
cd model
python live_test.py
```

`verify_rover.py` is the quickest answer to "is it the app or the rover?". It walks the
same path the app does and names the first thing that broke.

| Change | The check |
|---|---|
| App code | `npx tsc --noEmit` and `npx expo export --platform android` |
| Rover service | run it, then `verify_rover.py` |
| Anything touching motion | `verify_rover.py --drive`, on blocks |
| Model or export | load the weights, run inference, report the measured numbers |

---

## Troubleshooting

### Connection

| Symptom | Cause and fix |
|---|---|
| App cannot reach the rover | wrong address, rover not running, or client isolation on the Wi-Fi. Check with `systemctl status agni-rover` on the Pi and `python verify_rover.py --host <ip> --token <token>` |
| Connected yesterday, not today | the Pi's address changed. Run `hostname -I` on the Pi, update Settings, and reserve the address on your router |
| Installed APK cannot connect, Expo Go can | the APK predates the cleartext setting or the signed control link; install the current `release/agni-rover.apk` or rebuild it |
| *App not installed* when updating the APK | the new APK is signed with a different key; uninstall the old app first |
| Play Protect blocks the install | it is not from the Play Store. Check the SHA-256 in [Download the app](#download-the-app), then **Install anyway** |
| `ssh: Permission denied` | wrong username or password, or the key was not installed; repeat [Step 5](#step-5-set-up-ssh-keys) |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` | you re-flashed the card. On your computer: `ssh-keygen -R agni-rover.local` |
| "The rover rejected the access token" | the token in Settings does not match `ROVER_TOKEN` in `~/agni/rover.env`. The app stops retrying so it does not trigger the lockout |
| "This rover is not asking for a token" | `ROVER_TOKEN` is empty on the rover, or something else answers at its address. Set the token, or clear it in the app for an open bench rover |
| "The rover could not prove it has this token" | a different token on each side, or another device is impersonating the rover. Check `rover.env` |
| HTTP 429, or the app cannot connect for a minute | ten failed attempts from your address; wait a minute |
| An old app version cannot connect to an updated rover | the control link changed; restart `npx expo start` or rebuild the APK |
| **ANOTHER DEVICE IS DRIVING** on the Control screen | a second phone holds the controls; it releases them 3 s after its last command. BRAKE still works |

### Video

| Symptom | Cause and fix |
|---|---|
| Video blinks | an old app version that swapped single frames; update the app |
| Video lags or stutters | check `verify_rover.py`'s `Live stream` rate. Below about 10 fps: confirm the log says `Fire detector running in its own process`, keep `DETECT_THREADS=2`, check the temperature, or lower `STREAM_FPS` |
| Video slightly pink or blue | pick **Daylight** or another preset in Settings → Camera colour |
| "Pi camera unavailable, retrying" | the stream stalled or the rover restarted; it reconnects by itself. If it persists, check `journalctl -u agni-rover` |
| `Camera source: none` in the log, or `rpicam-hello` says `No cameras available!` | the Pi did not find the camera at boot. See **Camera not detected** below |
| Video strongly pink or purple in every colour preset | colour profile mismatch, typically a NoIR camera: set `CAMERA_TUNING=imx219_noir.json`; see [Step 11](#step-11-tune-it) |
| `rpicam-hello` says the camera is busy | the rover owns the camera. `sudo systemctl stop agni-rover` first, then start it again |

**Camera not detected.** If the boot log has

```
imx219 10-0010: failed to read chip id 219
imx219 10-0010: probe with driver imx219 failed with error -121
```

or `vcgencmd get_camera` shows `detected=0`, the Pi cannot reach the camera through the
ribbon at all. No software setting fixes that. It happened on the test rover after the
motors were wired. With the Pi **powered off** (`sudo poweroff`, then unplug):

1. The cable is in the **CAMERA** socket (between the HDMI ports and the audio jack on a
   Pi 4), not **DISPLAY** (by the SD card).
2. At the Pi, the **silver contacts face the HDMI ports**; at the camera, they face the
   board. Each latch is closed and the cable does not slide when tugged gently.
3. The **small connector on the camera board** that joins the lens block to the board is
   pressed fully home. It works loose easily.
4. The ribbon has no crease, cut or sharp fold, especially near the wheels. Try a spare,
   or the same cable the other way round.

Power on, then check `rpicam-hello --list-cameras` lists `imx219` before restarting the
rover. The camera is only detected at boot, and connecting it powered can damage it.
Tape the ribbon to the chassis so it cannot flex near the wheels.

### Detection

| Symptom | Cause and fix |
|---|---|
| No **AI** in the status bar | the model is not running. Check `journalctl -u agni-rover` for the detector line and `MODEL_PATH` in `rover.env` |
| AI on, but no boxes on a fire | raise the sensitivity slider, get closer, fill more of the frame with the fire |
| Boxes on things that are not fire | lower the sensitivity slider to around 70 |
| Detections at the wrong angle on the map | `CAMERA_HFOV` does not match your lens |
| `No module named 'ncnn'` | on the Pi: `python3 -m pip install --break-system-packages ncnn` |

### Driving

| Symptom | Cause and fix |
|---|---|
| **MOTORS OFF ON ROVER** shows | `MOTOR_OUTPUT=0`; see [Step 10](#step-10-enable-and-test-the-motors) |
| Motors do nothing with output on | shared ground missing, ENA/ENB caps still on, battery off, or the rover was not restarted after the change |
| SPRINT, BRAKE or ACCEL ignored while holding the stick or another button | an old app version with single-touch controls; update the app and restart `npx expo start --clear` |
| The car keeps going forward on its own | cruise is on: the ACCEL button reads **CRUISE**. Tap BRAKE |
| Turns on blocks, not on the floor | not enough torque to skid-turn; raise `MAX_DUTY` or turn with SPRINT |
| One side runs backwards | `RIGHT_REVERSED=1`, or swap that motor's wires |
| Car stutters while driving | drive commands are delayed; check `/status` responds in a few ms (the model must be in its own process) and the Wi-Fi signal |

### Deploy and the Pi

| Symptom | Cause and fix |
|---|---|
| `sudo: a password is required` from `deploy.sh` | install the service by hand, see [Step 6](#step-6-deploy-to-the-pi); for updates use `--no-service` |
| `bash: ./deploy.sh: No such file or directory` | Git Bash is not in the `raspberry_pi` folder. Use **Open Git Bash here** in that folder, then `bash deploy.sh ...` |
| `command not found` with odd characters like `$'\302\226cd'` | invisible characters from pasting; type the command by hand |
| Rover exits straight after a restart, with no log | a source file on the Pi is empty or broken. Check `wc -l ~/agni/rover_server.py`, then redeploy; `deploy.sh` now verifies every file |
| SD card filling up | an old install pulled NVIDIA GPU libraries. On the Pi: `python3 -m pip cache purge`, then reinstall CPU-only PyTorch: `python3 -m pip install --break-system-packages --no-cache-dir --force-reinstall --no-deps --index-url https://download.pytorch.org/whl/cpu torch torchvision` and remove the `nvidia-*`, `cuda-*` and `triton` packages |
| Pi slows down when hot | above about 80 °C it throttles; fit a heatsink or fan. Check with `vcgencmd measure_temp` |
| Log full of `opt.num_threads 2 changed, convolution ... will use load-time value 4` | an older `fire_detector.py` that limited threads after loading. Deploy the current one, restart, then `sudo journalctl --vacuum-size=20M` |
| The app connects from the PC check but not from the phone, and the rover log shows nothing | the phone runs an older app. Restart with `npx expo start --clear`, close and reopen Expo Go; or rebuild the APK |
| Changes on the PC do not show on the rover | deploy them and restart; see [Updating the rover](#updating-the-rover-after-a-code-change) |

---

## Change log

What changed while bringing the rover up on real hardware, why, and how each change was
checked. Measurements are from the Pi 4 described under
[Measured performance](#measured-performance).

### Connection and security

| Problem found | Change | Checked by |
|---|---|---|
| The token travelled in clear in every video URL; anyone on the Wi-Fi could read it and drive | challenge-response with HMAC-SHA256; the token is never sent | `verify_rover.py`: wrong token refused, token never sent |
| Commands had no integrity check | every message numbered and signed with a per-connection key, both ways | replayed, forged and unsigned commands ignored; session survives |
| Nothing stopped a device impersonating the rover | the rover proves it holds the token; the app refuses one that cannot | the app's gateway run against an impostor server: refused |
| A `{"throttle": NaN}` command meant full speed | `NaN` and `Infinity` refused at parse time; numbers must be finite | a correctly signed `NaN` command: wheels stay at 0 |
| Unlimited token guesses | ten failures from one address lock it out for a minute | 9 refusals, then HTTP 429, even for the right token |
| Any second phone could take over mid-drive | one device drives at a time; BRAKE works from any | second device refused while the first drove, then stopped the car |
| One slow phone could stall telemetry and the watchdog | concurrent sends with a 1 s timeout; the watchdog never waits on the network | code review; broadcast and watchdog paths |
| `/status` revealed motor state to anyone | minimal without the token | `verify_rover.py` |
| Token kept in plain app storage | Android Keystore / iOS Keychain, migrated from the old copy | type-check and bundle |
| Rover process could use `sudo` | systemd sandbox: `NoNewPrivileges`, read-only system folders | `systemctl show` on the Pi: `NoNewPrivileges=yes`, `ProtectSystem=full` |
| An app older than the rover failed silently | the rover logs `no answer to the challenge` | code path |
| The app's crypto had to match Python's exactly | SHA-256, HMAC and sessions cross-checked against Python | 9 of 9 values identical, including RFC 4231 test 1 |

### Video

| Problem found | Change | Checked by |
|---|---|---|
| The feed blinked: the app swapped one photo for the next and Android blanked it each time | continuous MJPEG stream | stream at 13 to 15 fps |
| The camera saw 39° of its 62°: a centre-cropped sensor mode | the rover picks the full-view sensor mode (1640×1232 on a v2) | log: `Camera sensor mode: 1640x1232, full field of view` |
| Video lagged: each viewer captured and encoded on its own timer, and the app painted frames from script | one frame hub captures and encodes once and pushes immediately; the app shows a native `<img>`, as `live_test.py` does | both variants at once at 12.8 fps; page tested in headless Chrome |
| App-drawn boxes could drift from the picture | the rover draws boxes onto the frame (`?overlay=1`); AR switches it | drawn test frame inspected |
| A frozen camera looked live | telemetry reports the newest frame's age; the app reopens the stream | code path; stream ends after 3 s without a frame |
| Video pink in every white-balance preset: green near zero | NoIR colour profile via `CAMERA_TUNING`; live white-balance presets in Settings | channel means per preset measured on the Pi |
| "Camera not working" after wiring the motors | no software change: error -121, `detected=0`; ribbon reseat guide | kernel log and `vcgencmd get_camera` on the Pi |

### Model and performance

| Problem found | Change | Checked by |
|---|---|---|
| The model froze the whole server for 0.4 s of every 0.5 s | the model runs in its own supervised process, at lower priority | `/status` from 340 ms to 3 ms; video from 1.9 to 14.3 fps; crash recovery tested |
| Model threads changed after load had no effect and logged 61,000 warnings in 10 minutes | the thread count is set before the network loads | on the Pi: `ThreadLimitedNet`, 2 threads at load, no warnings |
| 4 GB of NVIDIA libraries and a 3.3 GB download cache on the SD card | CPU-only PyTorch, `--no-cache-dir` | 17.3 GB used down to 8.8 GB; model loads and runs |

### Driving

| Problem found | Change | Checked by |
|---|---|---|
| SPRINT, BRAKE and ACCEL ignored while a thumb held the stick | multi-touch joystick on `react-native-gesture-handler` | bundle; tested on the phone |
| BRAKE only cut power, so the car coasted | hard brake: both motor inputs high for 0.5 s, then released | pin log: all four inputs high at 100 % for 0.5 s |
| Switching tabs mid-drive kept the car driving | the Control screen stops the car when it goes away; so does leaving the app | code path |
| Sprint had to be held with a third thumb | SPRINT latches on a tap | used on the phone |
| ACCEL + SPRINT and ACCEL + BRAKE could not work: React Native's buttons share one touch responder, so a second button cancelled the first | ACCEL, SPRINT and BRAKE moved to native multi-touch gestures, like the stick | type-check and bundle |
| No way to keep driving forward hands-free, or to reverse with the buttons | ACCEL with SPRINT on latches **cruise**; ACCEL + BRAKE held **reverses** | every pedal combination run through `domain/drive.ts`: forward, cruise, reverse and reverse-while-turning give the expected wheel commands |

### Deploy and setup

| Problem found | Change | Checked by |
|---|---|---|
| An empty file reached the Pi and the rover exited silently at boot | `deploy.sh` refuses empty files and checks every copy byte for byte | redeploy: `service files copied and verified` |
| An installed APK could not reach the rover | `usesCleartextTraffic` for plain `http`/`ws` on the local network | build config |
| `python3-rpi.gpio` on current Raspberry Pi OS | documented: keep `python3-rpi-lgpio` | `GPIO ok` on the Pi |
| Entering two URLs by hand | the app asks for the Pi's address and builds both | 13 inputs tested, valid and invalid |
| No ready-made app to install | `release/agni-rover.apk`, version 1.0.0, with its SHA-256 in the README | the APK's bundled code checked for the handshake, signed messages, tickets, native video, drive pedals and keystore; cleartext allowed in its manifest |

---

## What to do next

### Once it drives

1. **Check the camera colour and field of view** ([Step 11](#step-11-tune-it)).
2. **Set the sensitivity** against a fire video: lower it until false boxes stop.
3. **Reserve the Pi's address** on your router.
4. **Fit a heatsink or fan** before long runs.
5. **Drive it off blocks**, in a space it can bump into safely, with
   `journalctl -u agni-rover -f` open on the first outing.

### Worth building next

None of these exist yet. They are the honest gaps, in the order they would pay off.

| Next | Why | Where it goes |
|---|---|---|
| Fine-tune on your own footage | the weights have never seen your camera, lighting or building | `model/train.py --model weights/best_nano_111.pt` |
| A battery monitor | battery is the one field with no hardware behind it | an INA219, then `BATTERY_CMD` |
| Record clips around a detection | a detection is a box and a log line; the evidence is gone a second later | `raspberry_pi/rover_server.py` |
| A servo-mounted ultrasonic sensor | one fixed sensor measures one bearing | `raspberry_pi/range_sensor.py` |
| GPS | `gpsLocked` is honestly false: there is no module | telemetry, then `MapScreen` |

---
