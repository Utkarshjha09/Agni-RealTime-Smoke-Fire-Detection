import type { Detection } from "./robot";
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

/** Centre of the detection box in percent, used to place map markers. */
export function detectionCentre(detection: Detection, index: number): { left: string; top: string } {
  const box = detection.boundingBox;
  if (!box) return { left: `${43 + (index % 4) * 12}%`, top: `${56 - (index % 4) * 8}%` };
  return { left: `${box.left + box.width / 2}%`, top: `${box.top + box.height / 2}%` };
}
