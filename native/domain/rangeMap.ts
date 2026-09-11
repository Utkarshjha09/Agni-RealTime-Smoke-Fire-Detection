/** Turning ultrasonic pings into points on the 3D map.
 *
 * What is honest here, and what is not:
 *
 *  - A ping is a REAL MEASUREMENT of the distance to the nearest surface in the
 *    sensor's cone, at the bearing the sensor was pointing. Both numbers are real.
 *  - Where that point sits relative to the rover is only true AT PING TIME. The
 *    rover has no wheel odometry and no IMU, so once it drives the app cannot know
 *    how far the world has moved under it. Older points are therefore wrong, and
 *    the only defensible thing to do is age them out quickly rather than leave a
 *    smeared trail that looks like a map and is not one.
 *
 * That is why POINT_TTL_MS is short. It is a decay, not a cache: with a single
 * fixed forward sensor you are looking at a live clearance reading, and with a
 * sensor on a servo the same code draws a genuine sweep, because each reading
 * carries its own bearing.
 */
import { VALUE_UNAVAILABLE, type RangeReading } from "./robot";

/** How long a measured point stays on the map before it has aged out. */
export const POINT_TTL_MS = 6000;
/** Points stop being drawn at full strength after this, then fade to nothing. */
const FULL_STRENGTH_MS = 1200;

export type RangePoint = {
  /** Metres right of the rover (negative is left). */
  x: number;
  /** Metres in front of the rover. */
  z: number;
  distanceM: number;
  bearingDeg: number;
  /** 1 when fresh, falling to 0 at POINT_TTL_MS. */
  strength: number;
  /** Milliseconds since the ping arrived. */
  ageMs: number;
  key: string;
};

export function readingAgeMs(reading: RangeReading, now: number): number {
  return now - (reading.receivedAt ?? reading.epoch * 1000);
}

/** Whether a reading found anything. A lost echo is not a zero-metre obstacle. */
export function hasEcho(reading: RangeReading): boolean {
  return reading.distanceM > 0 && reading.distanceM !== VALUE_UNAVAILABLE;
}

/** Rover-relative position of one ping, in metres. */
export function pointFor(reading: RangeReading): { x: number; z: number } {
  const radians = (reading.bearingDeg * Math.PI) / 180;
  return {
    x: Math.sin(radians) * reading.distanceM,
    z: Math.cos(radians) * reading.distanceM,
  };
}

/**
 * Places the readings that still mean something. Lost echoes and aged-out points
 * are dropped rather than drawn faintly: an obstacle that is not there must not
 * appear on a map used to drive a robot into a fire.
 */
export function placeRangeReadings(readings: RangeReading[], now: number = Date.now()): RangePoint[] {
  const points: RangePoint[] = [];
  for (const reading of readings) {
    if (!hasEcho(reading)) continue;
    const ageMs = readingAgeMs(reading, now);
    if (ageMs > POINT_TTL_MS || ageMs < 0) continue;
    const strength = ageMs <= FULL_STRENGTH_MS
      ? 1
      : 1 - (ageMs - FULL_STRENGTH_MS) / (POINT_TTL_MS - FULL_STRENGTH_MS);
    const { x, z } = pointFor(reading);
    points.push({
      x,
      z,
      distanceM: reading.distanceM,
      bearingDeg: reading.bearingDeg,
      strength: Math.max(0, Math.min(1, strength)),
      ageMs,
      key: `${reading.epoch}-${reading.bearingDeg}`,
    });
  }
  return points;
}

/** The most recent reading, echo or not, so the UI can say "no echo" honestly. */
export function latestReading(readings: RangeReading[]): RangeReading | null {
  let best: RangeReading | null = null;
  for (const reading of readings) {
    if (!best || reading.epoch > best.epoch) best = reading;
  }
  return best;
}

/**
 * Ground footprint of the sensor's cone, as a fan of points from the rover out to
 * `reach` metres. Drawn so it is obvious how narrow the sensor's view is next to
 * the camera's, which is the whole reason one fixed sensor cannot map a room.
 */
export function beamFootprint(
  bearingDeg: number,
  beamDeg: number,
  reach: number,
  steps = 8,
): { x: number; z: number }[] {
  const half = beamDeg / 2;
  const fan: { x: number; z: number }[] = [{ x: 0, z: 0 }];
  for (let index = 0; index <= steps; index += 1) {
    const angle = ((bearingDeg - half + (beamDeg * index) / steps) * Math.PI) / 180;
    fan.push({ x: Math.sin(angle) * reach, z: Math.cos(angle) * reach });
  }
  return fan;
}
