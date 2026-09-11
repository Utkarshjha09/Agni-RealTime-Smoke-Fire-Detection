# Agni — AR Smart Fire Detection Rover

A Raspberry Pi rover that looks for fire and smoke with a YOLO model running **on the
rover itself**, and an Android/iOS app that drives it, shows the live camera with AR
detection boxes drawn over it, places every detection in a real 3D view of the area,
and keeps a log of what it found.

Three parts, no cloud, no web app, no simulated data anywhere.

```
native/         Expo app     — drive, live camera + AR boxes, 3D map, alerts, settings
raspberry_pi/   Pi service   — camera, motors, ultrasonic, telemetry, fire/smoke model
model/          Offline only — dataset, training, and export for the Pi
```

> **This is a student prototype, not a certified fire-detection product.** It must not
> be relied on to protect people or property. Read [Safety](#safety) before wiring
> anything to a motor driver.

---

## Table of contents

- [What it does, end to end](#what-it-does-end-to-end)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Quick start](#quick-start)
- [The protocol](#the-protocol)
- [The detection model](#the-detection-model)
- [The 3D area view](#the-3d-area-view)
- [Ultrasonic range finding](#ultrasonic-range-finding)
- [Hardware](#hardware)
- [Configuration reference](#configuration-reference)
- [Design rules](#design-rules)
- [Safety](#safety)
- [Development and verification](#development-and-verification)
- [Troubleshooting](#troubleshooting)
- [Credits and licences](#credits-and-licences)

---

## What it does, end to end

This is the product. Every change to this repo is judged against it.

1. **Connect.** The app reaches the rover over Wi-Fi and shows the real connection
   state wherever you happen to be looking. It remembers the rover and reconnects on
   its own with exponential backoff.
2. **Live camera.** Once connected, the Pi camera feed is live in the app, paced by
   load rather than a blind timer so a slow Pi never queues frames behind itself.
3. **Detect.** A YOLO model running on the rover finds fire and smoke, and the app
   draws the boxes over the live feed as percent-of-frame overlays.
4. **Map.** The same detections appear in a real perspective 3D scene you can orbit.
   The rover sits at the origin, its true camera field of view is drawn on the
   ground, and each detection is placed by **bearing** from real lens geometry at a
   range that is either **measured** by the ultrasonic sensor or **estimated** from
   apparent size. The two are never blurred.
5. **Drive.** A game-style joystick drives the motors in any direction, with
   accelerate, sprint and brake beside it.
6. **Respond.** Optional flashlight and siren, the latter behind a confirmation
   because it is loud, plus an auto-siren that fires on a fire detection.
7. **Adapt.** The UI reflows for phone and tablet, portrait and landscape. Rotating
   the phone switches the Control screen into a full-bleed cockpit with a left rail.

---

## Architecture

```
                 ┌─────────────────────── Raspberry Pi ───────────────────────┐
                 │                                                            │
  Pi Camera ────►│  rover_server.py ───────► fire_detector.py  (YOLO on-device)
  HC-SR04  ─────►│      │        ▲                    │                       │
  L298N ◄────────│      │        │                    │ fire / smoke + boxes  │
                 │      │        └─── range_sensor.py │ (percent of frame)    │
                 └──────┼─────────────────────────────┼───────────────────────┘
                        │                             │
            ┌───────────┴──────────┐                  │
            │                      │                  │
      GET /frame.jpg       WebSocket /control ◄────────┘
      (JPEG, token)        (token, both directions)
            │                      │
            ▼                      ▼
      ┌──────────────────────────────────────┐
      │           Expo app (native/)         │
      │  Control · Map · Alerts · Settings   │
      └──────────────────────────────────────┘
```

Two design decisions drive the whole shape of this.

**The model runs on the rover, inside the service process.** Picamera2 cannot be
opened by two processes at once, so the server owns the camera and hands frames to
the detector. Inference runs beside the camera loop and the drive loop, which is why
driving stays responsive even when a pass is slow.

**The app is a thin, honest client.** It never invents data. Everything on screen came
from the rover, or is explicitly marked as an estimate, or is marked unavailable.

---

## Repository structure

```
.
├── native/                      Expo / React Native app (TypeScript)
│   ├── App.tsx                  Root: fonts, orientation shell, tab navigation
│   ├── index.js                 Expo entry point
│   ├── app.json                 Expo config (free rotation, icon, EAS project)
│   ├── eas.json                 Build profiles; preview builds a sideloadable APK
│   │
│   ├── screens/
│   │   ├── ControlScreen.tsx    Live camera, AR boxes, joystick, devices, telemetry
│   │   ├── MapScreen.tsx        Orbitable 3D scene with detections and ultrasonic
│   │   ├── HistoryScreen.tsx    Alert log for the current session
│   │   └── SettingsScreen.tsx   Endpoints, token, sensitivity, siren, quality
│   │
│   ├── domain/                  Pure logic, no React, independently testable
│   │   ├── robot.ts             THE CONTRACT: every type that crosses the wire
│   │   ├── geometry.ts          Frame position to bearing; range measured or estimated
│   │   ├── rangeMap.ts          Ultrasonic pings to fading points in the scene
│   │   ├── scene3d.ts           Orbit camera, perspective projection, near-plane clip
│   │   └── detectionView.ts     Labels, colours, relative times
│   │
│   ├── features/robot/
│   │   └── RobotContext.tsx     Session state: connection, telemetry, detections, pings
│   │
│   ├── services/
│   │   ├── robotGateway.ts      WebSocket lifecycle, backoff, message routing
│   │   └── storage.ts           Remembers endpoints and settings between launches
│   │
│   ├── components/              Glass panels, joystick, icons, animations, orientation
│   └── theme.ts                 Colour, font and radius tokens
│
├── raspberry_pi/                The rover service (Python, aiohttp)
│   ├── rover_server.py          HTTP + WebSocket server, motors, watchdog, telemetry
│   ├── fire_detector.py         YOLO inference and box tracking
│   ├── range_sensor.py          HC-SR04 ultrasonic driver
│   ├── requirements.txt
│   └── README.md                Wiring, tuning, safety, and testing without a Pi
│
├── model/                       Offline training. Nothing here is installed on the Pi.
│   ├── fetch_pretrained.py      Download already-trained weights
│   ├── download_dataset.py      Fetch the Roboflow dataset and fix its paths
│   ├── train.py                 Train YOLO11 locally
│   ├── train_colab.ipynb        The same run on a free Colab or Kaggle GPU
│   ├── export.py                Convert weights to NCNN for the Pi
│   └── README.md
│
├── AGENTS.md                    Standing rules for anyone editing this repo
└── README.md                    You are here
```

### Why `domain/` is separate from the screens

Everything in `native/domain/` is a pure function over plain data. No React, no
network, no side effects. That is what makes the geometry testable: bearings, range
fusion and the point fade are checked by running them directly on numbers, rather
than by looking at the screen and hoping.

`native/domain/robot.ts` and `raspberry_pi/rover_server.py` are **one contract**.
Change a field in either and you must change it in the other, then re-test the round
trip. That rule exists because a silently renamed field looks exactly like a sensor
that stopped working.

---

## Quick start

### 1. The rover

```bash
cd raspberry_pi
python3 -m pip install -r requirements.txt
ROVER_TOKEN=$(openssl rand -hex 16) DETECTOR=1 python3 rover_server.py
```

That starts the camera, the model, and the control server, with motor output still
disabled. Read [`raspberry_pi/README.md`](raspberry_pi/README.md) before enabling motors.

Find the Pi address with `hostname -I`, then check the service answers:

```bash
curl "http://<pi-ip>:8000/status"
curl -o frame.jpg "http://<pi-ip>:8000/frame.jpg?token=yourtoken"
```

### 2. The app

```bash
cd native
npm install
npx expo start          # press a or i, or scan the QR code with Expo Go
```

In **Settings**, fill in three fields and press Connect.

| Field | Value |
|---|---|
| Camera frame URL | `http://<pi-ip>:8000/frame.jpg` |
| Control WebSocket URL | `ws://<pi-ip>:8000/control` |
| Access token | your `ROVER_TOKEN` |

The phone and the Pi must be on the same network, and that network must not have
client isolation, which many guest and campus networks do.

All three can be preset at build time with `EXPO_PUBLIC_ROBOT_CAMERA_URL`,
`EXPO_PUBLIC_ROBOT_WS_URL` and `EXPO_PUBLIC_ROBOT_TOKEN`.

### 3. An installable APK

```bash
cd native
npx eas-cli login
npx eas-cli build --platform android --profile preview --clear-cache
```

### No hardware yet

The service runs on a laptop. Without Picamera2 it falls back to a webcam, and
without a webcam it serves a synthetic frame, so the entire app is usable before any
hardware exists.

```bash
cd raspberry_pi
pip install aiohttp numpy opencv-python-headless
ROVER_TOKEN=devtoken HTTP_PORT=8123 python rover_server.py
```

Point the app at your computer's LAN address on port 8123.

---

## The protocol

### HTTP

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /frame.jpg` | one JPEG frame from the camera | token |
| `GET /control` | WebSocket upgrade, see below | token |
| `POST /detections` | publish a detection from an external detector | token |
| `GET /status` | liveness probe, no camera content and no control | open |

The token may be sent as an `Authorization: Bearer` header or as a `?token=` query
parameter, because an image tag cannot set headers.

### WebSocket, app to rover

| Message | Fields | Effect |
|---|---|---|
| `drive` | `throttle`, `steering`, `sprint` | sets motor power and refreshes the watchdog |
| `brake` | none | stops both motors immediately |
| `device` | `device` (`flash` or `siren`), `enabled` | switches a GPIO output |
| `settings` | `settings` object | sensitivity, auto-siren, location, camera quality |

A held joystick resends `drive` every 120 milliseconds. That is deliberate. It is the
heartbeat the rover-side watchdog listens for.

### WebSocket, rover to app

| Message | Carries |
|---|---|
| `telemetry` | rover name, battery, signal, inference time, detector and sensor status, camera field of view |
| `detection` | one fire or smoke event with a percent-of-frame box and a confidence |
| `range` | one ultrasonic ping: distance, bearing, beam width, maximum range |
| `settings` | the rover settings after applying yours, so the app never drifts |

Telemetry is broadcast every `TELEMETRY_INTERVAL` seconds, and immediately on connect.

### Unavailable is an em dash, never zero

Any value with no hardware behind it is sent as `-1` and rendered as an em dash. A
fabricated battery reading of zero percent on a fire robot reads as a dead battery,
and a range of zero metres reads as an imminent collision. Both are worse than an
honest blank.

---

## The detection model

The rover can run pretrained weights with **no training at all**. On first run it
downloads a fire and smoke model from Hugging Face and caches it, so later runs work
offline.

To fetch or swap weights, use [`model/`](model/README.md).

```bash
cd model
python fetch_pretrained.py                              # already-trained weights
python export.py --weights weights/best_nano_111.pt     # NCNN, for the Pi
```

Then on the Pi:

```bash
MODEL_PATH=/home/pi/best_nano_111_ncnn_model DETECT_IMGSZ=640 DETECTOR=1 \
  ROVER_TOKEN=yourtoken python3 rover_server.py
```

`MODEL_PATH` overrides the download entirely, so the rover runs your weights and
never reaches the network for a model.

**Training your own** uses the 10,463-image Roboflow dataset behind
[sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11](https://github.com/sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11),
with classes `Fire` and `Smoke`. Run it on a free Colab or Kaggle GPU with
`model/train_colab.ipynb`, or locally with `model/train.py`. A full early-stopped run
is hours on a GPU and days on a CPU. Details and the dataset licence are in
[`model/README.md`](model/README.md).

**Export format matters on the Pi.** NCNN runs markedly faster than a raw PyTorch
checkpoint on an ARM CPU at the same accuracy. An export bakes its input size in, so
whatever you export at must match `DETECT_IMGSZ` on the rover.

Class names are matched loosely, so `Fire`, `fire`, `flame` and `smoke` all map onto
the two kinds the app draws. Any other class is ignored.

---

## The 3D area view

The map is a real perspective scene, not a 2D plane with a rotation applied to it.
Points have depth, so markers sit at true positions and the view can be flown around.
Drag to orbit, use the buttons to zoom, or snap to top-down.

Each detection is placed from two numbers of very different quality, and the app is
explicit about which is which.

**Bearing is real geometry.** Given the camera horizontal field of view, where a box
sits across the frame maps to an angle exactly, by undoing the perspective projection
rather than scaling the angle linearly.

**Range is measured when it can be, and estimated otherwise.** If an ultrasonic ping
covered that bearing recently, the app uses the measurement and labels it measured.
Otherwise it infers distance from apparent size against an assumed source height,
labels it estimated, and prefixes it with a tilde. An estimate is useful for ordering,
as in that one is further away, not for navigation.

Set `CAMERA_HFOV` on the Pi to match your camera module, or every detection appears at
the wrong angle.

| Camera | `CAMERA_HFOV` |
|---|---|
| Camera Module v2 | `62.2` (default) |
| Camera Module v3 | `66` |
| Camera Module v3 Wide | `102` |
| HQ Camera | depends on the lens fitted |

Positions are rover-relative and true **at detection time**. Without wheel odometry
the app cannot know how far the rover has since moved, so the view is honest about
being rover-centric rather than pretending to be a world map.

---

## Ultrasonic range finding

An HC-SR04 turns range from a guess into a measurement, for the narrow cone it covers.
It stays off until you set both pins.

```bash
RANGE_TRIG_PIN=5 RANGE_ECHO_PIN=6 DETECTOR=1 ROVER_TOKEN=yourtoken python3 rover_server.py
```

Bench-test it on its own first with `python3 range_sensor.py`.

The app uses each ping twice. It draws the measured surface as a point in the 3D
scene, fading as it ages, and it upgrades any detection inside the cone from an
estimated range to a measured one.

### What one fixed sensor can and cannot do

It measures distance in one direction. It is **not** a scanner. A single fixed sensor
cannot map a room, because it only looks one way, and the rover has no odometry or
inertial sensor to place older readings once it has moved. Measured points therefore
age out after a few seconds, rather than leaving a trail that looks like a map and is
not one.

Every reading carries its own bearing, which is the whole point. Mount the sensor on a
servo, sweep it, and report the angle with each ping, and the app draws a genuine
sweep of the surroundings with **no app change and no contract change**.

### A lost echo is not zero metres

A distance of `-1` means no echo came back: nothing within range, or a surface too
soft or too angled to reflect. The app renders it as no echo. Flame reflects
ultrasound poorly, so expect lost echoes pointing straight at a fire.

A related caveat, which the detail popover states: ultrasound returns the nearest
surface in the cone, which may be an object in front of the fire rather than the fire
itself.

---

## Hardware

| Part | Notes |
|---|---|
| Raspberry Pi 4 or 5 | a Pi 4 manages roughly 1 to 2 inferences per second at 320px |
| Pi Camera Module | v2, v3, v3 Wide or HQ; set `CAMERA_HFOV` to match |
| Motor driver | L298N or TB6612FNG, two channels |
| Chassis, motors, wheels | any two-motor differential drive |
| HC-SR04 | optional, for measured range |
| Voltage divider | **required** on the HC-SR04 echo line |
| LED or lamp | optional flashlight, on `FLASH_PIN` |
| Buzzer or siren | optional, on `SIREN_PIN` |
| Battery pack | a separate supply for the motors |

### Motor driver, default BCM pins

| Signal | Pin |
|---|---|
| Left `IN1`, `IN2`, `PWM` | 17, 27, 12 |
| Right `IN1`, `IN2`, `PWM` | 22, 23, 13 |

Change the constants at the top of `rover_server.py` to match your wiring, and set
`RIGHT_REVERSED=1` if the right side turns the wrong way.

### HC-SR04

| Sensor | Pi |
|---|---|
| VCC | 5V |
| TRIG | `RANGE_TRIG_PIN` (BCM) |
| ECHO | **voltage divider**, then `RANGE_ECHO_PIN` |
| GND | GND |

The echo pin idles at 5V and the Pi GPIO is 3.3V only. Fit a divider, 1k from the echo
line to the pin and 2k from the pin to ground. This is the one step you cannot skip.

---

## Configuration reference

Everything is an environment variable on the rover service.

### Core

| Variable | Default | Effect |
|---|---|---|
| `ROVER_TOKEN` | none | shared secret. Without it the rover is **open** |
| `ROVER_NAME` | `Ranger-01` | name shown in the app |
| `HTTP_PORT` | `8000` | listening port |
| `TELEMETRY_INTERVAL` | `2.0` | seconds between telemetry broadcasts |
| `BATTERY_CMD` | none | shell command printing 0 to 100; unavailable without it |

### Motors

| Variable | Default | Effect |
|---|---|---|
| `MOTOR_OUTPUT` | `0` | **dry-run by default**; `1` actually drives the pins |
| `CONTROL_TIMEOUT` | `0.45` | seconds without a packet before the motors stop |
| `MAX_DUTY` | `0.65` | normal speed ceiling |
| `SPRINT_DUTY` | `0.9` | sprint speed ceiling |
| `RIGHT_REVERSED` | `0` | flip the right motor direction |
| `FLASH_PIN`, `SIREN_PIN` | `-1` | optional BCM outputs |
| `SIREN_HOLD` | `5.0` | seconds an auto-siren holds; a new fire extends it |

### Detector

| Variable | Default | Effect |
|---|---|---|
| `DETECTOR` | `0` | `1` runs the model on the rover |
| `MODEL_PATH` | none | use local weights instead of downloading |
| `DETECT_INTERVAL` | `0.8` | seconds between inference passes |
| `DETECT_IMGSZ` | `320` | input size; must match your export |
| `DETECT_CONF` | `0.25` | model confidence floor |
| `DETECT_TRACK_TTL` | `3.0` | seconds a box survives after it was last seen |
| `CAMERA_HFOV` | `62.2` | lens field of view, in degrees |

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

The **Detection sensitivity** slider in the app is a second, server-side confidence
gate on top of `DETECT_CONF`. Filtered results are counted and reported in telemetry
rather than silently dropped.

---

## Design rules

This is a public repo for a safety-critical demo. People will read it as a working
system, so it has to be one. These rules are enforced on every change, and are written
out in full in [`AGENTS.md`](AGENTS.md).

1. **Nothing fake may look live.** No hardcoded detections, telemetry, device names or
   placeholder alerts rendered as if they came from the rover. No data means an empty
   state, never sample data.
2. **Every control must do something real.** A button or slider that is not wired to
   real state does not ship.
3. **Unavailable is an em dash, not a zero.**
4. **Keep the contracts in sync.** The app types and the Pi JSON are one contract.
5. **Every state needs a state.** Loading, empty, error and offline are part of the
   feature, not polish for later.
6. **The rover is a physical machine.** Keep the watchdog, the dry-run default and
   token auth intact. Loud or physical actions get a confirmation.
7. **Verify, then report.** Land changes with a real check, and say plainly what was
   and was not verified. Compiling is not working.

---

## Safety

- **Motor output is off by default.** Set `MOTOR_OUTPUT=1` only after checking your pin
  wiring against your driver.
- **The motors stop themselves.** Both stop if no command arrives for 0.45 seconds, or
  when the last operator disconnects.
- **Set `ROVER_TOKEN`.** Without it, anyone on the network can drive the rover, sound
  the siren, and publish fake fire alerts. The service prints a warning and runs open.
  Only do that on an isolated bench network.
- **Fit the voltage divider** on the HC-SR04 echo line before connecting it.
- **Never widen network access without auth.**
- **This is a prototype.** It is not a certified fire-detection product and must not be
  relied on as one. Do not test it against real fire without supervision and
  extinguishing equipment on hand.

---

## Development and verification

```bash
# App
cd native
npm install
npx tsc --noEmit                        # type-check
npx expo export --platform android      # verify it bundles
npx expo start                          # run on a device

# Rover service
cd raspberry_pi
python -m pip install -r requirements.txt
ROVER_TOKEN=devtoken DETECTOR=1 python rover_server.py
curl "http://127.0.0.1:8000/status"

# Training tools
cd model
pip install -r requirements.txt         # install PyTorch for your hardware first
```

Claims in this repo are meant to be backed by a real check. Type-check and bundle the
app, run the service and exercise the endpoint, then say plainly what was verified and
what was not.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| App cannot reach the rover | wrong address, service not running, or client isolation on the Wi-Fi |
| Connects, but no camera | camera URL wrong or missing; check the frame endpoint with curl first |
| Camera works, no detections | `DETECTOR=1` not set, or the sensitivity slider is too high |
| Detections at the wrong angle on the map | `CAMERA_HFOV` does not match your lens |
| Motors do nothing | `MOTOR_OUTPUT=1` not set, which is the deliberate default |
| Rover turns the wrong way | set `RIGHT_REVERSED=1` |
| Battery and signal show an em dash | no battery monitor wired; set `BATTERY_CMD` if you have one |
| Range always shows no echo | check the divider and the pins; soft or angled surfaces reflect nothing |
| Detector fails to load | `ultralytics` not installed, or `MODEL_PATH` points nowhere |
| Model slower than expected | exported larger than `DETECT_IMGSZ`, or running a PyTorch checkpoint instead of NCNN |

---

## Credits and licences

- Pretrained fire and smoke weights, and the training dataset, come from
  [sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11](https://github.com/sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11)
  and its [Roboflow dataset](https://universe.roboflow.com/sayed-gamall/fire-smoke-detection-yolov11).
- The fallback pretrained model is
  [TommyNgx/YOLOv10-Fire-and-Smoke-Detection](https://huggingface.co/TommyNgx/YOLOv10-Fire-and-Smoke-Detection),
  Apache-2.0.
- Detection and training use [Ultralytics](https://github.com/ultralytics/ultralytics),
  which is AGPL-3.0. Check that licence before distributing a product built on it.

Check each upstream licence before reusing the weights or the dataset. They are not
covered by this repository's licence.
