/** Pure drive maths shared by the controls and the on-screen wheel display. */

export function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** The three pedal states the drive buttons can be in. */
export type Pedals = {
  /** ACCEL is held down. */
  accel: boolean;
  /** BRAKE is held down. */
  brake: boolean;
  /** Cruise is latched: ACCEL was pressed with SPRINT on, and the car keeps going. */
  cruise: boolean;
};

/** Forward, reverse or nothing, from the pedals alone, as -1, 0 or 1.
 *
 * ACCEL and BRAKE held together reverse, the way a driving game reverses: the
 * thumb that would stop the car turns the accelerator round. Cruise drives forward
 * with no button held, as PUBG's auto-run does.
 */
export function pedalThrottle(pedals: Pedals): number {
  if (pedals.accel && pedals.brake) return -1;
  if (pedals.accel || pedals.cruise) return 1;
  return 0;
}

/** Stick plus pedals, as one throttle value.
 *
 * The pedal adds full drive, so you can hold a turn on the stick and accelerate
 * through it with the other thumb. Pulling back on the stick while accelerating
 * cancels out rather than reversing.
 */
export function combinedThrottle(stickThrottle: number, pedal: number): number {
  return clampUnit(stickThrottle + pedal);
}

export type DriveMode = "REVERSE" | "CRUISE" | "SPRINT" | "DRIVE";

/** What the wheel display labels the current command. */
export function driveMode(pedals: Pedals, sprint: boolean): DriveMode {
  if (pedals.accel && pedals.brake) return "REVERSE";
  if (pedals.cruise) return "CRUISE";
  return sprint ? "SPRINT" : "DRIVE";
}

/** Left and right wheel command, -1..1, before the rover applies its duty ceiling.
 *
 * Mirrors MotorDriver.drive in raspberry_pi/rover_server.py: tank drive, where
 * steering speeds one side up and slows the other. Change one, change both.
 */
export function wheelMix(throttle: number, steering: number): { left: number; right: number } {
  return { left: clampUnit(throttle + steering), right: clampUnit(throttle - steering) };
}
