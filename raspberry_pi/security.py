"""Authentication and message integrity for the rover's control link.

The rover is reached over plain HTTP and WebSocket on the local Wi-Fi; there is no
TLS, because the app cannot trust a self-signed certificate without a native rebuild.
So the protocol is built to survive someone else on the same network who can read
every packet:

- The shared token never crosses the network. The app proves it holds the token by
  signing a random challenge from the rover (HMAC-SHA256), and the rover proves the
  same back, so a machine pretending to be the rover is caught too.
- Both sides then derive a session key from the token and both challenges. Every
  control message carries a sequence number and an HMAC under that key, so a packet
  injected into the connection, or replayed from an earlier one, is rejected.
- The video is opened with a one-time ticket issued over the authenticated socket,
  not with the token, so a captured video URL is already spent.

What this does not do: it does not encrypt. Anyone on the network can still see the
video and read telemetry. It cannot stop someone jamming the Wi-Fi, either; the
watchdog makes sure that a lost link can only ever stop the motors.

Nothing here touches the network, the camera or the motors, so it is tested by
running it on known values (see verify_rover.py and the app's domain/crypto.ts).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

PROTOCOL = 1
AUTH_LABEL = "agni-auth"
SESSION_LABEL = "agni-session"
SERVER_PROOF_LABEL = "agni-server"
CLIENT_TO_ROVER = "c2r"
ROVER_TO_CLIENT = "r2c"


def hmac_hex(key: bytes, message: str) -> str:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).hexdigest()


def new_nonce() -> str:
    """128 random bits, hex. Unpredictable, so a signed answer cannot be precomputed."""
    return secrets.token_hex(16)


def is_hex_nonce(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 32 and all(c in "0123456789abcdef" for c in value)


def auth_proof(token: str, rover_nonce: str, client_nonce: str) -> str:
    """What the app sends to prove it holds the token."""
    return hmac_hex(token.encode("utf-8"), f"{AUTH_LABEL}|{rover_nonce}|{client_nonce}")


def session_key(token: str, rover_nonce: str, client_nonce: str) -> bytes:
    """Per-connection key. Both nonces feed it, so neither side can force a reused key."""
    return bytes.fromhex(hmac_hex(token.encode("utf-8"), f"{SESSION_LABEL}|{rover_nonce}|{client_nonce}"))


def server_proof(key: bytes) -> str:
    """What the rover sends back, proving it holds the token as well."""
    return hmac_hex(key, SERVER_PROOF_LABEL)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not a number")


def strict_loads(text: str) -> Any:
    """json.loads without NaN or Infinity.

    Python's JSON reader accepts NaN by default, and the drive clamp turned a NaN
    throttle into full speed. Refusing them here closes that for every message.
    """
    return json.loads(text, parse_constant=_reject_constant)


def finite(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("not a finite number")
    return number


@dataclass
class Session:
    """One authenticated connection: the key and the sequence numbers both ways.

    The rover seals with ROVER_TO_CLIENT and opens CLIENT_TO_ROVER; a client, such as
    verify_rover.py, swaps them. The direction is part of what is signed, so a message
    cannot be reflected back at the side that sent it.
    """

    key: bytes
    outgoing: str = ROVER_TO_CLIENT
    incoming: str = CLIENT_TO_ROVER
    sent: int = 0
    received: int = 0

    @classmethod
    def for_client(cls, key: bytes) -> "Session":
        return cls(key, outgoing=CLIENT_TO_ROVER, incoming=ROVER_TO_CLIENT)

    def seal(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Wrap a message for the other side: signed, numbered, body as an exact string.

        The body travels as a JSON string rather than an object so both sides sign
        the same bytes; Python and JavaScript do not serialise objects identically.
        """
        self.sent += 1
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False)
        return {"seq": self.sent, "body": body, "mac": hmac_hex(self.key, f"{self.outgoing}|{self.sent}|{body}")}

    def open(self, envelope: Any) -> dict[str, Any]:
        """Check and unwrap a message from the other side. Raises ValueError if forged or replayed."""
        if not isinstance(envelope, dict):
            raise ValueError("not an envelope")
        seq, body, mac = envelope.get("seq"), envelope.get("body"), envelope.get("mac")
        if not isinstance(seq, int) or isinstance(seq, bool) or not isinstance(body, str) or not isinstance(mac, str):
            raise ValueError("malformed envelope")
        expected = hmac_hex(self.key, f"{self.incoming}|{seq}|{body}")
        if not hmac.compare_digest(mac, expected):
            raise ValueError("bad signature")
        # Strictly increasing: a replayed or reordered packet is refused.
        if seq <= self.received:
            raise ValueError("replayed message")
        self.received = seq
        payload = strict_loads(body)
        if not isinstance(payload, dict):
            raise ValueError("body is not an object")
        return payload


@dataclass
class TicketBook:
    """Short-lived tickets that open the video, issued only over an authenticated socket."""

    ttl: float = 30.0
    _tickets: dict[str, tuple[str, float, bool]] = field(default_factory=dict)

    def issue(self, purpose: str, reusable: bool = False) -> str:
        self._expire()
        ticket = secrets.token_urlsafe(18)
        self._tickets[ticket] = (purpose, time.monotonic() + self.ttl, reusable)
        return ticket

    def redeem(self, ticket: str, purpose: str) -> bool:
        """True once for a one-time ticket; until expiry for a reusable one."""
        self._expire()
        entry = self._tickets.get(ticket)
        if entry is None or entry[0] != purpose:
            return False
        if not entry[2]:
            del self._tickets[ticket]
        return True

    def _expire(self) -> None:
        now = time.monotonic()
        for ticket in [t for t, (_, expires, _) in self._tickets.items() if expires < now]:
            del self._tickets[ticket]


@dataclass
class FailureLimiter:
    """Locks out an address after repeated failed authentication.

    A 128-bit token cannot be guessed, but unlimited attempts still let anyone on the
    network keep the rover busy answering them.
    """

    limit: int = 10
    window: float = 60.0
    lockout: float = 60.0
    _failures: dict[str, list[float]] = field(default_factory=dict)
    _locked_until: dict[str, float] = field(default_factory=dict)

    def blocked(self, address: str) -> bool:
        until = self._locked_until.get(address, 0.0)
        if until and time.monotonic() < until:
            return True
        self._locked_until.pop(address, None)
        return False

    def fail(self, address: str) -> None:
        now = time.monotonic()
        recent = [t for t in self._failures.get(address, []) if now - t < self.window]
        recent.append(now)
        self._failures[address] = recent
        if len(recent) >= self.limit:
            self._locked_until[address] = now + self.lockout
            self._failures.pop(address, None)

    def succeed(self, address: str) -> None:
        self._failures.pop(address, None)
