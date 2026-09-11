/** Turning a camera detection into a position in the world.
 *
 * Two very different qualities of number live here, and the UI must not blur them:
 *
 *  - BEARING is real geometry. Given the camera's horizontal field of view, where a
 *    box sits across the frame maps to an angle with no assumptions at all.
 *  - RANGE is an estimate. A single camera cannot measure distance, so we infer it
 *    from apparent size against an assumed real-world fire size. It is a useful
 *    ordering ("that one is further away"), not a measurement. Always label it.
 *
 * The ultrasonic sensor is that depth sensor, for the narrow cone it covers. When a
 * detection falls inside the beam, `placeDetections` swaps the size-based guess for
 * the measured distance and marks the placement `measured`, so the UI can stop
 * calling it an estimate. Read the caveat on `measuredRangeFor` before trusting it.
 */
import type { BoundingBox, Detection, RangeReading } from "./robot";

/** Pi Camera v2. The rover reports its real value in telemetry. */
export const DEFAULT_HFOV_DEG = 62.2;

/** Assumed height of a typical fire/smoke source, in metres, for the range estimate. */
const ASSUMED_SOURCE_HEIGHT_M = 0.6;
const MIN_RANGE_M = 0.8;
const MAX_RANGE_M = 25;

export function boxCentreX(box: BoundingBox): number {
  return (box.left + box.width / 2) / 100;
}

/**
 * Angle from the camera's centre line, in degrees. Negative is left, positive right.
 * Real geometry: a pinhole camera maps frame position to angle exactly.
 */
export function bearingDeg(box: BoundingBox, hfovDeg: number = DEFAULT_HFOV_DEG): number {
  const offsetFromCentre = boxCentreX(box) - 0.5; // -0.5 .. +0.5
  const halfFov = (hfovDeg * Math.PI) / 360;
  // Undo the perspective projection rather than scaling the angle linearly.
  const angle = Math.atan(2 * offsetFromCentre * Math.tan(halfFov));
  return (angle * 180) / Math.PI;
}

/**
 * ESTIMATE ONLY. Apparent height shrinks with distance, so we invert that against
 * an assumed source size. Wrong whenever the fire is bigger or smaller than assumed.
 */
export function estimateRangeM(box: BoundingBox, vfovDeg: number): number {
  const heightFraction = Math.max(0.01, box.height / 100);
  const halfVfov = (vfovDeg * Math.PI) / 360;
  // Frame height in metres at distance d is 2*d*tan(halfVfov); solve for d.
  const range = ASSUMED_SOURCE_HEIGHT_M / (2 * heightFraction * Math.tan(halfVfov));
  return Math.max(MIN_RANGE_M, Math.min(MAX_RANGE_M, range));
}

/** Vertical FOV implied by a horizontal FOV and a frame aspect ratio. */
export function verticalFovDeg(hfovDeg: number, aspect = 16 / 9): number {
  const halfH = (hfovDeg * Math.PI) / 360;
  const halfV = Math.atan(Math.tan(halfH) / aspect);
  return (halfV * 360) / Math.PI;
}

/** How a placement's range was arrived at. The UI must say which. */
export type RangeSource = "measured" | "estimated";

export type DetectionPlacement = {
  detection: Detection;
  /** Metres right of the rover (negative is left). */
  x: number;
  /** Metres in front of the rover. */
  z: number;
  bearingDeg: number;
  rangeM: number;
  /** "measured" only when an ultrasonic ping covered this bearing. */
  rangeSource: RangeSource;
  /** False when the detection had no box, so it cannot be placed. */
  located: boolean;
};

/** A range reading older than this is too stale to place a detection with. */
export const RANGE_FRESH_MS = 2000;

/**
 * The measured distance covering `bearing`, or null if nothing does.
 *
 * IMPORTANT CAVEAT, and the UI must carry it: an ultrasonic sensor returns the
 * distance to the nearest surface in its cone, which is not necessarily the fire.
 * It may be a wall the fire is behind, or an object in front of it. Flame itself
 * reflects ultrasound poorly, so a reading that lines up with a fire is best read
 * as "the nearest thing in that direction is this far away", not "the fire is this
 * far away". It is still far better than inferring distance from apparent size.
 */
export function measuredRangeFor(
  bearing: number,
  readings: RangeReading[],
  now: number = Date.now(),
): RangeReading | null {
  let best: RangeReading | null = null;
  for (const reading of readings) {
    if (reading.distanceM <= 0) continue; // lost echo: no surface, not zero metres
    const age = now - (reading.receivedAt ?? reading.epoch * 1000);
    if (age > RANGE_FRESH_MS) continue;
    if (Math.abs(bearing - reading.bearingDeg) > reading.beamDeg / 2) continue;
    // Prefer the reading whose beam centre is closest to the detection.
    if (!best || Math.abs(bearing - reading.bearingDeg) < Math.abs(bearing - best.bearingDeg)) {
      best = reading;
    }
  }
  return best;
}

/**
 * Places detections in a rover-centric frame: the rover sits at the origin looking
 * down +Z. Positions are where the target was relative to the rover AT DETECTION
 * TIME -- without wheel odometry the app cannot know how far the rover has since
 * moved, so the view is honest about being rover-relative rather than a world map.
 */
export function placeDetections(
  detections: Detection[],
  hfovDeg: number = DEFAULT_HFOV_DEG,
  readings: RangeReading[] = [],
  now: number = Date.now(),
): DetectionPlacement[] {
  const vfov = verticalFovDeg(hfovDeg);
  return detections.map(detection => {
    const box = detection.boundingBox;
    if (!box) {
      return { detection, x: 0, z: 0, bearingDeg: 0, rangeM: 0, rangeSource: "estimated" as const, located: false };
    }
    const bearing = bearingDeg(box, hfovDeg);
    const measured = measuredRangeFor(bearing, readings, now);
    const range = measured ? measured.distanceM : estimateRangeM(box, vfov);
    const radians = (bearing * Math.PI) / 180;
    return {
      detection,
      x: Math.sin(radians) * range,
      z: Math.cos(radians) * range,
      bearingDeg: bearing,
      rangeM: range,
      rangeSource: measured ? ("measured" as const) : ("estimated" as const),
      located: true,
    };
  });
}
