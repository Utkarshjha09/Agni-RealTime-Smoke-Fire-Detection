/** A small perspective 3D camera.
 *
 * The map used to be a 2D plane with a CSS-style rotation applied to it, which
 * looks 3D but is not: nothing had a depth, so nothing could be placed correctly
 * in space. This projects real world coordinates through an orbiting perspective
 * camera, so markers sit at true positions and the view can be flown around.
 *
 * World axes: +X right, +Y up, +Z forward (away from the rover).
 */

export type Vec3 = { x: number; y: number; z: number };

export type OrbitCamera = {
  /** Point the camera orbits around, in world metres. */
  target: Vec3;
  /** Horizontal orbit angle in radians. 0 looks along +Z from behind the rover. */
  yaw: number;
  /** Vertical orbit angle in radians. Positive looks down at the ground. */
  pitch: number;
  /** Distance from the target, in metres. */
  distance: number;
  /** Vertical field of view in degrees. */
  fovDeg: number;
};

export type Viewport = { width: number; height: number };

export type Projected = {
  x: number;
  y: number;
  /** Distance from the camera along its view direction, for depth sorting. */
  depth: number;
  /** False when the point is behind the camera and must not be drawn. */
  visible: boolean;
  /** Perspective scale factor, for sizing markers by distance. */
  scale: number;
};

export const MIN_PITCH = 0.12;
export const MAX_PITCH = 1.45;
export const MIN_DISTANCE = 4;
export const MAX_DISTANCE = 48;

export function defaultCamera(): OrbitCamera {
  return {
    target: { x: 0, y: 0, z: 6 },
    yaw: 0,
    pitch: 0.72,
    distance: 16,
    fovDeg: 55,
  };
}

export function clampCamera(camera: OrbitCamera): OrbitCamera {
  return {
    ...camera,
    pitch: Math.max(MIN_PITCH, Math.min(MAX_PITCH, camera.pitch)),
    distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, camera.distance)),
  };
}

/** Camera position derived from its orbit around the target. */
export function cameraPosition(camera: OrbitCamera): Vec3 {
  const horizontal = Math.cos(camera.pitch) * camera.distance;
  return {
    x: camera.target.x + Math.sin(camera.yaw) * horizontal,
    y: camera.target.y + Math.sin(camera.pitch) * camera.distance,
    z: camera.target.z - Math.cos(camera.yaw) * horizontal,
  };
}

type Basis = { right: Vec3; up: Vec3; forward: Vec3; eye: Vec3; focal: number };

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Builds the view basis once per frame, then reuse it for every point. */
export function viewBasis(camera: OrbitCamera, viewport: Viewport): Basis {
  const eye = cameraPosition(camera);
  const forward = normalise({
    x: camera.target.x - eye.x,
    y: camera.target.y - eye.y,
    z: camera.target.z - eye.z,
  });
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  // Order matters: with +X right, +Y up and +Z forward, it is cross(up, forward)
  // that yields screen-right. The reverse mirrors the whole scene left-to-right.
  const right = normalise(cross(worldUp, forward));
  const up = cross(forward, right);
  // Focal length in pixels for the requested vertical field of view.
  const focal = viewport.height / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
  return { right, up, forward, eye, focal };
}

export function project(point: Vec3, basis: Basis, viewport: Viewport): Projected {
  const relative: Vec3 = {
    x: point.x - basis.eye.x,
    y: point.y - basis.eye.y,
    z: point.z - basis.eye.z,
  };
  const depth = dot(relative, basis.forward);
  if (depth <= 0.05) {
    return { x: 0, y: 0, depth, visible: false, scale: 0 };
  }
  const scale = basis.focal / depth;
  return {
    x: viewport.width / 2 + dot(relative, basis.right) * scale,
    y: viewport.height / 2 - dot(relative, basis.up) * scale,
    depth,
    visible: true,
    scale: scale / basis.focal,
  };
}

/** Clips a segment to the near plane so ground lines crossing behind the camera still draw. */
export function projectSegment(
  a: Vec3,
  b: Vec3,
  basis: Basis,
  viewport: Viewport,
): { from: Projected; to: Projected } | null {
  const depthA = dot({ x: a.x - basis.eye.x, y: a.y - basis.eye.y, z: a.z - basis.eye.z }, basis.forward);
  const depthB = dot({ x: b.x - basis.eye.x, y: b.y - basis.eye.y, z: b.z - basis.eye.z }, basis.forward);
  const near = 0.1;
  if (depthA <= near && depthB <= near) return null;

  let start = a;
  let end = b;
  if (depthA < near) {
    const t = (near - depthA) / (depthB - depthA);
    start = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  } else if (depthB < near) {
    const t = (near - depthB) / (depthA - depthB);
    end = { x: b.x + (a.x - b.x) * t, y: b.y + (a.y - b.y) * t, z: b.z + (a.z - b.z) * t };
  }

  const from = project(start, basis, viewport);
  const to = project(end, basis, viewport);
  if (!from.visible || !to.visible) return null;
  return { from, to };
}
