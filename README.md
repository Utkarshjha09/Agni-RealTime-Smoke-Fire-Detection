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

## Table of contents

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
- [Development and verification](#development-and-verification)
- [Troubleshooting](#troubleshooting)
- [What to do next](#what-to-do-next)
- [Credits and licences](#credits-and-licences)

---

## What it does, end to end

This is the product. Every change to this repo is judged against it.

1. **Connect.** The app reaches the rover over Wi-Fi. You type the Pi's address and a
   token once; the app remembers them, reconnects on its own with exponential backoff,
   and shows the real connection state on every screen.
2. **Live video.** The Pi streams continuous MJPEG video, about 14 frames per second at
   720p on a Pi 4. The app paints each frame onto a canvas, so the picture never blanks
   between frames, and it reports a stalled stream instead of freezing on the last
   picture.
3. **Detect.** A YOLO model on the rover finds fire and smoke. The app draws each box
   over the live video exactly where the fire is, and shows a **Fire Detected** warning.
   Boxes leave the screen a few seconds after the model stops seeing them.
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
  Pi Camera ────►│  rover_server.py  (one process: camera, HTTP, WebSocket,     │
  HC-SR04  ─────►│                    motors, watchdog, telemetry)              │
  L298N ◄────────│        │   ▲                                                 │
                 │        │   │ frames in, boxes out                            │
                 │        ▼   │                                                 │
                 │  detector process  (fire_detector.py, YOLO on NCNN,          │
                 │                     2 threads, lower CPU priority)           │
                 └───────┬──────────────────┬──────────────────┬────────────────┘
                         │                  │                  │
               GET /stream.mjpg     GET /frame.jpg     WebSocket /control
               (live video, token)  (one frame)        (token, both directions)
                         │                  │                  │
                         ▼                  ▼                  ▼
                 ┌──────────────────────────────────────────────────────┐
                 │                 Expo app (native/)                   │
                 │        Control · Map · Alerts · Settings             │
                 └──────────────────────────────────────────────────────┘
```

Three design decisions shape the whole system.

**The server owns the camera; the model runs in a process of its own.** Picamera2 cannot
be opened by two processes, so `rover_server.py` holds the camera and hands frames to
the detector. The detector runs in a separate process because the NCNN inference
library holds Python's interpreter lock for its whole pass. When the model ran inside
the server, every 0.4 second pass froze the video, the telemetry and the drive
commands with it. In its own process it can take as long as it likes and the server
stays responsive.

**Video is a stream, not a series of photos.** The app first fetched one JPEG at a time
and swapped them, and Android blanks an image while it swaps, so the feed blinked. Now
the Pi sends one long multipart MJPEG response and the app draws each frame over the
last one.

**The app is a thin, honest client.** It never invents data. Everything on screen came
from the rover, or is explicitly marked as an estimate, or is marked unavailable.

---

## Measured performance

Measured on a **Raspberry Pi 4 Model B (8 GB), Camera Module v2, Raspberry Pi OS 64-bit
(Debian 13 "trixie"), 2026-10-11**, with the app's video stream running, over Wi-Fi.

| What | Result |
|---|---|
| Live video stream | **14.3 fps**, about 80 KB per 720p frame |
| One frame from `/frame.jpg` | 130 to 170 ms |
| Server response time (`/status`) while the model runs | **about 3 ms** |
| Fire model, one pass at 640 px, 2 threads, stream running | **about 800 ms** (about 490 ms with no viewer) |
| SD card used after a full install | 8.8 GB |
| CPU temperature, model running, no heatsink | 67 to 74 °C |

For comparison, before the model moved to its own process, the same Pi gave 1.9 fps
video and took 340 ms to answer `/status`. With 3 model threads instead of 2 the model
was no faster and the video slightly slower, which is why 2 is the default.

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
│   │   ├── robotGateway.ts      WebSocket lifecycle, backoff, message routing
│   │   └── storage.ts           Remembers the rover and settings between launches
│   │
│   ├── components/
│   │   ├── LiveStream.tsx       Reads /stream.mjpg and paints it; detects stalls
│   │   ├── Joystick.tsx         Multi-touch stick on react-native-gesture-handler
│   │   ├── useOrientation.ts    Landscape detection and safe-area screen padding
│   │   └── Glass.tsx, icons.tsx, ui.tsx, anim.ts, AppGround.tsx
│   └── theme.ts                 Colour, font and radius tokens
│
├── raspberry_pi/                The rover service (Python, aiohttp)
│   ├── rover_server.py          Camera, MJPEG stream, WebSocket, motors, brake,
│   │                            watchdog, telemetry, detector process management
│   ├── fire_detector.py         YOLO inference, box tracking, detector-process entry
│   ├── range_sensor.py          HC-SR04 ultrasonic driver
│   ├── deploy.sh                Deploy to a Pi over SSH, with byte-for-byte checks
│   ├── verify_rover.py          Exercises every endpoint the app uses, and reports
│   ├── agni-rover.service       systemd unit, so the rover starts at boot
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

`verify_rover.py` walks the same path the app does: the token, a camera frame, the live
stream, telemetry, the settings round trip, the flashlight if wired, a drive command
and the safety watchdog. It exits non-zero if anything failed.

**How you know it worked.** Every line says `PASS` or an explained `WARN`, and the
`Live stream` line shows a frame rate.

To see **just the model** detecting on your webcam, without the rover at all:

```bash
cd model
python live_test.py            # opens http://127.0.0.1:8777 in your browser
```

Hold a phone playing a fire video in front of the webcam and boxes appear.

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
system journal.

**How you know it worked.**

```bash
systemctl status agni-rover        # on the Pi: shows "active (running)"
journalctl -u agni-rover -n 30 --no-pager
```

The log should include:

```
Camera sensor mode: 1640x1232, full field of view
Camera source: picamera2
Fire detector running in its own process, classes=['Fire', 'Smoke']
```

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
server with **Ctrl+C** and run `npx expo start` again; a running server does not pick
up new native modules.

**As an installable APK**, to keep on the phone:

```bash
cd native
npx eas-cli login
npx eas-cli build --platform android --profile preview
```

It builds on Expo's servers in 10 to 20 minutes and gives you a download link. An APK
contains the code it was built with, so **rebuild after any app change**. Your saved
rover address and token survive reinstalling over the old version.

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
if you changed `HTTP_PORT`. **Show full URLs** reveals them for hand editing.

**How you know it worked**, in this order:

1. The status bar on **Control** shows **LINK** in green.
2. The live video appears and moves smoothly.
3. **AI** shows in orange: the model is running on the rover.
4. Battery shows `—`: no battery monitor is wired, so there is no number to show. That
   is correct, not a bug.
5. **MOTORS OFF ON ROVER** shows in orange until you enable the motors in Step 10.
6. Play a fire video on another screen and point the Pi camera at it. A red **FIRE**
   box appears on the flames, the **Fire Detected** warning appears, the detection is
   listed under **Alerts** and placed on the **Map**.

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

**Camera colour.** If the video looks pink or blue, open **Settings → Camera → Camera
colour** in the app and pick a preset. It changes live. **Daylight** is the default,
because automatic white balance turned a white wall pink in testing. If **every**
preset looks pink, your camera is probably a **NoIR** module, which has no infrared
filter. Set its colour profile in `rover.env` and restart:

```bash
CAMERA_TUNING=imx219_noir.json        # Camera Module v2 NoIR
```

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
model's CPU threads (2 is best on a Pi 4), `STREAM_FPS` the video frame rate. If the Pi
runs hot, fit a heatsink or fan: a Pi 4 slows itself down from about 80 °C.

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

App changes reach Expo Go through `npx expo start`; an installed APK needs rebuilding.

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

---

## Using the app

**Control**

- The status bar shows Wi-Fi signal, battery, GPS, **AI** (the model is running on the
  rover) and **LINK** (connected). A value with no hardware behind it shows `—`.
- The **joystick** drives in any direction: push forward to go, to the side to turn on the
  spot, diagonally to curve. It springs back and stops the car when released.
- **ACCEL** (hold) adds forward drive, so one thumb can steer while the other
  accelerates. **SPRINT** (tap) latches a higher speed ceiling. **BRAKE** (tap) is a
  hard stop and also releases SPRINT. All of them work while the stick is held.
- The **L/R bars** show what each side of the car is being told to do right now: green
  forward, red reverse, blue while sprinting. They use the same mix as the Pi.
- The **AR** button hides or shows the detection boxes. The flashlight and siren buttons
  appear only when their pins are wired; the siren asks before it sounds.
- A **Fire Detected** or **Smoke Detected** warning shows the latest detection, how
  long ago it was seen, and a button to see it on the map.
- Switching tabs or leaving the app while driving stops the car.

**Map.** Drag to orbit, **+** and **−** to zoom, **TOP** for a top-down view, the
crosshair to reset. The bin button clears the map; the Alerts tab keeps every detection.

**Alerts.** Every detection of the session, filterable by fire or smoke, with its
confidence and time. **Clear this session** empties it.

**Settings.** The Pi address and token, the connection button, the model status and
inference time, detection sensitivity, auto-siren, in-app alerts, camera quality
(480p, 720p, 1080p) and camera colour.

---

## The protocol

### HTTP

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /stream.mjpg` | continuous MJPEG video at `STREAM_FPS`; what the app shows | token |
| `GET /frame.jpg` | one JPEG frame | token |
| `GET /control` | WebSocket upgrade, see below | token |
| `POST /detections` | publish a detection from an external detector | token |
| `GET /status` | liveness probe; no camera content and no control | open |

The token may be sent as an `Authorization: Bearer` header or as a `?token=` query
parameter. The stream carries `Access-Control-Allow-Origin: *` because the app reads it
from a local page with no origin of its own; the token still gates every request.

Each part of the stream has a `Content-Length` header, and the app reads parts by
length rather than by searching for JPEG markers.

### WebSocket, app to rover

| Message | Fields | Effect |
|---|---|---|
| `drive` | `throttle`, `steering`, `sprint` | sets motor power and refreshes the watchdog |
| `brake` | none | hard stop: both motors shorted for 0.5 s, then released |
| `device` | `device` (`flash` or `siren`), `enabled` | switches a GPIO output; telemetry confirms |
| `settings` | `settings` object | sensitivity, auto-siren, location, camera quality, white balance |

The app sends at most one `drive` every 50 ms, and repeats a held command every 120 ms.
That repeat is the heartbeat the rover's watchdog listens for. A stop is always sent at
once. A zero `drive` during a brake does not cut the brake short; any real stick
movement takes over from it immediately.

### WebSocket, rover to app

| Message | Carries |
|---|---|
| `telemetry` | rover name, battery, signal, motor output state, flashlight and siren availability and state, camera source, field of view, white balance availability, model status and inference time, ultrasonic status |
| `detection` | one fire or smoke event: kind, confidence, percent-of-frame box, time |
| `range` | one ultrasonic ping: distance, bearing, beam width, maximum range |
| `settings` | the rover's settings after applying yours |

Telemetry is sent on connect, every `TELEMETRY_INTERVAL` seconds, and immediately when
a device changes state, including the auto-siren starting or timing out.

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
(`spawn`, not `fork`, so the child never inherits the camera's threads). Each pass, the
server grabs a frame, shrinks it to the model's input width, and hands it over; the
model returns boxes as percentages of the frame. The process runs with 2 threads at a
lower CPU priority, so video and drive commands always come first. If it crashes, the
server reports it in telemetry and starts a new one; the rover keeps driving
throughout.

**Tracking.** A box overlapping one from the previous pass keeps the same ID, so one
fire updates one alert instead of creating a new one every pass. A track is forgotten
`DETECT_TRACK_TTL` seconds after it was last seen.

**On screen.** The rover re-sends a box on every pass in which the fire is still seen.
The app draws boxes only while they keep arriving, and the window widens with the
measured inference time so boxes do not blink between slow passes.

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
| Installed APK cannot connect, Expo Go can | the APK predates the cleartext setting; rebuild it |
| `ssh: Permission denied` | wrong username or password, or the key was not installed; repeat [Step 5](#step-5-set-up-ssh-keys) |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` | you re-flashed the card. On your computer: `ssh-keygen -R agni-rover.local` |

### Video

| Symptom | Cause and fix |
|---|---|
| Video blinks | an old app version that swapped single frames; update the app |
| Video lags or stutters | check `verify_rover.py`'s `Live stream` rate. Below about 10 fps: confirm the log says `Fire detector running in its own process`, keep `DETECT_THREADS=2`, check the temperature, or lower `STREAM_FPS` |
| Video looks pink | pick **Daylight** or another preset in Settings → Camera colour; if all look pink, set `CAMERA_TUNING=imx219_noir.json` |
| "Pi camera unavailable, retrying" | the stream stalled or the rover restarted; it reconnects by itself. If it persists, check `journalctl -u agni-rover` |
| `Camera source: none` in the log | the camera is not detected: reseat the ribbon with the Pi off, then check `rpicam-hello --list-cameras` |
| `rpicam-hello` says the camera is busy | the rover owns the camera. `sudo systemctl stop agni-rover` first, then start it again |

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
| SPRINT, BRAKE or ACCEL ignored while holding the stick | an old app version with single-touch controls; update the app and restart `npx expo start` |
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
| Changes on the PC do not show on the rover | deploy them and restart; see [Updating the rover](#updating-the-rover-after-a-code-change) |

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
