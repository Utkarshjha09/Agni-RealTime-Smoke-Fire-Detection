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
import hmac
import json
import multiprocessing
import os
import secrets
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from aiohttp import web

from security import (
    PROTOCOL, FailureLimiter, Session, TicketBook, auth_proof, finite, is_hex_nonce,
    new_nonce, server_proof, session_key, strict_loads,
)

try:
    from picamera2 import Picamera2
except ImportError:  # Lets the service run on a development machine.
    Picamera2 = None

try:
    from libcamera import controls as libcamera_controls
except ImportError:  # Only present alongside Picamera2.
    libcamera_controls = None

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
# The model's input size, read here too so frames are shrunk to it before they
# are copied to the detector process. Same variable and default as fire_detector.
DETECT_FRAME_WIDTH = int(os.getenv("DETECT_IMGSZ", "320"))
# Horizontal field of view of the camera, in degrees. The app needs this to turn a
# detection's position in the frame into a real bearing for the 3D view.
# Pi Camera v2 = 62.2, Camera v3 = 66, Camera v3 Wide = 102, HQ depends on the lens.
CAMERA_HFOV_DEG = float(os.getenv("CAMERA_HFOV", "62.2"))
TELEMETRY_INTERVAL = float(os.getenv("TELEMETRY_INTERVAL", "2.0"))
# Frame rate of /stream.mjpg. 15 is smooth to drive by and leaves a Pi 4 enough
# CPU for the detector; each frame is a 720p JPEG encode.
STREAM_FPS = max(1.0, float(os.getenv("STREAM_FPS", "15")))
# A frame that takes longer than this means the camera has hung. Ending the
# stream lets the app show the camera as failed instead of a frozen picture.
STREAM_FRAME_TIMEOUT = 3.0
SIREN_HOLD = float(os.getenv("SIREN_HOLD", "5.0"))
# A hard brake shorts the motors. Long enough to stop a small rover from full
# speed, then it releases to a coast so the driver is not held braking.
BRAKE_HOLD = 0.5
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
# White balance presets, by the names the app shows. Auto white balance guessed
# badly in at least one room, turning a white wall pink, so a fixed preset is the
# default and the app can switch it live.
WHITE_BALANCE_MODES = ("auto", "daylight", "cloudy", "indoor", "tungsten", "fluorescent")
CAMERA_AWB = os.getenv("CAMERA_AWB", "daylight").strip().lower()
if CAMERA_AWB not in WHITE_BALANCE_MODES:
    print(f"CAMERA_AWB={CAMERA_AWB!r} is not one of {WHITE_BALANCE_MODES}; using daylight.")
    CAMERA_AWB = "daylight"
# A libcamera tuning file, e.g. imx219_noir.json for a NoIR camera. A NoIR module
# has no infrared filter and reads pink under the standard tuning, whatever the
# white balance. Empty uses the tuning libcamera picks for the sensor.
CAMERA_TUNING = os.getenv("CAMERA_TUNING", "").strip()


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


# Seconds a new connection has to answer the challenge before it is dropped.
AUTH_TIMEOUT = 5.0
# A client that cannot take a message in this long is dropped rather than allowed
# to stall telemetry, detections and the watchdog for everyone else.
SEND_TIMEOUT = 1.0
# The device driving keeps the controls while its commands keep coming. After this
# long without one, another device may take over. BRAKE works from any device.
DRIVER_LEASE = 3.0
# Control messages are a few hundred bytes. Anything far larger is not the app.
MAX_MESSAGE_BYTES = 16 * 1024


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------

def request_token(request: web.Request) -> str:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:]
    return request.query.get("token", "")


def token_matches(request: web.Request) -> bool:
    """The raw token, for tools like curl and verify_rover.py. The app never sends it."""
    if not ROVER_TOKEN:
        return True
    # compare_digest keeps the check constant-time.
    return secrets.compare_digest(request_token(request), ROVER_TOKEN)


def check_http(request: web.Request, purpose: str | None = None) -> web.Response | None:
    """None when the request may proceed, otherwise the response refusing it.

    The app opens video with a ticket it got over its authenticated socket; the token
    itself is accepted too, for tools, but it travels in clear when used that way.
    """
    state: RoverState = request.app["state"]
    address = request.remote or "unknown"
    if state.limiter.blocked(address):
        return web.json_response({"error": "too many failed attempts; try again in a minute"}, status=429)
    ticket = request.query.get("ticket", "")
    if purpose and ticket and state.tickets.redeem(ticket, purpose):
        return None
    if token_matches(request):
        return None
    state.limiter.fail(address)
    return web.json_response({"error": "unauthorized"}, status=401)


# --------------------------------------------------------------------------
# Hardware
# --------------------------------------------------------------------------

