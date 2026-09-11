#!/usr/bin/env python3
"""Raspberry Pi companion service for the Agni rover app.

Camera:  http://<pi-ip>:8000/frame.jpg
Control: ws://<pi-ip>:8000/control

Set MOTOR_OUTPUT=1 only after confirming the GPIO assignments below match the
motor driver. Commands stop automatically after CONTROL_TIMEOUT seconds.

Set ROVER_TOKEN to a shared secret so only your app can drive the rover, sound
the siren, or publish detections. Set DETECTOR=1 to run the on-device YOLO
fire/smoke model (see fire_detector.py).

The service also runs on a laptop for testing: without Picamera2 it falls back to
a webcam, and without a webcam it serves a synthetic frame, so the whole app can
be exercised before the hardware is wired up.
"""

import asyncio
import json
import os
import secrets
import signal
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from aiohttp import web

try:
    from picamera2 import Picamera2
except ImportError:  # Lets the service run on a development machine.
    Picamera2 = None

try:
    import RPi.GPIO as GPIO
except ImportError:  # Lets the service be syntax-tested away from a Pi.
    GPIO = None


HTTP_PORT = int(os.getenv("HTTP_PORT", "8000"))
MOTOR_OUTPUT = os.getenv("MOTOR_OUTPUT", "0") == "1"
CONTROL_TIMEOUT = float(os.getenv("CONTROL_TIMEOUT", "0.45"))
MAX_DUTY = float(os.getenv("MAX_DUTY", "0.65"))
SPRINT_DUTY = float(os.getenv("SPRINT_DUTY", "0.9"))
ROVER_TOKEN = os.getenv("ROVER_TOKEN", "")
ROVER_NAME = os.getenv("ROVER_NAME", "Ranger-01")
DETECTOR_ENABLED = os.getenv("DETECTOR", "0") == "1"
# 0.8s suits a Raspberry Pi 4; lower it on a Pi 5 for a faster refresh.
DETECT_INTERVAL = float(os.getenv("DETECT_INTERVAL", "0.8"))
# Horizontal field of view of the camera, in degrees. The app needs this to turn a
# detection's position in the frame into a real bearing for the 3D view.
# Pi Camera v2 = 62.2, Camera v3 = 66, Camera v3 Wide = 102, HQ depends on the lens.
CAMERA_HFOV_DEG = float(os.getenv("CAMERA_HFOV", "62.2"))
TELEMETRY_INTERVAL = float(os.getenv("TELEMETRY_INTERVAL", "2.0"))
SIREN_HOLD = float(os.getenv("SIREN_HOLD", "5.0"))
# Ultrasonic range finder. Off until RANGE_TRIG_PIN and RANGE_ECHO_PIN are set;
# see range_sensor.py for wiring and the voltage divider the ECHO pin needs.
# 0.25s is four pings a second, fast enough to see an obstacle while driving
# without saturating the control socket.
RANGE_INTERVAL = float(os.getenv("RANGE_INTERVAL", "0.25"))
# range_sensor is a light import (it guards its own GPIO import), so unlike the
# detector it can be read at module level for its configuration.
from range_sensor import BEAM_DEG as RANGE_BEAM_DEG  # noqa: E402
from range_sensor import ECHO_PIN as RANGE_ECHO_PIN  # noqa: E402
from range_sensor import MAX_RANGE_M as RANGE_MAX_M  # noqa: E402
from range_sensor import TRIG_PIN as RANGE_TRIG_PIN  # noqa: E402

RANGE_ENABLED = RANGE_TRIG_PIN >= 0 and RANGE_ECHO_PIN >= 0
# Optional shell command printing a battery percentage (0-100) on stdout, e.g. a
# script reading an INA219. Without it the app is told the value is unavailable
# instead of being shown a fake 0%.
BATTERY_CMD = os.getenv("BATTERY_CMD", "")
# Mirrors VALUE_UNAVAILABLE in native/domain/robot.ts: the app renders these as "—".
VALUE_UNAVAILABLE = -1

