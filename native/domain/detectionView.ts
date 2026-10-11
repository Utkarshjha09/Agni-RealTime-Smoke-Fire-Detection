import type { BoundingBox, Detection } from "./robot";
import { colors } from "../theme";

/** When the detection happened, in local milliseconds. */
export function detectionTime(detection: Detection): number {
  if (detection.epoch) return detection.epoch * 1000;
  return detection.receivedAt ?? Date.now();
}

/** "just now" / "4 min ago" / "2 hr ago" -- recomputed as the screen ticks. */
export function relativeTime(detection: Detection, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - detectionTime(detection)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function detectionColor(kind: Detection["kind"]): string {
  return kind === "fire" ? colors.fire1 : colors.smoke;
}

export function detectionLabel(kind: Detection["kind"]): string {
  return kind === "fire" ? "Fire" : "Smoke";
}

/** A box this long unseen is no longer in front of the camera. */
export const LIVE_BOX_MIN_MS = 3000;

/** How long a box may go unrefreshed and still be drawn over the live feed.
 *
 * The rover republishes a box on every inference pass it is still seen in, so
 * a box that stops arriving has left the frame. A slow Pi takes longer between
 * passes, so the window widens with the measured inference time rather than
 * blinking boxes off between passes.
 */
export function liveBoxWindowMs(inferenceMs: number): number {
  return Math.max(LIVE_BOX_MIN_MS, inferenceMs * 4);
}

export type Size = { width: number; height: number };

/** Where a box sits on screen, in pixels, when the frame is drawn "cover".
 *
 * The feed fills the screen and crops whichever axis overflows, so a box given in
 * percent of the camera frame is not at the same percent of the screen. On a wide
 * phone a 16:9 frame loses its top and bottom, and boxes placed by percent of the
 * screen drifted off the fire they belonged to.
 */
export function boxOnScreen(box: BoundingBox, frame: Size, view: Size): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(view.width / frame.width, view.height / frame.height);
  const shownWidth = frame.width * scale;
  const shownHeight = frame.height * scale;
  const offsetX = (view.width - shownWidth) / 2;
  const offsetY = (view.height - shownHeight) / 2;
  return {
    left: offsetX + (box.left / 100) * shownWidth,
    top: offsetY + (box.top / 100) * shownHeight,
    width: (box.width / 100) * shownWidth,
    height: (box.height / 100) * shownHeight,
  };
}

/** Detections still being seen now, judged by arrival time so clock skew cannot keep one alive. */
export function liveDetections(detections: Detection[], now: number, windowMs: number): Detection[] {
  return detections.filter(detection => detection.boundingBox && now - (detection.receivedAt ?? 0) <= windowMs);
}