class MotorDriver:
    """The wheels, plus the flashlight and siren outputs.

    The devices are independent of MOTOR_OUTPUT: a bench rover with the wheels
    disabled can still test its flashlight. A device whose pin is -1 reports
    itself unavailable, so the app hides its button instead of showing a toggle
    that switches nothing.
    """

    def __init__(self) -> None:
        self.enabled = MOTOR_OUTPUT and GPIO is not None
        self.devices = {
            name: pin for name, pin in (("flash", FLASH_PIN), ("siren", SIREN_PIN))
            if pin >= 0 and GPIO is not None
        }
        self.device_state = {name: False for name in self.devices}
        self.left_pwm = None
        self.right_pwm = None

        if self.enabled or self.devices:
            GPIO.setmode(GPIO.BCM)
            GPIO.setwarnings(False)
        for pin in self.devices.values():
            GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)

        if not self.enabled:
            print("Motor output is disabled. Set MOTOR_OUTPUT=1 after checking motor pins.")
            return

        for pin in (LEFT_IN1, LEFT_IN2, LEFT_PWM, RIGHT_IN1, RIGHT_IN2, RIGHT_PWM):
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
        """Cut power and let the wheels coast. What releasing the stick does."""
        if not self.enabled:
            return
        self._set_motor(LEFT_IN1, LEFT_IN2, self.left_pwm, 0)
        self._set_motor(RIGHT_IN1, RIGHT_IN2, self.right_pwm, 0)

    def brake(self) -> None:
        """Short both motors through the driver so they stop hard.

        Cutting power only lets the car coast, which felt identical to letting go
        of the stick. With both inputs high and enable on, an L298N ties each
        motor's terminals together and the motor's own back-EMF stops it.
        """
        if not self.enabled:
            return
        for in1, in2, pwm in ((LEFT_IN1, LEFT_IN2, self.left_pwm), (RIGHT_IN1, RIGHT_IN2, self.right_pwm)):
            GPIO.output(in1, True)
            GPIO.output(in2, True)
            pwm.ChangeDutyCycle(100)

    def set_device(self, device: str, enabled: bool) -> bool:
        """Switch a device. False when it is not wired, so the caller can say so."""
        pin = self.devices.get(device)
        if pin is None:
            return False
        GPIO.output(pin, enabled)
        self.device_state[device] = enabled
        return True

    def close(self) -> None:
        self.stop()
        if self.enabled:
            self.left_pwm.stop()
            self.right_pwm.stop()
        if self.enabled or self.devices:
            GPIO.cleanup()


class Camera:
    """Picamera2 when present, otherwise a webcam, otherwise a synthetic frame."""

    def __init__(self) -> None:
        self.quality = "720p"
        self.white_balance = CAMERA_AWB
        self.source = "none"
        self.camera: Any = None
        self.capture: Any = None
        # The app's frame requests and the detector both read from executor
        # threads. cv2.VideoCapture is not safe to read from two threads at once.
        self.lock = threading.Lock()

        if Picamera2 is not None:
            try:
                if CAMERA_TUNING:
                    self.camera = Picamera2(tuning=Picamera2.load_tuning_file(CAMERA_TUNING))
                    print(f"Camera tuning: {CAMERA_TUNING}")
                else:
                    self.camera = Picamera2()
                self.camera.configure(self._full_view_config())
                self.camera.start()
                time.sleep(1)
                self.source = "picamera2"
                self.set_white_balance(CAMERA_AWB)
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

    def _full_view_config(self) -> Any:
        """A video configuration on a sensor mode that sees the whole field of view.

        Left to choose, libcamera picks the mode closest to the 1920x1080 we ask for.
        On the Camera Module v2 that is a centre crop of the sensor, about 39 of its
        62.2 degrees: the model never sees the outer third of the scene, and the map,
        which turns box positions into bearings with CAMERA_HFOV, puts every fire at
        the wrong angle. Measured on a Pi 4 with an imx219, 2026-10-10.
        """
        main = {"size": QUALITY_DIMENSIONS["1080p"], "format": "RGB888"}
        try:
            modes = [mode for mode in self.camera.sensor_modes if mode.get("crop_limits") and mode.get("size")]
            widest = max(mode["crop_limits"][2] for mode in modes)
            full_view = [mode for mode in modes if mode["crop_limits"][2] >= widest]
            # The smallest full-view mode that still fills 720p: binned modes are
            # faster to read out and lose nothing the stream can show.
            big_enough = [mode for mode in full_view if mode["size"][0] >= 1280] or full_view
            mode = min(big_enough, key=lambda item: item["size"][0] * item["size"][1])
            config = self.camera.create_video_configuration(
                main=main, sensor={"output_size": mode["size"], "bit_depth": mode["bit_depth"]},
            )
            print(f"Camera sensor mode: {mode['size'][0]}x{mode['size'][1]}, full field of view")
            return config
        except Exception as error:  # noqa: BLE001 - a cropped view beats no camera
            print(f"Could not select a full-view sensor mode ({error}); using the default, which may crop.")
            return self.camera.create_video_configuration(main=main)

    def raw_frame(self) -> Any:
        """Latest frame as a numpy array at the selected quality."""
        width, height = QUALITY_DIMENSIONS[self.quality]

        if self.source == "picamera2":
            with self.lock:
                array = self.camera.capture_array("main")
        elif self.source == "webcam":
            with self.lock:
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

    @property
    def white_balance_available(self) -> bool:
        return self.source == "picamera2" and libcamera_controls is not None

    def set_white_balance(self, mode: str) -> bool:
        """Apply a white balance preset live. False when this camera cannot."""
        if mode not in WHITE_BALANCE_MODES or not self.white_balance_available:
            return False
        modes = libcamera_controls.AwbModeEnum
        enum = {
            "auto": modes.Auto, "daylight": modes.Daylight, "cloudy": modes.Cloudy,
            "indoor": modes.Indoor, "tungsten": modes.Tungsten, "fluorescent": modes.Fluorescent,
        }[mode]
        try:
            self.camera.set_controls({"AwbEnable": True, "AwbMode": enum})
        except Exception as error:  # noqa: BLE001 - a colour preset is never worth the camera
            print(f"White balance {mode} not applied: {error}")
            return False
        self.white_balance = mode
        return True

    def close(self) -> None:
        if self.source == "picamera2":
            self.camera.stop()
        elif self.source == "webcam":
            self.capture.release()