# Change these BCM pins to match the IN1, IN2 and ENA/ENB pins on your driver.
LEFT_IN1, LEFT_IN2, LEFT_PWM = 17, 27, 12
RIGHT_IN1, RIGHT_IN2, RIGHT_PWM = 22, 23, 13
RIGHT_REVERSED = os.getenv("RIGHT_REVERSED", "0") == "1"
FLASH_PIN = int(os.getenv("FLASH_PIN", "-1"))
SIREN_PIN = int(os.getenv("SIREN_PIN", "-1"))
QUALITY_DIMENSIONS = {"480p": (854, 480), "720p": (1280, 720), "1080p": (1920, 1080)}


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------

def request_token(request: web.Request) -> str:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:]
    return request.query.get("token", "")


def authorized(request: web.Request) -> bool:
    if not ROVER_TOKEN:
        return True
    # compare_digest keeps the check constant-time.
    return secrets.compare_digest(request_token(request), ROVER_TOKEN)


def unauthorized() -> web.Response:
    return web.json_response({"error": "unauthorized"}, status=401)


# --------------------------------------------------------------------------
# Hardware
# --------------------------------------------------------------------------

class MotorDriver:
    def __init__(self) -> None:
        self.enabled = MOTOR_OUTPUT and GPIO is not None
        self.left_pwm = None
        self.right_pwm = None
        if not self.enabled:
            print("Motor output is disabled. Set MOTOR_OUTPUT=1 after checking motor pins.")
            return

        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        for pin in (LEFT_IN1, LEFT_IN2, LEFT_PWM, RIGHT_IN1, RIGHT_IN2, RIGHT_PWM, FLASH_PIN, SIREN_PIN):
            if pin < 0:
                continue
            GPIO.setup(pin, GPIO.OUT)
        self.left_pwm = GPIO.PWM(LEFT_PWM, 1000)
        self.right_pwm = GPIO.PWM(RIGHT_PWM, 1000)
        self.left_pwm.start(0)
        self.right_pwm.start(0)
        self.stop()

    def _set_motor(self, in1: int, in2: int, pwm: Any, value: float) -> None:
        if not self.enabled:
            return
        duty = abs(value) * 100
        GPIO.output(in1, value > 0)
        GPIO.output(in2, value < 0)
        pwm.ChangeDutyCycle(duty)

    def drive(self, throttle: float, steering: float, sprint: bool) -> tuple[float, float]:
        # Differential drive: steering adjusts the left and right wheel speeds.
        limit = SPRINT_DUTY if sprint else MAX_DUTY
        left = clamp(throttle + steering) * limit
        right = clamp(throttle - steering) * limit
        if RIGHT_REVERSED:
            right *= -1
        self._set_motor(LEFT_IN1, LEFT_IN2, self.left_pwm, left)
        self._set_motor(RIGHT_IN1, RIGHT_IN2, self.right_pwm, right)
        return left, right

    def stop(self) -> None:
        if not self.enabled:
            return
        self._set_motor(LEFT_IN1, LEFT_IN2, self.left_pwm, 0)
        self._set_motor(RIGHT_IN1, RIGHT_IN2, self.right_pwm, 0)

    def set_device(self, device: str, enabled: bool) -> None:
        if not self.enabled:
            return
        pin = FLASH_PIN if device == "flash" else SIREN_PIN
        if pin >= 0:
            GPIO.output(pin, enabled)

    def close(self) -> None:
        self.stop()
        if self.enabled:
            self.left_pwm.stop()
            self.right_pwm.stop()
            GPIO.cleanup()


