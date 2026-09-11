# Raspberry Pi Rover Service

This service is the bridge between the Agni app, the Raspberry Pi camera, the
on-device fire/smoke model, and a two-channel motor driver such as an L298N or
TB6612FNG.

It exposes:

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /frame.jpg` | one JPEG frame from the camera | token |
| `GET /control` | WebSocket: drive, brake, devices, settings, telemetry, detections, range | token |
| `POST /detections` | publish a detection from an external detector | token |
| `GET /status` | liveness probe (no camera content, no control) | open |

## Install on the Pi

```bash
sudo apt update
sudo apt install -y python3-picamera2 python3-opencv python3-pip
python3 -m pip install -r requirements.txt --break-system-packages
```

`ultralytics` (and the PyTorch it pulls in) is only needed if you run the
on-device model. Skip those two lines of `requirements.txt` for a camera-and-motors-only
install.

## Security: set a token

The service controls a physical robot and a siren, so it is not open by default
in any deployment you should trust. Set a shared secret and enter the same value
in the app's **Settings → Access token**:

```bash
ROVER_TOKEN=$(openssl rand -hex 16) python3 rover_server.py
```

Without `ROVER_TOKEN` the service prints a warning and runs open — anyone on the
network could drive the rover or publish fake fire alerts. Only do that on an
isolated bench network.

## Connect the app

The phone and Pi must be on the same Wi-Fi network. In the app's **Settings**,
enter these using the Pi's LAN address:

```text
Camera frame URL:       http://192.168.1.50:8000/frame.jpg
Control WebSocket URL:  ws://192.168.1.50:8000/control
Access token:           the ROVER_TOKEN value
```

The app stores these, reconnects automatically, and restores them next launch.

## Fire and smoke detection on the rover

`fire_detector.py` runs the model **inside this service**, because Picamera2
cannot be opened by two processes at once. Enable it with:

```bash
DETECTOR=1 ROVER_TOKEN=yourtoken python3 rover_server.py
```

On first run it downloads pretrained YOLOv10 fire/smoke weights from
[`TommyNgx/YOLOv10-Fire-and-Smoke-Detection`](https://huggingface.co/TommyNgx/YOLOv10-Fire-and-Smoke-Detection)
(Apache-2.0, classes `fire` and `smoke`, ~0.85 mAP reported) and caches them, so
later runs work offline. **No training is required.**

Detections are converted to percent-of-frame boxes and pushed to every connected
app, which draws them over the live camera and places them on the map.

### Tuning

| Variable | Default | Effect |
|---|---|---|
| `DETECT_INTERVAL` | `0.8` | seconds between inference passes |
| `DETECT_IMGSZ` | `320` | input size; `416`/`640` are slower but more accurate |
| `DETECT_CONF` | `0.25` | model confidence floor |
| `DETECT_TRACK_TTL` | `3.0` | seconds a box stays after it was last seen |
| `MODEL_PATH` | — | use a local `.pt` instead of downloading |
| `CAMERA_HFOV` | `62.2` | camera horizontal field of view, degrees (see below) |

The defaults target a **Raspberry Pi 4**: roughly 1-2 inferences per second at
`imgsz=320`. On a Pi 5 try `DETECT_IMGSZ=416 DETECT_INTERVAL=0.5`. The camera feed
itself is unaffected — detection runs beside it, so driving stays responsive even
when inference is slow.

### Camera field of view (needed by the 3D view)

The app converts each detection's position in the frame into a real bearing, which
only works if it knows the lens. Set `CAMERA_HFOV` to match your camera:

| Camera | `CAMERA_HFOV` |
|---|---|
| Camera Module v2 | `62.2` (default) |
| Camera Module v3 | `66` |
| Camera Module v3 Wide | `102` |
| HQ Camera | depends on the lens you fitted |

Get this wrong and detections will appear at the wrong angle on the map.

The app's **Detection sensitivity** slider sets a second, server-side confidence
gate on top of `DETECT_CONF`; filtered results are counted and reported in
telemetry rather than silently dropped.

### Running the YOLO11 weights from `model/`

The repo's `model/` folder produces an NCNN export, which runs markedly faster on
the Pi's ARM CPU than a PyTorch `.pt` at the same accuracy. Copy the exported
folder across and point the service at it:

```bash
MODEL_PATH=/home/pi/best_nano_111_ncnn_model DETECT_IMGSZ=640 DETECTOR=1   ROVER_TOKEN=yourtoken python3 rover_server.py
```

`DETECT_IMGSZ` must match the size the model was exported at: an export bakes its
input size in. The `model/` exports default to 640 because 320 measurably missed
distant smoke these weights found at 640. If 640 is too slow to drive against on a
Pi 4, re-export at 416 and set `DETECT_IMGSZ=416` on both sides.

See `model/README.md`.

### Using your own weights

Anything ultralytics can load works, including a model fine-tuned on the
[Roboflow fire-and-smoke dataset](https://universe.roboflow.com/middle-east-tech-university/fire-and-smoke-detection-hiwia)
or the YOLOv8 weights from
[Abonia1/YOLOv8-Fire-and-Smoke-Detection](https://github.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection):

```bash
MODEL_PATH=/home/pi/best.pt DETECTOR=1 python3 rover_server.py
```

Class names are matched loosely, so `Fire`, `fire`, `flame`, `smoke` all map onto
the two kinds the app displays. Any other class is ignored.

### External detectors

You can still POST detections from another machine or a sensor:

```bash
curl -X POST http://192.168.1.50:8000/detections \
  -H "Authorization: Bearer $ROVER_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"fire","confidence":92.1,"location":"Front camera",
       "boundingBox":{"left":20,"top":34,"width":40,"height":26},
       "confirmedBySensor":true}'
