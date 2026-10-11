#!/usr/bin/env python3
"""Check a running rover the way the app does, and report what is really there.

Point it at a rover -- your laptop while testing, or the Pi over the network --
and it exercises every endpoint the app uses: the token, the camera frame, the
live stream, the authenticated control link, telemetry, a drive command, the
safety watchdog and the detector. It also attacks the link the way someone else
on the Wi-Fi could, and checks each attack is refused.

    python verify_rover.py                                   # localhost:8000
    python verify_rover.py --host 192.168.1.50 --token abc123
    python verify_rover.py --host 192.168.1.50 --token abc123 --drive

Without --drive it sends no motion at all, so it is safe to run against a rover
with its motors live. With --drive it sends brief commands and confirms the
watchdog cuts power afterwards; put the robot on blocks first.

It sends the token in clear for its HTTP checks, as any tool does; the app never
does. Run it on a network you trust, or accept that whoever is listening learns it.

Exit code is 0 only when every check passed.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from typing import Any, Callable

try:
    import aiohttp
except ImportError:
    print("aiohttp is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(2)

from security import (
    FailureLimiter, Session, TicketBook, auth_proof, new_nonce, server_proof, session_key, strict_loads,
)

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"
results: list[tuple[str, str, str]] = []


def record(state: str, name: str, detail: str = "") -> None:
    results.append((state, name, detail))
    print(f"  [{state}] {name}" + (f" -- {detail}" if detail else ""))


# --------------------------------------------------------------------------
# The security primitives, on known values, before touching the network
# --------------------------------------------------------------------------

def self_test() -> None:
    try:
        strict_loads('{"throttle": NaN}')
        record(FAIL, "NaN refused", "a NaN throttle parsed; the clamp would turn it into full speed")
    except ValueError:
        record(PASS, "NaN refused", "NaN and Infinity cannot reach the motors")

    key = bytes(range(32))
    app, rover = Session.for_client(key), Session(key)
    first = app.seal({"type": "drive", "throttle": 0.5})
    ok = rover.open(first) == {"type": "drive", "throttle": 0.5}
    refused = []
    for name, packet in (
        ("replayed", first),
        ("forged", {**app.seal({"type": "brake"}), "mac": "0" * 64}),
        ("reflected", rover.seal({"type": "drive", "throttle": 1})),
    ):
        try:
            rover.open(packet)
        except ValueError:
            refused.append(name)
    if ok and refused == ["replayed", "forged", "reflected"]:
        record(PASS, "Message signing", "accepts a signed message; refuses replayed, forged and reflected ones")
    else:
        record(FAIL, "Message signing", f"accepted={ok}, refused={refused}")

    book = TicketBook()
    ticket = book.issue("stream")
    if book.redeem(ticket, "stream") and not book.redeem(ticket, "stream") and not book.redeem(book.issue("frame"), "stream"):
        record(PASS, "Video tickets", "one use only, and only for their purpose")
    else:
        record(FAIL, "Video tickets", "a ticket was accepted twice or for the wrong purpose")

    limiter = FailureLimiter(limit=3)
    for _ in range(3):
        limiter.fail("10.0.0.9")
    if limiter.blocked("10.0.0.9") and not limiter.blocked("10.0.0.10"):
        record(PASS, "Lockout", "an address is locked out after repeated failures, others are not")
    else:
        record(FAIL, "Lockout", "repeated failures did not lock the address out")


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

async def check_status(session: aiohttp.ClientSession, base: str, token: str) -> dict | None:
    try:
        async with session.get(f"{base}/status", timeout=aiohttp.ClientTimeout(total=5)) as response:
            if response.status != 200:
                record(FAIL, "GET /status", f"HTTP {response.status}")
                return None
            public = await response.json()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        async with session.get(f"{base}/status", headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as response:
            status = await response.json()
    except Exception as error:  # noqa: BLE001 - reporting it is the whole point
        record(FAIL, "GET /status", f"{type(error).__name__}: {error}")
        print("\n  The rover is not answering. Is rover_server.py running, and is the")
        print("  address right? On the Pi:  sudo systemctl status agni-rover")
        return None

    if public.get("authRequired") and "motorOutput" in public:
        record(FAIL, "Status without a token", "reveals motor state to anyone on the network")
    elif public.get("authRequired"):
        record(PASS, "Status without a token", "says only that the rover is up")

    if "cameraSource" not in status:
        record(FAIL, "GET /status", "the token was not accepted; check --token")
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
    for name, url in (("Rejects a missing token", f"{base}/frame.jpg"), ("Rejects a wrong token", f"{base}/frame.jpg?token={token}wrong")):
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as response:
                if response.status == 401:
                    record(PASS, name, "GET /frame.jpg -> 401")
                else:
                    record(FAIL, name, f"got HTTP {response.status}, expected 401")
        except Exception as error:  # noqa: BLE001
            record(FAIL, name, f"{type(error).__name__}: {error}")


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


async def measure_stream(session: aiohttp.ClientSession, url: str, seconds: float = 2.0) -> tuple[int, int, float, list[int]]:
    """Open a stream and count whole JPEG frames, parsed exactly as the app does."""
    frames, sizes, buffer = 0, [], b""
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=None, sock_read=5)) as response:
        if response.status != 200 or not response.headers.get("Content-Type", "").startswith("multipart/x-mixed-replace"):
            return response.status, 0, 0.0, []
        started = time.perf_counter()
        while time.perf_counter() - started < seconds:
            buffer += await response.content.readany()
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
                jpeg, buffer = buffer[start:start + length], buffer[start + length:]
                if not jpeg.startswith(b"\xff\xd8\xff"):
                    return 200, frames, time.perf_counter() - started, sizes
                frames += 1
                sizes.append(len(jpeg))
        return 200, frames, time.perf_counter() - started, sizes


async def check_stream(session: aiohttp.ClientSession, base: str, token: str) -> None:
    url = f"{base}/stream.mjpg" + (f"?token={token}" if token else "")
    try:
        status, frames, elapsed, sizes = await measure_stream(session, url)
        if status != 200:
            record(FAIL, "Live stream", f"HTTP {status}")
        elif frames == 0:
            record(FAIL, "Live stream", "connected, but no frame arrived in 2 s")
        else:
            record(PASS, "Live stream", f"{frames / elapsed:.1f} fps, ~{sum(sizes) / len(sizes) / 1024:.0f} KB per frame")
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Live stream", f"{type(error).__name__}: {error}")


# --------------------------------------------------------------------------
# The control link, authenticated the way the app does it
# --------------------------------------------------------------------------

class ControlLink:
    """A control socket after the handshake: sends signed, receives verified."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse, session: Session | None) -> None:
        self.ws = ws
        self.session = session

    async def send(self, payload: dict[str, Any]) -> None:
        await self.ws.send_json(self.session.seal(payload) if self.session else payload)

    async def receive(self, seconds: float) -> dict[str, Any] | None:
        try:
            message = await self.ws.receive_json(timeout=seconds)
        except (asyncio.TimeoutError, TypeError, ValueError):
            return None
        return self.session.open(message) if self.session else message

    async def await_type(self, wanted: str, seconds: float, match: Callable[[dict], bool] | None = None) -> dict | None:
        """Next message of one type, ignoring the others already flowing down the socket."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            message = await self.receive(max(0.1, deadline - time.monotonic()))
            if message is None:
                return None
            if message.get("type") == wanted and (match is None or match(message)):
                return message
        return None


async def open_control(http: aiohttp.ClientSession, base: str, token: str) -> tuple[ControlLink | None, str]:
    """Connect and authenticate. Returns the link, or None and why it failed."""
    ws = await http.ws_connect(f"{base.replace('http', 'ws', 1)}/control")
    first = await ws.receive_json(timeout=5)
    if first.get("type") == "hello" and first.get("auth") == "none":
        if token:
            await ws.close()
            return None, "the rover is not asking for a token (ROVER_TOKEN is empty); refusing, as the app does"
        return ControlLink(ws, None), "open"
    if first.get("type") != "challenge":
        await ws.close()
        return None, f"expected a challenge, got {first.get('type')}"
    client_nonce = new_nonce()
    await ws.send_json({"type": "auth", "clientNonce": client_nonce, "mac": auth_proof(token, first["nonce"], client_nonce)})
    reply = await ws.receive(timeout=5)
    if reply.type != aiohttp.WSMsgType.TEXT:
        await ws.close()
        return None, f"connection closed ({ws.close_code}): wrong token?"
    answer = strict_loads(reply.data)
    key = session_key(token, first["nonce"], client_nonce)
    if answer.get("type") != "authOk" or answer.get("proof") != server_proof(key):
        await ws.close()
        return None, "the rover could not prove it holds the token: an impostor, or a different token"
    return ControlLink(ws, Session.for_client(key)), "authenticated"


async def check_wrong_token(http: aiohttp.ClientSession, base: str, token: str) -> None:
    if not token:
        return
    link, why = await open_control(http, base, token + "wrong")
    if link is None:
        record(PASS, "Control refuses a wrong token", "the token itself was never sent")
    else:
        await link.ws.close()
        record(FAIL, "Control refuses a wrong token", "a wrong token was accepted")


async def check_control(http: aiohttp.ClientSession, base: str, token: str, drive: bool) -> None:
    try:
        link, why = await open_control(http, base, token)
    except aiohttp.WSServerHandshakeError as error:
        record(FAIL, "Control link", f"HTTP {error.status}")
        return
    except Exception as error:  # noqa: BLE001
        record(FAIL, "Control link", f"{type(error).__name__}: {error}")
        return
    if link is None:
        record(FAIL, "Control link", why)
        return
    record(PASS, "Control link", "challenge answered, rover proved itself" if link.session else "open mode, no token")

    try:
        telemetry = await link.await_type("telemetry", 8)
        if telemetry is None:
            record(FAIL, "Telemetry", "no telemetry packet arrived")
            return
        record(PASS, "Telemetry", f"inference {telemetry.get('inferenceMs')} ms, hfov {telemetry.get('cameraHfovDeg')} deg")
        if not telemetry.get("cameraHfovDeg"):
            record(WARN, "Camera field of view", "CAMERA_HFOV is 0; the 3D view cannot place detections")
        if telemetry.get("rangeSensorActive"):
            record(PASS, "Range sensor", f"max {telemetry.get('rangeMaxM')} m")
        elif telemetry.get("rangeSensorError"):
            record(WARN, "Range sensor", telemetry["rangeSensorError"])

        # The app pushes its sensitivity the moment it connects, so this round
        # trip is on the critical path for detections appearing at all.
        await link.send({"type": "settings", "settings": {"detectionSensitivity": 61}})
        echo = await link.await_type("settings", 6, lambda packet: packet.get("settings", {}).get("detectionSensitivity") == 61)
        record(PASS if echo else FAIL, "Settings round-trip", "sensitivity accepted and echoed" if echo else f"got {echo}")

        if link.session:
            await check_attacks(link)
            await check_ticket(http, base, link)

        if "flashAvailable" not in telemetry or "sirenAvailable" not in telemetry:
            record(FAIL, "Device fields", "telemetry has no flashAvailable/sirenAvailable")
        elif telemetry["flashAvailable"]:
            await link.send({"type": "device", "device": "flash", "enabled": True})
            on = await link.await_type("telemetry", 4, lambda packet: packet.get("flashOn") is True)
            await link.send({"type": "device", "device": "flash", "enabled": False})
            off = await link.await_type("telemetry", 4, lambda packet: packet.get("flashOn") is False)
            record(PASS if on and off else FAIL, "Flashlight", "switched on and off, state reported back" if on and off else "the rover did not report the new state")
        else:
            record(WARN, "Flashlight", "not wired; set FLASH_PIN to enable the button in the app")

        if not drive:
            record(WARN, "Drive command", "skipped; pass --drive to test motion")
            return
        await check_drive(http, base, token, link)
    finally:
        await link.ws.close()


async def check_attacks(link: ControlLink) -> None:
    """What someone else on the Wi-Fi could try against a live session."""
    session = link.session
    assert session is not None
    # A replayed packet: capture a signed settings message, let a newer one land,
    # then send the old one again. If it were accepted, sensitivity would go back.
    stale = session.seal({"type": "settings", "settings": {"detectionSensitivity": 33}})
    await link.ws.send_json(stale)
    await link.await_type("settings", 4, lambda p: p.get("settings", {}).get("detectionSensitivity") == 33)
    await link.send({"type": "settings", "settings": {"detectionSensitivity": 61}})
    await link.await_type("settings", 4, lambda p: p.get("settings", {}).get("detectionSensitivity") == 61)
    await link.ws.send_json(stale)
    replayed = await link.await_type("settings", 2, lambda p: p.get("settings", {}).get("detectionSensitivity") == 33)
    record(FAIL if replayed else PASS, "Replayed command", "accepted" if replayed else "ignored")

    # A forged packet: right shape, next sequence number, signature not made with the key.
    forged = session.seal({"type": "settings", "settings": {"detectionSensitivity": 12}})
    forged["mac"] = "0" * 64
    await link.ws.send_json(forged)
    accepted = await link.await_type("settings", 2, lambda p: p.get("settings", {}).get("detectionSensitivity") == 12)
    record(FAIL if accepted else PASS, "Forged command", "accepted" if accepted else "ignored")

    # An unsigned command, as a naive attacker would send.
    await link.ws.send_json({"type": "settings", "settings": {"detectionSensitivity": 13}})
    accepted = await link.await_type("settings", 2, lambda p: p.get("settings", {}).get("detectionSensitivity") == 13)
    record(FAIL if accepted else PASS, "Unsigned command", "accepted" if accepted else "ignored")

    # The session survives all of that: the real app is never cut off by junk.
    await link.send({"type": "settings", "settings": {"detectionSensitivity": 61}})
    alive = await link.await_type("settings", 4, lambda p: p.get("settings", {}).get("detectionSensitivity") == 61)
    record(PASS if alive else FAIL, "Session survives attacks", "still answering" if alive else "the link died")


async def check_ticket(http: aiohttp.ClientSession, base: str, link: ControlLink) -> None:
    """The app opens video with a one-time ticket, never the token."""
    await link.send({"type": "ticket", "purpose": "stream"})
    reply = await link.await_type("ticket", 4)
    if not reply:
        record(FAIL, "Stream ticket", "no ticket issued")
        return
    url = f"{base}/stream.mjpg?ticket={reply['ticket']}"
    status, frames, elapsed, _ = await measure_stream(http, url, seconds=1.0)
    again, _, _, _ = await measure_stream(http, url, seconds=0.2)
    if status == 200 and frames > 0 and again == 401:
        record(PASS, "Stream ticket", f"opened the stream ({frames} frames), and was refused a second time")
    else:
        record(FAIL, "Stream ticket", f"first use HTTP {status} with {frames} frames, reuse HTTP {again}")


async def check_drive(http: aiohttp.ClientSession, base: str, token: str, link: ControlLink) -> None:
    status_headers = {"Authorization": f"Bearer {token}"} if token else {}

    async def powers() -> tuple[float, float]:
        async with http.get(f"{base}/status", headers=status_headers) as response:
            status = await response.json()
        return status.get("leftPower", 0), status.get("rightPower", 0)

    # Differential drive: left = throttle + steering, right = throttle - steering,
    # each scaled by the duty ceiling. A left turn leaves the right side faster.
    await link.send({"type": "drive", "throttle": 1.0, "steering": -0.4, "sprint": False})
    await asyncio.sleep(0.1)
    left, right = await powers()
    if right > left > 0:
        record(PASS, "Drive command", f"left {left}, right {right} -- right leads in a left turn")
    elif left or right:
        record(WARN, "Drive command", f"left {left}, right {right} -- moving, but not the expected split")
    else:
        record(FAIL, "Drive command", "the rover reported no wheel power")

    # A second device must not take the controls from the one driving.
    if token:
        other, _ = await open_control(http, base, token)
        if other:
            # Keep the first device driving, as a held stick would, so the
            # watchdog does not end its turn while the second one connects.
            await link.send({"type": "drive", "throttle": 1.0, "steering": -0.4, "sprint": False})
            await other.send({"type": "drive", "throttle": -1.0, "steering": 0, "sprint": False})
            denied = await other.await_type("control", 3, lambda p: p.get("driving") is False)
            await link.send({"type": "drive", "throttle": 1.0, "steering": -0.4, "sprint": False})
            await asyncio.sleep(0.05)
            left, right = await powers()
            if denied and left > 0:
                record(PASS, "Driver lock", "a second device was refused while the first drove")
            else:
                record(FAIL, "Driver lock", f"second device denied={bool(denied)}, wheels now {left}/{right}")
            # BRAKE is never locked out: any device can stop the car.
            await other.send({"type": "brake"})
            await asyncio.sleep(0.1)
            left, right = await powers()
            record(PASS if left == 0 and right == 0 else FAIL, "Brake from any device",
                   "the second device stopped the car" if left == 0 and right == 0 else f"still at {left}/{right}")
            await other.ws.close()

    # Nothing more is sent, so the watchdog has to cut power on its own. This is
    # the check that matters most: it stops a rover whose operator walked out of
    # Wi-Fi range.
    await link.send({"type": "drive", "throttle": 0.5, "steering": 0, "sprint": False})
    await asyncio.sleep(1.2)
    left, right = await powers()
    if left == 0 and right == 0:
        record(PASS, "Watchdog stop", "power cut after the commands stopped")
    else:
        record(FAIL, "Watchdog stop", f"still at {left}/{right}")
    await link.send({"type": "brake"})


async def run(host: str, port: int, token: str, drive: bool) -> int:
    base = f"http://{host}:{port}"
    print("\nChecking the security primitives\n")
    self_test()
    print(f"\nChecking the rover at {base}\n")
    async with aiohttp.ClientSession() as http:
        status = await check_status(http, base, token)
        if status is None:
            print("\nFAILED: the rover did not answer at all.")
            return 1
        if status.get("authRequired") and not token:
            record(FAIL, "Token", "this rover needs a token; pass --token")
        else:
            if status.get("authRequired"):
                await check_auth(http, base, token)
                await check_wrong_token(http, base, token)
            await check_frame(http, base, token)
            await check_stream(http, base, token)
            await check_control(http, base, token, drive)

    failed = [name for state, name, _ in results if state == FAIL]
    warned = [name for state, name, _ in results if state == WARN]
    print(f"\n{len(results) - len(failed) - len(warned)} passed, {len(warned)} warnings, {len(failed)} failed")
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    print("\nThe rover is ready for the app. In Settings, enter:")
    print(f"  Pi address     {host}" + (f":{port}" if port != 8000 else ""))
    print("  Access token   the ROVER_TOKEN from rover.env")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1", help="rover address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--token", default="", help="the ROVER_TOKEN the rover was started with")
    parser.add_argument("--drive", action="store_true", help="also send drive commands; put the robot on blocks")
    args = parser.parse_args()
    return asyncio.run(run(args.host, args.port, args.token, args.drive))


if __name__ == "__main__":
    raise SystemExit(main())
