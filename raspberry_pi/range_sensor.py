#!/usr/bin/env python3
"""Ultrasonic range finding for the Agni rover (HC-SR04 and compatible).

What this measures, and what it does not:

  - DISTANCE along the beam is a real measurement, accurate to a centimetre or so
    on a flat, square-on surface.
  - BEARING is whichever way the sensor points. A fixed sensor always reports 0,
    meaning straight ahead. That is the honest limit of one fixed sensor: it is a
    rangefinder, not a scanner.

Every reading carries its own bearing so the rest of the stack never assumes the
sensor is fixed. Mount the sensor on a servo, set SERVO_PIN, and the same readings
start arriving at varying bearings -- the app's map turns into a real sweep with
no change on either side of the contract.

Wiring an HC-SR04 (BCM numbering, matching RANGE_TRIG_PIN / RANGE_ECHO_PIN):

    VCC  -> 5V
    TRIG -> RANGE_TRIG_PIN
    ECHO -> voltage divider -> RANGE_ECHO_PIN
    GND  -> GND

ECHO idles at 5V and the Pi's GPIO is 3.3V tolerant only. Put a divider on it
(1k from ECHO to the pin, 2k from the pin to GND) or you will damage the Pi.

Enable with:  RANGE_TRIG_PIN=5 RANGE_ECHO_PIN=6 python3 rover_server.py
"""

from __future__ import annotations

import os
import statistics
import time
from dataclasses import dataclass

try:
    import RPi.GPIO as GPIO
except ImportError:  # Lets the service run and be tested away from a Pi.
    GPIO = None

TRIG_PIN = int(os.getenv("RANGE_TRIG_PIN", "-1"))
ECHO_PIN = int(os.getenv("RANGE_ECHO_PIN", "-1"))
# Where the sensor points, in degrees from the rover's forward axis. Only change
# this if you have physically angled a fixed sensor.
MOUNT_BEARING_DEG = float(os.getenv("RANGE_BEARING", "0"))
# HC-SR04 beam is a cone roughly 15 degrees wide. The app uses this to decide
# whether a camera detection is inside the beam and can take the measured range.
BEAM_DEG = float(os.getenv("RANGE_BEAM_DEG", "15"))
# Datasheet range is 2cm to 4m. Beyond MAX the echo is usually lost, not far away.
MIN_RANGE_M = float(os.getenv("RANGE_MIN_M", "0.02"))
MAX_RANGE_M = float(os.getenv("RANGE_MAX_M", "4.0"))
# Speed of sound varies about 0.6 m/s per degree C; 20 C is the usual default.
AIR_TEMP_C = float(os.getenv("RANGE_AIR_TEMP_C", "20"))
SAMPLES = int(os.getenv("RANGE_SAMPLES", "3"))
SETTLE_S = float(os.getenv("RANGE_SETTLE_S", "0.06"))

VALUE_UNAVAILABLE = -1.0


def speed_of_sound_ms(celsius: float = AIR_TEMP_C) -> float:
    """Metres per second. Ignoring temperature costs ~3% error across a room."""
    return 331.3 + 0.606 * celsius


@dataclass
class RangeReading:
    """One ping. `distanceM` is VALUE_UNAVAILABLE when the echo was lost."""

    distanceM: float
    bearingDeg: float
    epoch: float

    @property
    def valid(self) -> bool:
        return self.distanceM > 0


class RangeSensorUnavailable(RuntimeError):
    """Raised when there is no sensor to read: no GPIO, or no pins configured."""


