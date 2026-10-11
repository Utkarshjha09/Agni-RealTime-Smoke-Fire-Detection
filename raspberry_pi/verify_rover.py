#!/usr/bin/env python3
"""Check a running rover the way the app does, and report what is really there.

Point it at a rover -- your laptop while testing, or the Pi over the network --
and it exercises every endpoint the app uses: the token, the camera frame, the
telemetry stream, a drive command, the safety watchdog, and the detector.

    python verify_rover.py                                   # localhost:8000
    python verify_rover.py --host 192.168.1.50 --token abc123
    python verify_rover.py --host 192.168.1.50 --token abc123 --drive

Without --drive it sends no motion at all, so it is safe to run against a rover
with its motors live. With --drive it sends one brief command and confirms the
watchdog cuts power afterwards; put the robot on blocks first.

Exit code is 0 only when every check passed.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from typing import Callable

try:
    import aiohttp
except ImportError:
    print("aiohttp is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(2)

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"
results: list[tuple[str, str, str]] = []


def record(state: str, name: str, detail: str = "") -> None:
    results.append((state, name, detail))
    print(f"  [{state}] {name}" + (f" -- {detail}" if detail else ""))


async def check_status(session: aiohttp.ClientSession, base: str) -> dict | None:
    try:
        async with session.get(f"{base}/status", timeout=aiohttp.ClientTimeout(total=5)) as response:
            if response.status != 200:
                record(FAIL, "GET /status", f"HTTP {response.status}")
                return None
            status = await response.json()
    except Exception as error:  # noqa: BLE001 - reporting it is the whole point
        record(FAIL, "GET /status", f"{type(error).__name__}: {error}")
        print("\n  The rover is not answering. Is rover_server.py running, and is the")
        print("  address right? On the Pi:  sudo systemctl status agni-rover")
        return None

    record(PASS, "GET /status", f"{status.get('roverName')} camera={status.get('cameraSource')}")

    if status.get("cameraSource") == "none":
        record(WARN, "Camera", "no camera found, serving a synthetic test frame")
    else:
        record(PASS, "Camera", f"source is {status['cameraSource']}")

    if status.get("authRequired"):
        record(PASS, "Token required", "ROVER_TOKEN is set")
    else:
        record(WARN, "Token required", "ROVER_TOKEN is empty -- anyone on this network can drive")

    if status.get("detectorActive"):
        record(PASS, "Detector", "model loaded and running")
    elif status.get("detectorError"):
        record(FAIL, "Detector", status["detectorError"])
    else:
        record(WARN, "Detector", "not enabled; start the rover with DETECTOR=1")

    if status.get("motorOutput"):
        record(WARN, "Motor output", "LIVE -- the wheels will turn")
    else:
        record(PASS, "Motor output", "disabled (MOTOR_OUTPUT=0)")
    return status


async def check_auth(session: aiohttp.ClientSession, base: str, token: str) -> None:
    """A rover with a token must turn away a request that does not carry it."""
    try:
        async with session.get(f"{base}/frame.jpg", timeout=aiohttp.ClientTimeout(total=5)) as response:
            if response.status == 401:
                record(PASS, "Rejects a missing token", "GET /frame.jpg -> 401")
            else:
                record(FAIL, "Rejects a missing token", f"got HTTP {response.status}, expected 401")
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Rejects a missing token", f"{type(error).__name__}: {error}")

    try:
        async with session.get(f"{base}/frame.jpg?token={token}wrong", timeout=aiohttp.ClientTimeout(total=5)) as response:
            if response.status == 401:
                record(PASS, "Rejects a wrong token", "GET /frame.jpg -> 401")
            else:
                record(FAIL, "Rejects a wrong token", f"got HTTP {response.status}, expected 401")
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Rejects a wrong token", f"{type(error).__name__}: {error}")


async def check_frame(session: aiohttp.ClientSession, base: str, token: str) -> None:
    url = f"{base}/frame.jpg" + (f"?token={token}" if token else "")
    try:
        started = time.perf_counter()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as response:
            body = await response.read()
            elapsed = (time.perf_counter() - started) * 1000
        if response.status != 200:
            record(FAIL, "Camera frame", f"HTTP {response.status}: {body[:120]!r}")
            return
        # A JPEG starts FF D8 FF. Anything else is not an image the app can draw.
        if not body.startswith(b"\xff\xd8\xff"):
            record(FAIL, "Camera frame", f"not a JPEG ({len(body)} bytes)")
            return
        record(PASS, "Camera frame", f"{len(body) / 1024:.0f} KB JPEG in {elapsed:.0f} ms")
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Camera frame", f"{type(error).__name__}: {error}")


async def check_stream(session: aiohttp.ClientSession, base: str, token: str) -> None:
    """The live video the app shows: count whole JPEG frames for two seconds."""
    url = f"{base}/stream.mjpg" + (f"?token={token}" if token else "")
    frames, sizes, buffer = 0, [], b""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=None, sock_read=5)) as response:
            if response.status != 200:
                record(FAIL, "Live stream", f"HTTP {response.status}")
                return
            if not response.headers.get("Content-Type", "").startswith("multipart/x-mixed-replace"):
                record(FAIL, "Live stream", f"not MJPEG: {response.headers.get('Content-Type')}")
                return
            started = time.perf_counter()
            while time.perf_counter() - started < 2.0:
                buffer += await response.content.readany()
                # Parse exactly as the app does: each part's Content-Length.
                while True:
                    head_end = buffer.find(b"\r\n\r\n")
                    if head_end < 0:
                        break
                    header = buffer[:head_end].decode("latin-1").lower()
                    length_at = header.find("content-length:")
                    if length_at < 0:
                        buffer = buffer[head_end + 4:]
                        continue
                    length = int(header[length_at + 15:].split()[0])
                    start = head_end + 4
                    if len(buffer) < start + length:
                        break
                    jpeg = buffer[start:start + length]
                    buffer = buffer[start + length:]
                    if not jpeg.startswith(b"\xff\xd8\xff"):
                        record(FAIL, "Live stream", "a part was not a JPEG")
                        return
                    frames += 1
                    sizes.append(len(jpeg))
            elapsed = time.perf_counter() - started
        if frames == 0:
            record(FAIL, "Live stream", "connected, but no frame arrived in 2 s")
        else:
            record(PASS, "Live stream", f"{frames / elapsed:.1f} fps, ~{sum(sizes) / len(sizes) / 1024:.0f} KB per frame")
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Live stream", f"{type(error).__name__}: {error}")


async def await_type(
    ws: aiohttp.ClientWebSocketResponse,
    wanted: str,
    seconds: float,
    match: Callable[[dict], bool] | None = None,
) -> dict | None:
    """Next packet of one type, ignoring the others already flowing down the socket.

    `match` is needed for settings: the rover pushes its current settings the
    moment you connect, so a reply has to be told apart from that greeting
    rather than simply being the next settings packet to arrive.
    """
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        remaining = max(0.1, deadline - time.monotonic())
        try:
            message = await asyncio.wait_for(ws.receive_json(), timeout=remaining)
        except asyncio.TimeoutError:
            return None
        if message.get("type") == wanted and (match is None or match(message)):
            return message
    return None


async def check_control(session: aiohttp.ClientSession, base: str, token: str, drive: bool) -> None:
    url = f"{base.replace('http', 'ws', 1)}/control" + (f"?token={token}" if token else "")
    try:
        async with session.ws_connect(url, timeout=aiohttp.ClientTimeout(total=10)) as ws:
            record(PASS, "Control WebSocket", "connected")

            telemetry = await await_type(ws, "telemetry", 8)
            if telemetry is None:
                record(FAIL, "Telemetry", "no telemetry packet arrived")
                return
            record(PASS, "Telemetry", f"inference {telemetry.get('inferenceMs')} ms, hfov {telemetry.get('cameraHfovDeg')} deg")

            # The 3D view turns a box position into a bearing using this angle.
            if not telemetry.get("cameraHfovDeg"):
                record(WARN, "Camera field of view", "CAMERA_HFOV is 0; the 3D view cannot place detections")

            if telemetry.get("rangeSensorActive"):
                record(PASS, "Range sensor", f"max {telemetry.get('rangeMaxM')} m")
            elif telemetry.get("rangeSensorError"):
                record(WARN, "Range sensor", telemetry["rangeSensorError"])

            # The app pushes its sensitivity the moment it connects, so this
            # round-trip is on the critical path for detections appearing at all.
            await ws.send_json({"type": "settings", "settings": {"detectionSensitivity": 61}})
            echo = await await_type(ws, "settings", 6, lambda packet: packet.get("settings", {}).get("detectionSensitivity") == 61)
            if echo:
                record(PASS, "Settings round-trip", "sensitivity accepted and echoed")
            else:
                record(FAIL, "Settings round-trip", f"got {echo}")

            # The app shows the flashlight and siren only when the rover says a pin
            # is wired, and draws their state from telemetry rather than its own
            # guess. A missing field here means the button silently disappears.
            if "flashAvailable" not in telemetry or "sirenAvailable" not in telemetry:
                record(FAIL, "Device fields", "telemetry has no flashAvailable/sirenAvailable")
            elif telemetry["flashAvailable"]:
                # The flashlight is quiet, so it is safe to switch; the siren is not.
                await ws.send_json({"type": "device", "device": "flash", "enabled": True})
                on = await await_type(ws, "telemetry", 4, lambda packet: packet.get("flashOn") is True)
                await ws.send_json({"type": "device", "device": "flash", "enabled": False})
                off = await await_type(ws, "telemetry", 4, lambda packet: packet.get("flashOn") is False)
                if on and off:
                    record(PASS, "Flashlight", "switched on and off, state reported back")
                else:
                    record(FAIL, "Flashlight", "the rover did not report the new state")
            else:
                record(WARN, "Flashlight", "not wired; set FLASH_PIN to enable the button in the app")

            if not drive:
                record(WARN, "Drive command", "skipped; pass --drive to test motion")
                return

            # Differential drive: left = throttle + steering, right = throttle - steering,
            # each scaled by the duty ceiling. Turning left should leave the right
            # wheel running faster than the left.
            await ws.send_json({"type": "drive", "throttle": 1.0, "steering": -0.4, "sprint": False})
            await asyncio.sleep(0.1)
            async with session.get(f"{base}/status") as response:
                moving = await response.json()
            left, right = moving.get("leftPower", 0), moving.get("rightPower", 0)
            if right > left > 0:
                record(PASS, "Drive command", f"left {left}, right {right} -- right leads in a left turn")
            elif left or right:
                record(WARN, "Drive command", f"left {left}, right {right} -- moving, but not the expected split")
            else:
                record(FAIL, "Drive command", "the rover reported no wheel power")

            # Nothing more is sent, so the watchdog has to cut power on its own.
            # This is the check that matters most: it is what stops a rover whose
            # operator walked out of Wi-Fi range.
            await asyncio.sleep(1.2)
            async with session.get(f"{base}/status") as response:
                stopped = await response.json()
            if stopped.get("leftPower") == 0 and stopped.get("rightPower") == 0:
                record(PASS, "Watchdog stop", "power cut after the commands stopped")
            else:
                record(FAIL, "Watchdog stop", f"still at {stopped.get('leftPower')}/{stopped.get('rightPower')}")

            await ws.send_json({"type": "brake"})
    except aiohttp.WSServerHandshakeError as error:
        detail = "wrong or missing token" if error.status == 401 else f"HTTP {error.status}"
        record(FAIL, "Control WebSocket", detail)
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Control WebSocket", f"{type(error).__name__}: {error}")


async def run(host: str, port: int, token: str, drive: bool) -> int:
    base = f"http://{host}:{port}"
    print(f"\nChecking the rover at {base}\n")
    async with aiohttp.ClientSession() as session:
        status = await check_status(session, base)
        if status is None:
            print("\nFAILED: the rover did not answer at all.")
            return 1
        if status.get("authRequired") and not token:
            record(FAIL, "Token", "this rover needs a token; pass --token")
        else:
            if status.get("authRequired"):
                await check_auth(session, base, token)
            await check_frame(session, base, token)
            await check_stream(session, base, token)
            await check_control(session, base, token, drive)

    failed = [name for state, name, _ in results if state == FAIL]
    warned = [name for state, name, _ in results if state == WARN]
    print(f"\n{len(results) - len(failed) - len(warned)} passed, {len(warned)} warnings, {len(failed)} failed")
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    print("\nThe rover is ready for the app. Enter in Settings:")
    print(f"  Camera frame URL       {base}/frame.jpg")
    print(f"  Control WebSocket URL  ws://{host}:{port}/control")
    print(f"  Access token           {token or '(none set)'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1", help="rover address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--token", default="", help="the ROVER_TOKEN the rover was started with")
    parser.add_argument("--drive", action="store_true", help="also send one drive command; put the robot on blocks")
    args = parser.parse_args()
    return asyncio.run(run(args.host, args.port, args.token, args.drive))


if __name__ == "__main__":
    raise SystemExit(main())
