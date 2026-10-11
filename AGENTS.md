# Project rules

Standing rules for anyone editing this repository, human or agent. Read this before
changing anything.

This is a public repo for a safety-critical demo. People will read it as a working
system, so it has to be one.

---

## The intended workflow

This is the product definition. Every change is judged against it, and a change that
does not serve it needs a reason.

1. **Connect to the robot car over Wi-Fi**, with the real connection state visible
   wherever the operator is looking.
2. **The live Raspberry Pi camera** appears in the app.
3. **Fire and smoke are detected by the model on the rover** and drawn as AR boxes on
   that live feed.
4. **The same detections appear on the 3D map**, placed by real bearing.
5. **A PUBG-style joystick drives the motors in all directions**, with accelerate,
   sprint and brake.
6. **The UI is responsive** across phone and tablet, in both orientations.

Driving is differential, or tank, drive. The joystick emits throttle and steering; the
Pi computes `left = throttle + steering` and `right = throttle - steering`, scaled by
`MAX_DUTY` normally or `SPRINT_DUTY` with sprint held.

---

## The rules

### 1. Nothing fake may look live

No hardcoded detections, telemetry, device names or placeholder alerts rendered as if
they came from the rover. No sample data, no lorem ipsum, no "demo mode" that is not
labelled as one on screen.

**No data means an empty state.** An empty list with an honest message is correct. A
list of plausible-looking examples is not.

This rule exists because an audit of this project found hardcoded fire alerts, an
alerts screen ignoring real detections, telemetry frozen at zero, and no model at all,
in an app that looked finished. That must not recur.

### 2. Every control must do something real

A button, slider or toggle that is not wired to real state does not ship. If the
feature behind it does not exist yet, the control does not exist yet either.

### 3. Unavailable is an em dash, not a zero

Any value with no hardware behind it is sent as `-1` (`VALUE_UNAVAILABLE`) and rendered
as `—`.

A fabricated battery reading of zero percent on a fire robot reads as a dead battery. A
range of zero metres reads as an imminent collision. Both are worse than an honest
blank. A sensor that is present but heard no echo is also unavailable: "nothing within
four metres" is not "zero metres away".

### 4. Keep the contracts in sync

`native/domain/robot.ts` and `raspberry_pi/rover_server.py` are **one contract**.
Change a field in either and you must change it in the other, then re-test the round
trip.

A silently renamed field looks exactly like a sensor that stopped working, which is the
most expensive kind of bug to chase here.

### 5. Every state needs a state

Loading, empty, error and offline are part of the feature, not polish for later. A
screen that only works when everything is connected is not finished.

### 6. The rover is a physical machine

- **Motor output is off by default** (`MOTOR_OUTPUT=0`). Keep it that way.
- **Keep the watchdog.** The motors stop if no command arrives for `CONTROL_TIMEOUT`
  seconds, and when the last operator disconnects. Do not remove or lengthen it
  casually; it is what stops a rover whose operator walked out of Wi-Fi range.
- **Keep token auth, and keep it off the wire.** The app proves the token with a
  challenge-response and signs every control message (`security.py` and
  `domain/crypto.ts`, one protocol); video opens with one-time tickets. Never send
  the token in an app URL, never accept an unsigned command on an authenticated
  socket, and never lock BRAKE behind the driver lock.
- **Loud or physical actions get a confirmation.** The siren asks first.
- A background task must never be able to take the server down or leave the wheels
  energised. Catch broadly in the loops, report the error in telemetry, keep driving.

### 7. Verify, then report

Land changes with a real check, and say plainly what was and was not verified.

**Compiling is not working.** Type-checking proves the types line up. Bundling proves
it builds. Neither proves the rover moved.

| Change | The check |
|---|---|
| App code | `npx tsc --noEmit` and `npx expo export --platform android` |
| Rover service | run it, then `python verify_rover.py --token ...` |
| Anything touching motion | `verify_rover.py --drive`, on blocks |
| Model or export | load the weights, run inference, report the measured numbers |

Report what failed as readily as what passed. A claim in a README or a commit message
is a claim someone will rely on.

---

## Where things live

| Surface | Status |
|---|---|
| `native/` | **the real app.** Fully wired to the rover. Work here by default. |
| `raspberry_pi/` | the rover service. Owns the camera and the motors, and supervises the model's process. |
| `model/` | offline training and export. Nothing here is installed on the Pi. |

The server owns the camera, because Picamera2 cannot be opened by two processes at
once, and hands frames to the detector. The detector runs in a **separate process**
that `rover_server.py` starts and supervises, because the NCNN inference library
holds the interpreter lock for its whole pass: in the server's process it froze the
video and the drive commands. Keep it out of the server's process, and keep
`deploy.sh`'s byte-for-byte copy check, which exists because an empty file once
reached the Pi and the rover exited silently at boot.

The service falls back to a webcam off a Pi, and to a synthetic frame with no camera at
all, so the whole stack is testable on a laptop. Keep that working.

### Why `native/domain/` is separate from the screens

Everything in `native/domain/` is a pure function over plain data. No React, no
network, no side effects. That is what makes the geometry testable: bearings, range
fusion and the point fade are checked by running them on numbers, not by looking at the
screen and hoping.

---

## Style

Match the surrounding code. A few conventions that are deliberate:

- **Comments explain why, not what.** The non-obvious decision, the constant that came
  from a measurement, the failure mode being guarded against. Not a restatement of the
  line below.
- **Prose in docs and comments avoids em dashes**, and avoids marketing language.
- Environment variables are the rover's entire configuration surface. A new one goes in
  `rover.env.example` and the README's configuration reference at the same time.
