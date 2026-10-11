/** Pure drive maths shared by the controls and the on-screen wheel display. */

export function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** Stick plus accelerator, as one throttle value.
 *
 * The accelerator adds full forward drive, so you can hold a turn on the stick and
 * accelerate through it with the other thumb. Pulling back on the stick while
 * accelerating cancels out rather than reversing.
 */
export function combinedThrottle(stickThrottle: number, accelerating: boolean): number {
  return clampUnit(stickThrottle + (accelerating ? 1 : 0));
}

/** Left and right wheel command, -1..1, before the rover applies its duty ceiling.
 *
 * Mirrors MotorDriver.drive in raspberry_pi/rover_server.py: tank drive, where
 * steering speeds one side up and slows the other. Change one, change both.
 */
export function wheelMix(throttle: number, steering: number): { left: number; right: number } {
  return { left: clampUnit(throttle + steering), right: clampUnit(throttle - steering) };
}