# --------------------------------------------------------------------------
# One camera, one encoder, every viewer
# --------------------------------------------------------------------------

# BGR, the same colours as the app and model/live_test.py: fire orange, smoke grey-blue.
BOX_COLOURS = {"fire": (40, 120, 255), "smoke": (200, 170, 140)}


def draw_detections(frame: Any, boxes: list[dict[str, Any]]) -> Any:
    """The frame with the live fire and smoke boxes drawn on it, as live_test.py draws them.

    Drawn on the picture rather than over it, so a box can never drift from the
    frame it belongs to, however the phone lays the video out.
    """
    frame = frame.copy()
    height, width = frame.shape[:2]
    scale = max(0.5, width / 1280)
    thickness = max(2, round(2 * scale))
    for item in boxes:
        box = item["boundingBox"]
        x1, y1 = int(box["left"] / 100 * width), int(box["top"] / 100 * height)
        x2, y2 = int((box["left"] + box["width"]) / 100 * width), int((box["top"] + box["height"]) / 100 * height)
        colour = BOX_COLOURS.get(item["kind"], (255, 255, 255))
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, thickness)
        label = f"{item['kind'].upper()} {item['confidence']:.0f}%"
        (text_width, text_height), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7 * scale, thickness)
        top = max(y1, text_height + 12)
        cv2.rectangle(frame, (x1, top - text_height - 10), (x1 + text_width + 10, top), colour, -1)
        cv2.putText(frame, label, (x1 + 5, top - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7 * scale, (16, 16, 16), thickness, cv2.LINE_AA)
    return frame


def encode_variants(frame: Any, boxes: list[dict[str, Any]], wanted: set[str]) -> dict[str, bytes]:
    """JPEG once per variant someone is watching, never once per viewer."""
    out: dict[str, bytes] = {}
    for variant in wanted:
        image = draw_detections(frame, boxes) if variant == "overlay" else frame
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            out[variant] = encoded.tobytes()
    return out


class FrameHub:
    """Captures the camera at STREAM_FPS and hands the same frame to everyone.

    Each stream used to grab and encode its own frames on a timer, so two viewers
    cost two encodes and a frame could wait most of an interval before being sent.
    Now one loop captures, the detector takes the latest raw frame from it, and every
    stream is woken the moment a new JPEG exists: what model/live_test.py does on a
    laptop, where the video has no lag.
    """

    def __init__(self, camera: "Camera") -> None:
        self.camera = camera
        self.raw: Any = None
        self.raw_at = 0.0
        self.seq = 0
        self.jpeg: dict[str, bytes | None] = {"raw": None, "overlay": None}
        self.viewers: dict[str, int] = {"raw": 0, "overlay": 0}
        self.error = ""
        self.changed = asyncio.Condition()

    def frame_age(self) -> float:
        """Seconds since the camera last delivered, or infinity before the first frame."""
        return time.monotonic() - self.raw_at if self.raw_at else float("inf")

    async def run(self, state: "RoverState") -> None:
        loop = asyncio.get_running_loop()
        interval = 1.0 / STREAM_FPS
        while True:
            started = time.monotonic()
            try:
                raw = await loop.run_in_executor(None, self.camera.raw_frame)
                wanted = {variant for variant, count in self.viewers.items() if count > 0}
                encoded = await loop.run_in_executor(None, encode_variants, raw, state.overlay_boxes(), wanted)
                async with self.changed:
                    self.raw, self.raw_at, self.seq = raw, time.monotonic(), self.seq + 1
                    for variant in self.jpeg:
                        self.jpeg[variant] = encoded.get(variant)
                    self.changed.notify_all()
                self.error = ""
            except Exception as error:  # noqa: BLE001 - a camera error must not take the server down
                self.error = f"{type(error).__name__}: {error}"
                await asyncio.sleep(0.5)
            await asyncio.sleep(max(0.0, interval - (time.monotonic() - started)))

    async def next_frame(self, variant: str, after: int, timeout: float) -> tuple[int, bytes]:
        """The first frame newer than `after` in this variant. TimeoutError if none comes."""
        async with self.changed:
            await asyncio.wait_for(
                self.changed.wait_for(lambda: self.seq > after and self.jpeg[variant] is not None), timeout,
            )
            return self.seq, self.jpeg[variant]  # type: ignore[return-value]


# --------------------------------------------------------------------------
# Shared state
# --------------------------------------------------------------------------

@dataclass
class RoverState:
    motors: MotorDriver
    camera: Camera
    # Each connected app and its session; None only when the rover runs with no token.
    clients: dict[web.WebSocketResponse, Session | None]
    hub: Any = None
    # The boxes from the detector's latest pass, drawn onto the overlay stream.
    overlay: list = field(default_factory=list)
    overlay_at: float = 0.0
    last_command: float = 0.0
    left_power: float = 0.0
    right_power: float = 0.0
    settings: dict[str, Any] = None
    siren_until: float = 0.0
    brake_until: float = 0.0
    # Last reading, so a device change can push telemetry at once without
    # waiting on BATTERY_CMD.
    battery: int = VALUE_UNAVAILABLE
    suppressed_detections: int = 0
    inference_ms: float = 0.0
    detector: Any = None
    detector_error: str = ""
    range_sensor: Any = None
    range_error: str = ""
    last_range: Any = None
    tickets: TicketBook = field(default_factory=TicketBook)
    limiter: FailureLimiter = field(default_factory=FailureLimiter)
    driver: Any = None
    driver_seen: float = 0.0
    denied: set = field(default_factory=set)
    tasks: set = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        # 720p by default: a Pi 4 encodes and sends it several times faster than
        # 1080p, which is the difference between a feed you can drive by and not.
        self.settings = {
            "detectionSensitivity": 74, "autoSiren": True, "showLocation": True,
            "cameraQuality": "720p", "whiteBalance": CAMERA_AWB,
        }

    def overlay_boxes(self) -> list[dict[str, Any]]:
        """Boxes still being seen. They expire like the app's do: a few passes unseen."""
        window = max(3.0, 4 * self.inference_ms / 1000)
        return self.overlay if time.monotonic() - self.overlay_at <= window else []

    def spawn(self, coroutine: Any) -> None:
        """Run something in the background, kept referenced until it finishes."""
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def send_to(self, ws: web.WebSocketResponse, payload: dict[str, Any]) -> bool:
        """Send one message, signed for that client's session. False if it failed."""
        if ws.closed or ws not in self.clients:
            return False
        session = self.clients[ws]
        message = session.seal(payload) if session else payload
        try:
            await asyncio.wait_for(ws.send_json(message), SEND_TIMEOUT)
            return True
        except (ConnectionResetError, RuntimeError, asyncio.TimeoutError):
            return False

    async def broadcast(self, payload: dict[str, Any]) -> None:
        """Send to every client at once, each with its own timeout.

        One after another, a single phone on a weak link could hold up telemetry
        and detections for every other client behind it.
        """
        clients = list(self.clients)
        if not clients:
            return
        results = await asyncio.gather(*(self.send_to(ws, payload) for ws in clients))
        for ws, delivered in zip(clients, results):
            if not delivered:
                self.clients.pop(ws, None)
                if not ws.closed:
                    self.spawn(ws.close())

    def claim_driver(self, ws: web.WebSocketResponse) -> bool:
        """True when this client may drive: it holds the controls, or nobody does."""
        now = time.monotonic()
        holder = self.driver
        if holder is not None and holder is not ws and not holder.closed and now - self.driver_seen < DRIVER_LEASE:
            return False
        self.driver = ws
        self.driver_seen = now
        return True

    async def push_telemetry(self) -> None:
        """Send telemetry now, so the app sees a device change without waiting."""
        await self.broadcast(telemetry_payload(self))

    async def stop(self) -> None:
        self.left_power = self.right_power = 0.0
        self.brake_until = 0.0
        self.motors.stop()

    async def brake(self) -> None:
        """Hard stop, released to a coast by the watchdog after BRAKE_HOLD."""
        self.left_power = self.right_power = 0.0
        self.last_command = 0.0
        self.motors.brake()
        self.brake_until = time.monotonic() + BRAKE_HOLD

    async def hold_siren(self, seconds: float) -> None:
        """Extend the siren deadline. Overlapping fires never cut each other short."""
        if "siren" not in self.motors.devices:
            return
        self.siren_until = max(self.siren_until, time.monotonic() + seconds)
        if not self.motors.device_state["siren"]:
            self.motors.set_device("siren", True)
            await self.push_telemetry()


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


def telemetry_payload(state: RoverState) -> dict[str, Any]:
    devices = state.motors.device_state
    return {
        "type": "telemetry",
        "roverName": ROVER_NAME,
        "batteryPercent": state.battery,
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
        # How fresh the video is. The app shows a stalled camera from this rather
        # than leaving the last picture on screen looking live.
        "cameraFrameAgeMs": round(min(state.hub.frame_age(), 3600.0) * 1000) if state.hub else VALUE_UNAVAILABLE,
        # The app offers white balance only for a camera that can take it.
        "whiteBalanceAvailable": state.camera.white_balance_available,
        # Available means a pin is wired. The on/off state is the rover's, not
        # the app's, so an auto-siren starting or timing out shows up too.
        "flashAvailable": "flash" in devices,
        "flashOn": devices.get("flash", False),
        "sirenAvailable": "siren" in devices,
        "sirenOn": devices.get("siren", False),
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
    if box is not None:
        if not isinstance(box, dict) or not all(key in box for key in ("left", "top", "width", "height")):
            raise ValueError("boundingBox needs left, top, width and height percentages")
        # Percentages of the frame. A NaN or a huge value would reach the app and
        # draw nonsense, or nothing, over the live video.
        box = {key: round(max(0.0, min(100.0, finite(box[key]))), 2) for key in ("left", "top", "width", "height")}

    confidence = round(max(0.0, min(100.0, finite(data.get("confidence", 0)))), 1)
    # Higher sensitivity permits lower-confidence model results.
    minimum = 85 - float(state.settings["detectionSensitivity"]) * 0.6
    if confidence < minimum:
        state.suppressed_detections += 1
        return {"ok": True, "ignored": "below sensitivity threshold", "threshold": round(minimum, 1)}

    detection = {
        "id": str(data.get("id") or uuid.uuid4())[:64],
        "kind": data["kind"],
        "confidence": confidence,
        "timestamp": time.strftime("%H:%M:%S"),
        "epoch": time.time(),
        "location": str(data.get("location") or "Camera view")[:80],
        "snapshotUrl": data.get("snapshotUrl", ""),
        "boundingBox": box,
        "confirmedBySensor": bool(data.get("confirmedBySensor", False)),
    }
    if detection["kind"] == "fire" and state.settings["autoSiren"]:
        await state.hold_siren(SIREN_HOLD)
    await state.broadcast({"type": "detection", "detection": detection})
    return {"ok": True, "detection": detection}


async def detection_handler(request: web.Request) -> web.Response:
    """Accept a fire/smoke result from an external inference process."""
    refused = check_http(request)
    if refused:
        return refused
    state: RoverState = request.app["state"]
    try:
        data = strict_loads(await request.text())
    except ValueError:
        return web.json_response({"error": "body must be JSON"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"error": "body must be a JSON object"}, status=400)

    # No default snapshotUrl. /frame.jpg is the live view, not a picture of what
    # was detected, and the app would show it as the detection's snapshot.
    try:
        result = await publish_detection(state, data)
    except (ValueError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response(result)


# --------------------------------------------------------------------------
# HTTP and WebSocket
# --------------------------------------------------------------------------

async def frame_handler(request: web.Request) -> web.Response:
    refused = check_http(request, "frame")
    if refused:
        return refused
    state: RoverState = request.app["state"]
    hub: FrameHub = state.hub
    if hub.raw is None or hub.frame_age() > STREAM_FRAME_TIMEOUT:
        return web.json_response({"error": hub.error or "the camera has not delivered a frame"}, status=503)
    overlay = request.query.get("overlay") == "1"
    encoded = await asyncio.get_running_loop().run_in_executor(
        None, encode_variants, hub.raw, state.overlay_boxes(), {"overlay" if overlay else "raw"},
    )
    body = encoded.get("overlay" if overlay else "raw")
    if body is None:
        return web.json_response({"error": "Unable to encode camera frame"}, status=503)
    return web.Response(body=body, content_type="image/jpeg", headers={"Cache-Control": "no-store"})


async def stream_handler(request: web.Request) -> web.StreamResponse:
    """Continuous MJPEG video, the way a browser shows a webcam.

    `?overlay=1` gives the video with the fire and smoke boxes drawn on it, as
    model/live_test.py shows it; without it, the plain camera. Each new frame is sent
    the moment the hub has it.
    """
    refused = check_http(request, "stream")
    if refused:
        return refused
    state: RoverState = request.app["state"]
    hub: FrameHub = state.hub
    variant = "overlay" if request.query.get("overlay") == "1" else "raw"
    response = web.StreamResponse(headers={
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store",
        # The app shows this from a local WebView page, which has no origin of its
        # own. A ticket or the token above still gates every request.
        "Access-Control-Allow-Origin": "*",
    })
    await response.prepare(request)
    hub.viewers[variant] += 1
    seq = 0
    try:
        while True:
            try:
                seq, jpeg = await hub.next_frame(variant, seq, STREAM_FRAME_TIMEOUT)
            except asyncio.TimeoutError:
                # The camera stopped delivering. Ending the stream lets the app say
                # so, instead of holding a frozen frame on screen.
                print(f"Stream ended: no camera frame for {STREAM_FRAME_TIMEOUT:.0f} s ({hub.error or 'no error reported'})")
                break
            await response.write(
                b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n"
            )
    except ConnectionResetError:
        pass  # The viewer went away.
    finally:
        hub.viewers[variant] -= 1
    return response


async def status_handler(request: web.Request) -> web.Response:
    """Liveness probe. Without the token it says only that the rover is up.

    The details (motor state, wheel power, settings) are for tools holding the token;
    anyone else on the network learns nothing they could use.
    """
    state: RoverState = request.app["state"]
    if ROVER_TOKEN and not token_matches(request):
        return web.json_response({"ok": True, "roverName": ROVER_NAME, "authRequired": True, "protocol": PROTOCOL})
    return web.json_response({
        "protocol": PROTOCOL,
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


async def authenticate(ws: web.WebSocketResponse, state: "RoverState", address: str) -> Session | None:
    """Challenge-response: the app proves it holds the token without sending it.

    See security.py. A wrong answer, no answer within AUTH_TIMEOUT, or anything
    that is not an answer counts as a failure towards the address's lockout.
    """
    nonce = new_nonce()
    await ws.send_json({"type": "challenge", "nonce": nonce, "protocol": PROTOCOL})
    try:
        message = await ws.receive(timeout=AUTH_TIMEOUT)
        reply = strict_loads(message.data) if message.type == web.WSMsgType.TEXT else None
    except (asyncio.TimeoutError, ValueError, TypeError):
        reply = None
    if not (isinstance(reply, dict) and reply.get("type") == "auth" and is_hex_nonce(reply.get("clientNonce"))
            and isinstance(reply.get("mac"), str)):
        state.limiter.fail(address)
        # Said out loud: an app from before the challenge existed fails exactly
        # here, silently, and the log was the only place to find out why.
        print(f"Refused a control connection from {address}: no answer to the challenge "
              "(an app older than this rover, or not the app at all)")
        return None
    if not hmac.compare_digest(reply["mac"], auth_proof(ROVER_TOKEN, nonce, reply["clientNonce"])):
        state.limiter.fail(address)
        print(f"Refused a control connection from {address}: wrong token")
        return None
    state.limiter.succeed(address)
    key = session_key(ROVER_TOKEN, nonce, reply["clientNonce"])
    # The rover proves itself too, so the app can tell it is not talking to an
    # impostor that took the rover's address on the network.
    await ws.send_json({"type": "authOk", "proof": server_proof(key)})
    return Session(key)


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    state: RoverState = request.app["state"]
    address = request.remote or "unknown"
    if state.limiter.blocked(address):
        return web.json_response({"error": "too many failed attempts; try again in a minute"}, status=429)

    ws = web.WebSocketResponse(heartbeat=10, max_msg_size=MAX_MESSAGE_BYTES)
    await ws.prepare(request)
    if ROVER_TOKEN:
        session = await authenticate(ws, state, address)
        if session is None:
            await ws.close(code=4401, message=b"authentication failed")
            return ws
    else:
        # Open mode, for a bench with no token: say so, so an app that holds a
        # token can refuse to talk to a rover that is not asking for it.
        session = None
        await ws.send_json({"type": "hello", "auth": "none", "protocol": PROTOCOL})

    state.clients[ws] = session
    # finally, because a send failing mid-session must still deregister this
    # client and, if it was the last one, cut the motors.
    try:
        await state.send_to(ws, telemetry_payload(state))
        await state.send_to(ws, {"type": "settings", "settings": state.settings})

        async for message in ws:
            if message.type != web.WSMsgType.TEXT:
                continue
            try:
                received = strict_loads(message.data)
                command = session.open(received) if session else received
            except (ValueError, TypeError):
                # Forged, replayed or malformed. Dropping the packet rather than the
                # connection means an injected packet cannot cut a real driver off.
                continue
            if not isinstance(command, dict):
                continue

            kind = command.get("type")
            try:
                if kind == "drive":
                    throttle = clamp(finite(command.get("throttle", 0)))
                    steering = clamp(finite(command.get("steering", 0)))
                    if not state.claim_driver(ws):
                        # Another device holds the controls. Tell this one once.
                        if ws not in state.denied:
                            state.denied.add(ws)
                            await state.send_to(ws, {"type": "control", "driving": False, "reason": "Another device is driving"})
                        continue
                    if ws in state.denied:
                        state.denied.discard(ws)
                        await state.send_to(ws, {"type": "control", "driving": True})
                    if state.brake_until and throttle == 0 and steering == 0:
                        # Letting go of the stick just after BRAKE sends a zero
                        # command; that must not cut the brake short.
                        continue
                    # Driving again takes over from a brake at once.
                    state.brake_until = 0.0
                    state.left_power, state.right_power = state.motors.drive(throttle, steering, command.get("sprint") is True)
                    state.last_command = time.monotonic()
                elif kind == "brake":
                    # From any device, driver or not: stopping is never locked out.
                    await state.brake()
                elif kind == "ticket":
                    purpose = command.get("purpose")
                    if purpose in ("stream", "frame"):
                        # A stream ticket opens one stream; a frame ticket covers
                        # polling for its lifetime.
                        ticket = state.tickets.issue(purpose, reusable=purpose == "frame")
                        await state.send_to(ws, {"type": "ticket", "purpose": purpose, "ticket": ticket, "ttl": state.tickets.ttl})
                elif kind == "device":
                    device = command.get("device")
                    if device in ("flash", "siren"):
                        if state.motors.set_device(device, command.get("enabled") is True) and device == "siren":
                            # A manual siren toggle wins over an auto-siren hold.
                            state.siren_until = 0.0
                        # Always answer, so a toggle for an unwired device snaps
                        # back in the app instead of looking switched on.
                        await state.push_telemetry()
                elif kind == "settings":
                    incoming = command.get("settings", {})
                    if isinstance(incoming, dict):
                        sensitivity = incoming.get("detectionSensitivity", state.settings["detectionSensitivity"])
                        state.settings["detectionSensitivity"] = max(0, min(100, int(finite(sensitivity))))
                        state.settings["autoSiren"] = bool(incoming.get("autoSiren", state.settings["autoSiren"]))
                        state.settings["showLocation"] = bool(incoming.get("showLocation", state.settings["showLocation"]))
                        quality = incoming.get("cameraQuality", state.settings["cameraQuality"])
                        if quality in QUALITY_DIMENSIONS:
                            state.settings["cameraQuality"] = quality
                            state.camera.set_quality(quality)
                        balance = incoming.get("whiteBalance")
                        if balance in WHITE_BALANCE_MODES and state.camera.set_white_balance(balance):
                            state.settings["whiteBalance"] = balance
                    await state.send_to(ws, {"type": "settings", "settings": state.settings})
            except (TypeError, ValueError):
                # One malformed packet must not end a driving session.
                continue
    finally:
        state.clients.pop(ws, None)
        state.denied.discard(ws)
        if state.driver is ws:
            # The driver left: stop rather than carry on with its last command.
            state.driver = None
            await state.stop()
        # Only stop the motors when the last operator disconnects.
        if not state.clients:
            await state.stop()
    return ws


# --------------------------------------------------------------------------
# Background tasks
# --------------------------------------------------------------------------

async def watchdog(state: RoverState) -> None:
    while True:
        try:
            now = time.monotonic()
            if state.last_command and now - state.last_command > CONTROL_TIMEOUT:
                await state.stop()
                state.last_command = 0.0
            if state.brake_until and now > state.brake_until:
                await state.stop()
            if state.siren_until and now > state.siren_until:
                state.siren_until = 0.0
                state.motors.set_device("siren", False)
                # In the background: the watchdog's own loop must never wait on a
                # client's network, or a stalled phone could delay a motor stop.
                state.spawn(state.push_telemetry())
        except Exception as error:  # noqa: BLE001 - the watchdog must outlive any one failure
            print(f"Watchdog error: {type(error).__name__}: {error}")
        await asyncio.sleep(0.05)


async def telemetry_loop(state: RoverState) -> None:
    while True:
        try:
            state.battery = await read_battery_percent()
            await state.push_telemetry()
        except Exception as error:  # noqa: BLE001 - keep reporting on the next tick
            print(f"Telemetry error: {type(error).__name__}: {error}")
        await asyncio.sleep(TELEMETRY_INTERVAL)


def frame_for_detector(frame: Any) -> Any:
    """The frame shrunk to the model's input width before it crosses to the detector.

    The model letterboxes to DETECT_IMGSZ anyway, so this loses nothing, and a
    640-wide frame is a quarter of the bytes of a 1280-wide one to copy between
    processes. Boxes come back in percent, so the scale does not matter to them.
    """
    height, width = frame.shape[:2]
    if width <= DETECT_FRAME_WIDTH:
        return frame
    return cv2.resize(frame, (DETECT_FRAME_WIDTH, round(height * DETECT_FRAME_WIDTH / width)), interpolation=cv2.INTER_AREA)


def start_detector_process() -> ProcessPoolExecutor:
    # spawn, not fork: forking a process that has the camera open copies its
    # threads' state into the child, which is how a camera ends up wedged.
    return ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn"))


async def load_detector(state: RoverState, pool: ProcessPoolExecutor) -> bool:
    from fire_detector import DetectorUnavailable, worker_load

    try:
        classes = await asyncio.get_running_loop().run_in_executor(pool, worker_load)
    except DetectorUnavailable as error:
        state.detector_error = str(error)
        print(f"Fire detector disabled: {error}")
        return False
    except Exception as error:  # noqa: BLE001 - never take the server down with it
        state.detector_error = f"{type(error).__name__}: {error}"
        print(f"Fire detector failed to load: {error}")
        return False
    print(f"Fire detector running in its own process, classes={classes}")
    state.detector = pool
    state.detector_error = ""
    return True


async def detector_loop(state: RoverState) -> None:
    """Run the on-device model against the live camera and publish what it finds.

    The model runs in a separate process; see the note in fire_detector.py.
    """
    from fire_detector import worker_detect

    loop = asyncio.get_running_loop()
    pool = start_detector_process()
    try:
        if not await load_detector(state, pool):
            return
        while True:
            started = time.monotonic()
            try:
                # The hub's latest frame: the camera is read once for video and model alike.
                hub: FrameHub = state.hub
                source = hub.raw if hub.raw is not None and hub.frame_age() < 1.0 else None
                frame = await loop.run_in_executor(
                    None, lambda: frame_for_detector(source if source is not None else state.camera.raw_frame()),
                )
                detections, inference_ms = await loop.run_in_executor(pool, worker_detect, frame)
                state.inference_ms = inference_ms
                state.detector_error = ""
                shown = []
                for detection in detections:
                    # No snapshotUrl: the rover cannot know which address the phone
                    # reaches it on, and a 127.0.0.1 link would be dead on the phone.
                    # The app shows a kind icon instead of a broken thumbnail.
                    result = await publish_detection(state, detection)
                    # Only boxes that passed the sensitivity gate are drawn, so the
                    # video shows exactly what the alerts show.
                    if "detection" in result:
                        shown.append(result["detection"])
                state.overlay, state.overlay_at = shown, time.monotonic()
            except BrokenProcessPool:
                # The detector process died (out of memory, a native crash). The
                # rover keeps driving; bring the model back in a fresh process.
                state.detector = None
                state.detector_error = "The detector process stopped; restarting it."
                print(state.detector_error)
                pool.shutdown(wait=False, cancel_futures=True)
                pool = start_detector_process()
                await asyncio.sleep(2)
                await load_detector(state, pool)
            except Exception as error:  # noqa: BLE001 - keep the rover driveable
                state.detector_error = f"{type(error).__name__}: {error}"
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(0.0, DETECT_INTERVAL - elapsed))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


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
    app["hub"] = asyncio.create_task(state.hub.run(state))
    app["watchdog"] = asyncio.create_task(watchdog(state))
    app["telemetry"] = asyncio.create_task(telemetry_loop(state))
    if DETECTOR_ENABLED:
        app["detector"] = asyncio.create_task(detector_loop(state))
    if RANGE_ENABLED:
        app["range"] = asyncio.create_task(range_loop(state))


async def stop_background_tasks(app: web.Application) -> None:
    for key in ("hub", "watchdog", "telemetry", "detector", "range"):
        task = app.get(key)
        if task:
            task.cancel()
    await app["state"].stop()
    app["state"].camera.close()
    app["state"].motors.close()


def make_app() -> web.Application:
    app = web.Application()
    state = RoverState(MotorDriver(), Camera(), {})
    state.hub = FrameHub(state.camera)
    app["state"] = state
    app.router.add_get("/frame.jpg", frame_handler)
    app.router.add_get("/stream.mjpg", stream_handler)
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

    # run_app turns SIGINT and SIGTERM into a graceful exit, which runs
    # stop_background_tasks and so stops the motors before the process ends.
    web.run_app(make_app(), host="0.0.0.0", port=HTTP_PORT)