class RangeSensor:
    def __init__(self, trig: int = TRIG_PIN, echo: int = ECHO_PIN) -> None:
        self.trig = trig
        self.echo = echo
        self.bearing_deg = MOUNT_BEARING_DEG
        self.ready = False
        self.last: RangeReading | None = None
        # A lost echo is normal: soft, angled, or distant surfaces reflect nothing
        # back. Counting them separates "nothing in range" from "sensor is broken".
        self.lost_echoes = 0
        self.readings = 0

    @property
    def configured(self) -> bool:
        return self.trig >= 0 and self.echo >= 0

    def open(self) -> None:
        if self.ready:
            return
        if not self.configured:
            raise RangeSensorUnavailable(
                "RANGE_TRIG_PIN and RANGE_ECHO_PIN are not set, so no ultrasonic sensor is read."
            )
        if GPIO is None:
            raise RangeSensorUnavailable("RPi.GPIO is not available, so no ultrasonic sensor is read.")

        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        GPIO.setup(self.trig, GPIO.OUT)
        GPIO.setup(self.echo, GPIO.IN)
        GPIO.output(self.trig, False)
        # The datasheet asks for a settling period before the first ping.
        time.sleep(SETTLE_S)
        self.ready = True

    def close(self) -> None:
        # Deliberately no GPIO.cleanup() here: the motor driver shares the chip and
        # cleaning up under it would drop the motor pins mid-drive.
        self.ready = False

    # -- one ping ----------------------------------------------------------

    def _timeout_s(self) -> float:
        # Time for sound to travel out and back at the maximum range, plus margin.
        return (2 * MAX_RANGE_M / speed_of_sound_ms()) * 1.5 + 0.005

    def _ping(self) -> float:
        """One echo, in metres, or VALUE_UNAVAILABLE if it never came back.

        This busy-waits on the echo pin for up to ~25ms, so it must never run on
        the asyncio loop: the rover would stutter while driving. Call it through
        an executor, which is what rover_server.py does.
        """
        GPIO.output(self.trig, True)
        time.sleep(0.00001)  # 10us trigger pulse, per the datasheet.
        GPIO.output(self.trig, False)

        timeout = self._timeout_s()

        deadline = time.perf_counter() + timeout
        while GPIO.input(self.echo) == 0:
            if time.perf_counter() > deadline:
                return VALUE_UNAVAILABLE
        started = time.perf_counter()

        deadline = started + timeout
        while GPIO.input(self.echo) == 1:
            if time.perf_counter() > deadline:
                # Echo pin stuck high: treat as lost rather than reporting a
                # distance derived from a truncated pulse.
                return VALUE_UNAVAILABLE
        elapsed = time.perf_counter() - started

        distance = elapsed * speed_of_sound_ms() / 2
        if distance < MIN_RANGE_M or distance > MAX_RANGE_M:
            return VALUE_UNAVAILABLE
        return distance

    def read(self) -> RangeReading:
        """Median of several pings, so one bad echo cannot move an obstacle.

        Blocking. Run it in an executor.
        """
        if not self.ready:
            self.open()

        samples = []
        for index in range(max(1, SAMPLES)):
            if index:
                # HC-SR04 needs a gap or the next ping hears the previous echo.
                time.sleep(0.06)
            value = self._ping()
            if value > 0:
                samples.append(value)

        self.readings += 1
        distance = round(statistics.median(samples), 3) if samples else VALUE_UNAVAILABLE
        if not samples:
            self.lost_echoes += 1

        reading = RangeReading(distanceM=distance, bearingDeg=self.bearing_deg, epoch=time.time())
        self.last = reading
        return reading


if __name__ == "__main__":
    # Bench check: python3 range_sensor.py
    sensor = RangeSensor()
    try:
        sensor.open()
    except RangeSensorUnavailable as error:
        raise SystemExit(f"{error}\nSet the pins, e.g. RANGE_TRIG_PIN=5 RANGE_ECHO_PIN=6 python3 range_sensor.py")

    print(f"reading TRIG={sensor.trig} ECHO={sensor.echo} bearing={sensor.bearing_deg} deg, Ctrl+C to stop")
    try:
        while True:
            reading = sensor.read()
            print(f"{reading.distanceM:.3f} m" if reading.valid else "no echo (nothing in range, or too soft/angled)")
            time.sleep(0.2)
    except KeyboardInterrupt:
        sensor.close()