```

`boundingBox` values are percentages of the frame. `confirmedBySensor` marks a
detection that a physical sensor (not just the camera) agreed with; the app
badges those.

## Ultrasonic range finding

An HC-SR04 gives the 3D map a real measured distance, instead of the range the app
otherwise infers from how large a detection looks. Off until you set both pins:

```bash
RANGE_TRIG_PIN=5 RANGE_ECHO_PIN=6 MOTOR_OUTPUT=1 DETECTOR=1   ROVER_TOKEN=yourtoken python3 rover_server.py
```

Bench-test the sensor on its own first:

```bash
RANGE_TRIG_PIN=5 RANGE_ECHO_PIN=6 python3 range_sensor.py
```

### Wiring

| HC-SR04 | Pi |
|---|---|
| VCC | 5V |
| TRIG | `RANGE_TRIG_PIN` (BCM) |
| ECHO | **voltage divider**, then `RANGE_ECHO_PIN` |
| GND | GND |

ECHO idles at 5V and the Pi's GPIO pins are 3.3V only. Put a divider on it, 1k from
ECHO to the pin and 2k from the pin to ground, or you will damage the Pi. This is
the one step you cannot skip.

| Variable | Default | Effect |
|---|---|---|
| `RANGE_TRIG_PIN` | `-1` | BCM trigger pin; `-1` disables the sensor |
| `RANGE_ECHO_PIN` | `-1` | BCM echo pin, behind a divider |
| `RANGE_INTERVAL` | `0.25` | seconds between pings |
| `RANGE_SAMPLES` | `3` | pings per reading; the median is sent |
| `RANGE_BEARING` | `0` | degrees off the forward axis, if you angled the sensor |
| `RANGE_BEAM_DEG` | `15` | cone width, used to match a detection to a reading |
| `RANGE_MAX_M` | `4.0` | beyond this an echo is lost, not far away |
| `RANGE_AIR_TEMP_C` | `20` | speed of sound varies ~0.6 m/s per degree C |

### What one fixed sensor can and cannot do

It measures distance along one direction. That is a real measurement, and the app
uses it two ways: a measured surface point on the 3D map, and a measured range for
any fire or smoke detected inside the cone, which replaces the size-based estimate.

It is **not** a scanner. One fixed sensor cannot map a room, because it only ever
looks one way and the rover has no wheel odometry or IMU to place older readings
once it has moved. The app therefore ages measured points out after a few seconds
rather than leaving a trail that looks like a map and is not one.

Every reading carries its own bearing, so this is the only change needed to fix it:
put the sensor on a servo, sweep it, and report the angle with each ping. The app
already draws readings at whatever bearing arrives, so a sweep becomes a real map
of the surroundings with no app change and no contract change.

### Lost echoes are not zero

A reading of `-1` means no echo came back: nothing within range, or a surface too
soft or too angled to reflect. It is reported as `VALUE_UNAVAILABLE` and rendered
as "No echo", never as `0 m`. Zero metres in front of a fire robot reads as an
imminent collision. Flame in particular reflects ultrasound poorly, so expect lost
echoes pointing straight at a fire.

## Motor safety and wiring

`rover_server.py` is deliberately dry-run by default. Confirm the driver wiring
and update the BCM pin constants at the top of the file before enabling output:

```bash
MOTOR_OUTPUT=1 python3 rover_server.py
```

The default mapping is left motor `IN1=17`, `IN2=27`, `PWM=12`; right motor
`IN1=22`, `IN2=23`, `PWM=13`. Set `RIGHT_REVERSED=1` if the right side turns in
the wrong direction. The service stops both motors when the last app disconnects
or when no movement packet arrives for 0.45 seconds.

Flashlight and siren need their optional BCM pins set before starting:

```bash
MOTOR_OUTPUT=1 FLASH_PIN=24 SIREN_PIN=25 DETECTOR=1 python3 rover_server.py
```

An auto-siren triggered by a fire detection holds for `SIREN_HOLD` seconds
(default 5) and each new fire extends that hold rather than cutting it short.

## Telemetry, and what "unavailable" means

Telemetry is broadcast every `TELEMETRY_INTERVAL` seconds (default 2). Values with
no hardware behind them are reported as `-1`, and the app shows `—` rather than a
convincing-looking `0`:

- `signalDb` — read from `/proc/net/wireless`.
- `batteryPercent` — only if you provide a reader: `BATTERY_CMD="cat /sys/.../capacity"`,
  or any command printing 0-100. Otherwise unavailable.
- `gpsLocked` — always false; no GPS module is wired in.
- `inferenceMs` — real measured model time when `DETECTOR=1`.
- `rangeM` — measured ultrasonic distance, or unavailable with no sensor or no echo.

## Testing without a Pi

The service runs on a laptop for development. Without Picamera2 it falls back to
a webcam, and without a webcam it serves a synthetic frame, so the whole app can
be exercised before any hardware exists:

```bash
pip install aiohttp numpy opencv-python-headless
ROVER_TOKEN=devtoken HTTP_PORT=8123 python rover_server.py
curl "http://127.0.0.1:8123/status"
curl -o frame.jpg "http://127.0.0.1:8123/frame.jpg?token=devtoken"
```

Then point the app's Settings at `http://<your-pc-ip>:8123/frame.jpg` and
`ws://<your-pc-ip>:8123/control`.