class Camera:
    """Picamera2 when present, otherwise a webcam, otherwise a synthetic frame."""

    def __init__(self) -> None:
        self.quality = "1080p"
        self.source = "none"
        self.camera: Any = None
        self.capture: Any = None

        if Picamera2 is not None:
            try:
                self.camera = Picamera2()
                config = self.camera.create_video_configuration(main={"size": QUALITY_DIMENSIONS["1080p"], "format": "RGB888"})
                self.camera.configure(config)
                self.camera.start()
                time.sleep(1)
                self.source = "picamera2"
            except Exception as error:  # noqa: BLE001 - fall through to the webcam
                print(f"Picamera2 unavailable ({error}); trying a webcam.")
                self.camera = None

        if self.camera is None:
            capture = cv2.VideoCapture(int(os.getenv("WEBCAM_INDEX", "0")))
            if capture.isOpened():
                self.capture = capture
                self.source = "webcam"
            else:
                capture.release()
                print("No camera found. Serving a synthetic test frame.")

        print(f"Camera source: {self.source}")

    def raw_frame(self) -> Any:
        """Latest frame as a numpy array at the selected quality."""
        width, height = QUALITY_DIMENSIONS[self.quality]

        if self.source == "picamera2":
            array = self.camera.capture_array("main")
        elif self.source == "webcam":
            ok, array = self.capture.read()
            if not ok:
                raise RuntimeError("Webcam did not return a frame")
        else:
            array = np.zeros((height, width, 3), dtype=np.uint8)
            array[:] = (32, 24, 18)
            cv2.putText(array, "AGNI TEST FRAME", (40, height // 2), cv2.FONT_HERSHEY_SIMPLEX, height / 480, (90, 170, 230), 2, cv2.LINE_AA)
            cv2.putText(array, time.strftime("%H:%M:%S"), (40, height // 2 + int(height / 10)), cv2.FONT_HERSHEY_SIMPLEX, height / 720, (150, 150, 150), 2, cv2.LINE_AA)
            return array

        if array.shape[1] != width or array.shape[0] != height:
            array = cv2.resize(array, (width, height), interpolation=cv2.INTER_AREA)
        return array

    def frame(self) -> bytes:
        ok, encoded = cv2.imencode(".jpg", self.raw_frame(), [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            raise RuntimeError("Unable to encode camera frame")
        return encoded.tobytes()

    def set_quality(self, quality: str) -> None:
        if quality in QUALITY_DIMENSIONS:
            self.quality = quality

    def close(self) -> None:
        if self.source == "picamera2":
            self.camera.stop()
        elif self.source == "webcam":
            self.capture.release()


# --------------------------------------------------------------------------
# Shared state
# --------------------------------------------------------------------------

@dataclass
class RoverState:
    motors: MotorDriver
    camera: Camera
    clients: set[web.WebSocketResponse]
    last_command: float = 0.0
    left_power: float = 0.0
    right_power: float = 0.0
    settings: dict[str, Any] = None
    siren_until: float = 0.0
    siren_on: bool = False
    suppressed_detections: int = 0
    inference_ms: float = 0.0
    detector: Any = None
    detector_error: str = ""
    range_sensor: Any = None
    range_error: str = ""
    last_range: Any = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        self.settings = {"detectionSensitivity": 74, "autoSiren": True, "showLocation": True, "cameraQuality": "1080p"}

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[web.WebSocketResponse] = []
        for client in list(self.clients):
            if client.closed:
                dead.append(client)
                continue
            try:
                await client.send_json(payload)
            except (ConnectionResetError, RuntimeError):
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    async def stop(self) -> None:
        self.left_power = self.right_power = 0.0
        self.motors.stop()

    def hold_siren(self, seconds: float) -> None:
        """Extend the siren deadline. Overlapping fires never cut each other short."""
        self.siren_until = max(self.siren_until, time.monotonic() + seconds)
        if not self.siren_on:
            self.siren_on = True
            self.motors.set_device("siren", True)


def read_signal_db() -> int:
    """Wi-Fi signal level in dBm from /proc/net/wireless.

    Returns VALUE_UNAVAILABLE when there is no wireless interface to read, so the
    app shows an em dash instead of a plausible-looking 0 dB.
    """
    try:
        with open("/proc/net/wireless", "r", encoding="utf-8") as handle:
            for line in handle.readlines()[2:]:
                parts = line.split()
                if len(parts) > 3:
                    return int(float(parts[3].rstrip(".")))
    except (OSError, ValueError):
        pass
    return VALUE_UNAVAILABLE


async def read_battery_percent() -> int:
    """Battery percentage from BATTERY_CMD, or VALUE_UNAVAILABLE when unconfigured."""
    if not BATTERY_CMD:
        return VALUE_UNAVAILABLE
    try:
        process = await asyncio.create_subprocess_shell(BATTERY_CMD, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=2)
        return max(0, min(100, int(float(stdout.decode().strip()))))
    except (asyncio.TimeoutError, ValueError, OSError):
        return VALUE_UNAVAILABLE


def range_telemetry(state: RoverState) -> dict[str, Any]:
    """Ultrasonic fields for the telemetry packet.

    A rover with no sensor wired reports VALUE_UNAVAILABLE, which the app renders
    as an em dash. A sensor that is present but heard no echo also reports
    unavailable -- "nothing within 4 metres" is not the same as "0 metres away",
    and showing 0 in front of a fire robot would read as an imminent collision.
    """
    sensor = state.range_sensor
    reading = state.last_range
    distance = reading.distanceM if reading is not None and reading.valid else VALUE_UNAVAILABLE
    return {
        "rangeSensorActive": sensor is not None,
        "rangeSensorError": state.range_error,
        "rangeM": distance,
        "rangeBearingDeg": reading.bearingDeg if reading is not None else 0.0,
        "rangeBeamDeg": RANGE_BEAM_DEG,
        "rangeMaxM": RANGE_MAX_M,
    }


def range_payload(reading: Any) -> dict[str, Any]:
    """One ping, in the shape RangeReading takes in native/domain/robot.ts."""
    return {
        "type": "range",
        "distanceM": reading.distanceM if reading.valid else VALUE_UNAVAILABLE,
        "bearingDeg": reading.bearingDeg,
        "beamDeg": RANGE_BEAM_DEG,
        "maxM": RANGE_MAX_M,
        "epoch": round(reading.epoch, 3),
    }


def telemetry_payload(state: RoverState, battery: int) -> dict[str, Any]:
    return {
        "type": "telemetry",
        "roverName": ROVER_NAME,
        "batteryPercent": battery,
        "signalDb": read_signal_db(),
        # No GPS module is wired in; the app renders this honestly rather than faking a fix.
        "gpsLocked": False,
        "inferenceMs": round(state.inference_ms, 1),
        "detectorActive": state.detector is not None,
        "detectorError": state.detector_error,
        "suppressedDetections": state.suppressed_detections,
        "motorOutput": state.motors.enabled,
        "cameraSource": state.camera.source,
        "cameraHfovDeg": CAMERA_HFOV_DEG,
        **range_telemetry(state),
    }


# --------------------------------------------------------------------------
# Detections
# --------------------------------------------------------------------------

async def publish_detection(state: RoverState, data: dict[str, Any]) -> dict[str, Any]:
    """Validate, gate on sensitivity, then send one detection to every client.

    Shared by the HTTP endpoint and the on-device detector so both behave the same.
    """
    if data.get("kind") not in ("fire", "smoke"):
        raise ValueError("kind must be fire or smoke")

    box = data.get("boundingBox")
    if box and not all(key in box for key in ("left", "top", "width", "height")):
        raise ValueError("boundingBox needs left, top, width and height percentages")

    confidence = round(float(data.get("confidence", 0)), 1)
    # Higher sensitivity permits lower-confidence model results.
    minimum = 85 - float(state.settings["detectionSensitivity"]) * 0.6
    if confidence < minimum:
        state.suppressed_detections += 1
        return {"ok": True, "ignored": "below sensitivity threshold", "threshold": round(minimum, 1)}

    detection = {
        "id": data.get("id", str(uuid.uuid4())),
        "kind": data["kind"],
        "confidence": confidence,
        "timestamp": time.strftime("%H:%M:%S"),
        "epoch": time.time(),
        "location": data.get("location", "Camera view"),
        "snapshotUrl": data.get("snapshotUrl", ""),
        "boundingBox": box,
        "confirmedBySensor": bool(data.get("confirmedBySensor", False)),
    }
    if detection["kind"] == "fire" and state.settings["autoSiren"]:
        state.hold_siren(SIREN_HOLD)
    await state.broadcast({"type": "detection", "detection": detection})
    return {"ok": True, "detection": detection}


async def detection_handler(request: web.Request) -> web.Response:
    """Accept a fire/smoke result from an external inference process."""
    if not authorized(request):
        return unauthorized()
    state: RoverState = request.app["state"]
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "body must be JSON"}, status=400)

    data.setdefault("snapshotUrl", f"{request.scheme}://{request.host}/frame.jpg")
    try:
        result = await publish_detection(state, data)
    except (ValueError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response(result)


# --------------------------------------------------------------------------
# HTTP and WebSocket
# --------------------------------------------------------------------------

async def frame_handler(request: web.Request) -> web.Response:
    if not authorized(request):
        return unauthorized()
    state: RoverState = request.app["state"]
    try:
        body = await asyncio.get_running_loop().run_in_executor(None, state.camera.frame)
        return web.Response(body=body, content_type="image/jpeg", headers={"Cache-Control": "no-store"})
    except Exception as error:  # noqa: BLE001 - report to the app instead of a 500 page
        return web.json_response({"error": str(error)}, status=503)


async def status_handler(request: web.Request) -> web.Response:
    """Unauthenticated liveness probe. Reports no camera content and no control."""
    state: RoverState = request.app["state"]
    return web.json_response({
        "ok": True,
        "roverName": ROVER_NAME,
        "authRequired": bool(ROVER_TOKEN),
        "motorOutput": state.motors.enabled,
        "cameraSource": state.camera.source,
        "detectorActive": state.detector is not None,
        "detectorError": state.detector_error,
        "leftPower": state.left_power,
        "rightPower": state.right_power,
        "settings": state.settings,
    })


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    if not authorized(request):
        return unauthorized()

    state: RoverState = request.app["state"]
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(request)
    state.clients.add(ws)
    await ws.send_json(telemetry_payload(state, await read_battery_percent()))
    await ws.send_json({"type": "settings", "settings": state.settings})

    async for message in ws:
        if message.type != web.WSMsgType.TEXT:
            continue
        try:
            command = json.loads(message.data)
        except json.JSONDecodeError:
            continue
        if not isinstance(command, dict):
            continue

        kind = command.get("type")
        try:
            if kind == "drive":
                throttle = clamp(float(command.get("throttle", 0)))
                steering = clamp(float(command.get("steering", 0)))
                state.left_power, state.right_power = state.motors.drive(throttle, steering, bool(command.get("sprint", False)))
                state.last_command = time.monotonic()
            elif kind == "brake":
                await state.stop()
            elif kind == "device":
                device = command.get("device")
                if device in ("flash", "siren"):
                    enabled = bool(command.get("enabled", False))
                    state.motors.set_device(device, enabled)
                    if device == "siren":
                        # A manual siren toggle wins over an auto-siren hold.
                        state.siren_on = enabled
                        state.siren_until = 0.0
            elif kind == "settings":
                incoming = command.get("settings", {})
                if isinstance(incoming, dict):
                    sensitivity = incoming.get("detectionSensitivity", state.settings["detectionSensitivity"])
                    state.settings["detectionSensitivity"] = max(0, min(100, int(sensitivity)))
                    state.settings["autoSiren"] = bool(incoming.get("autoSiren", state.settings["autoSiren"]))
                    state.settings["showLocation"] = bool(incoming.get("showLocation", state.settings["showLocation"]))
                    quality = incoming.get("cameraQuality", state.settings["cameraQuality"])
                    if quality in QUALITY_DIMENSIONS:
                        state.settings["cameraQuality"] = quality
                        state.camera.set_quality(quality)
                await ws.send_json({"type": "settings", "settings": state.settings})
        except (TypeError, ValueError):
            # One malformed packet must not end a driving session.
            continue

    state.clients.discard(ws)
    # Only stop the motors when the last operator disconnects.
    if not state.clients:
        await state.stop()
    return ws


# --------------------------------------------------------------------------
# Background tasks
# --------------------------------------------------------------------------

async def watchdog(state: RoverState) -> None:
    while True:
        now = time.monotonic()
        if state.last_command and now - state.last_command > CONTROL_TIMEOUT:
            await state.stop()
            state.last_command = 0.0
        if state.siren_on and state.siren_until and now > state.siren_until:
            state.siren_on = False
            state.siren_until = 0.0
            state.motors.set_device("siren", False)
        await asyncio.sleep(0.05)


async def telemetry_loop(state: RoverState) -> None:
    while True:
        battery = await read_battery_percent()
        await state.broadcast(telemetry_payload(state, battery))
        await asyncio.sleep(TELEMETRY_INTERVAL)


async def detector_loop(state: RoverState) -> None:
    """Run the on-device model against the live camera and publish what it finds."""
    from fire_detector import DetectorUnavailable, FireDetector

    loop = asyncio.get_running_loop()
    detector = FireDetector()
    try:
        await loop.run_in_executor(None, detector.load)
    except DetectorUnavailable as error:
        state.detector_error = str(error)
        print(f"Fire detector disabled: {error}")
        return
    except Exception as error:  # noqa: BLE001 - never take the server down with it
        state.detector_error = f"{type(error).__name__}: {error}"
        print(f"Fire detector failed to load: {error}")
        return

    state.detector = detector
    state.detector_error = ""

    while True:
        started = time.monotonic()
        try:
            frame = await loop.run_in_executor(None, state.camera.raw_frame)
            detections = await loop.run_in_executor(None, detector.detect, frame)
            state.inference_ms = detector.last_inference_ms
            for detection in detections:
                # No snapshotUrl: the rover cannot know which address the phone
                # reaches it on, and a 127.0.0.1 link would be dead on the phone.
                # The app shows a kind icon instead of a broken thumbnail.
                await publish_detection(state, detection)
        except Exception as error:  # noqa: BLE001 - keep the rover driveable
            state.detector_error = f"{type(error).__name__}: {error}"
        elapsed = time.monotonic() - started
        await asyncio.sleep(max(0.0, DETECT_INTERVAL - elapsed))


async def range_loop(state: RoverState) -> None:
    """Ping the ultrasonic sensor and broadcast each reading.

    Pings block for up to ~25ms each while they busy-wait on the echo pin, so they
    run in an executor. Doing this on the event loop would make the rover stutter
    under the joystick.
    """
    from range_sensor import RangeSensor, RangeSensorUnavailable

    loop = asyncio.get_running_loop()
    sensor = RangeSensor()
    try:
        await loop.run_in_executor(None, sensor.open)
    except RangeSensorUnavailable as error:
        state.range_error = str(error)
        print(f"Range sensor disabled: {error}")
        return
    except Exception as error:  # noqa: BLE001 - never take the server down with it
        state.range_error = f"{type(error).__name__}: {error}"
        print(f"Range sensor failed to start: {error}")
        return

    state.range_sensor = sensor
    state.range_error = ""
    print(f"Range sensor ready: TRIG={sensor.trig} ECHO={sensor.echo} bearing={sensor.bearing_deg} deg")

    try:
        while True:
            started = time.monotonic()
            try:
                reading = await loop.run_in_executor(None, sensor.read)
                state.last_range = reading
                await state.broadcast(range_payload(reading))
            except Exception as error:  # noqa: BLE001 - keep the rover driveable
                state.range_error = f"{type(error).__name__}: {error}"
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(0.0, RANGE_INTERVAL - elapsed))
    finally:
        sensor.close()


async def start_background_tasks(app: web.Application) -> None:
    state: RoverState = app["state"]
    app["watchdog"] = asyncio.create_task(watchdog(state))
    app["telemetry"] = asyncio.create_task(telemetry_loop(state))
    if DETECTOR_ENABLED:
        app["detector"] = asyncio.create_task(detector_loop(state))
    if RANGE_ENABLED:
        app["range"] = asyncio.create_task(range_loop(state))


async def stop_background_tasks(app: web.Application) -> None:
    for key in ("watchdog", "telemetry", "detector", "range"):
        task = app.get(key)
        if task:
            task.cancel()
    await app["state"].stop()
    app["state"].camera.close()
    app["state"].motors.close()


def make_app() -> web.Application:
    app = web.Application()
    app["state"] = RoverState(MotorDriver(), Camera(), set())
    app.router.add_get("/frame.jpg", frame_handler)
    app.router.add_get("/status", status_handler)
    app.router.add_post("/detections", detection_handler)
    app.router.add_get("/control", websocket_handler)
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(stop_background_tasks)
    return app


if __name__ == "__main__":
    if not ROVER_TOKEN:
        print("WARNING: ROVER_TOKEN is not set. Anyone on this network can drive the rover,")
        print("         sound the siren, and publish fake detections. Set ROVER_TOKEN.")
    if DETECTOR_ENABLED:
        print("On-device fire and smoke detection is enabled (DETECTOR=1).")

    app = make_app()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(signum, lambda: asyncio.create_task(app["state"].stop()))
    except NotImplementedError:
        # Windows does not support add_signal_handler; Ctrl+C still stops the server.
        pass
    web.run_app(app, host="0.0.0.0", port=HTTP_PORT, loop=loop)
