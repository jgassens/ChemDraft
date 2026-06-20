/**
 * Phase 3 — pure trackball rotation math for the 3D spin tool.
 *
 * Sibling to `camera.ts`: pure, dependency-free (no DOM, no React, no document),
 * fully unit-tested. It is the math the Phase 4 in-canvas spin will drive — turning
 * pointer drags on the canvas into an accumulating 3D orientation, then into the
 * exact `ViewMatrix` that `flattenPerspectiveFrom3D` (chem-core `perspective.ts`)
 * consumes.
 *
 * THE CONTRACT THAT MATTERS: `quatToViewMatrix` returns a ROW-MAJOR 4×4 matrix in
 * the same convention as `perspective.ts`'s `applyMatrix` — i.e. applying it to a
 * world point `[x, y, z]` yields `[projX, projY, depthZ]` where `projX/projY` are
 * the on-screen orthographic coordinates and `depthZ` is the viewer-facing depth
 * that drives wedge selection and over/under crossings. So the spin's orientation
 * feeds the flatten with zero glue code. `projectPoint` below mirrors `applyMatrix`
 * exactly and exists so tests can assert that contract here, at the source.
 *
 * Orthographic projection is implicit: we never divide by z; screen = (x, y) of the
 * rotated point, depth = its rotated z. A pure rotation matrix IS the orthographic
 * view matrix in this convention.
 *
 * Trackball model: the classic virtual-sphere ("grab a point on a glass ball and
 * drag it"). Two screen points are lifted onto a sphere/hyperbola and the rotation
 * that carries the first onto the second is returned. Unlike Shoemake's arcball we
 * use the *true* angle between the lifted points (not its double), so the picked
 * point tracks the cursor 1:1 — the more intuitive feel for a chemistry canvas.
 */

import type { ViewMatrix } from "@chemdraft/chem-core";

export type Vec3 = readonly [number, number, number];

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Vector helpers (local, pure)
// ---------------------------------------------------------------------------

function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vlen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function vnorm(a: Vec3): Vec3 {
  const len = vlen(a);
  return len < EPS ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

// ---------------------------------------------------------------------------
// Quaternion algebra
// ---------------------------------------------------------------------------

export function quatIdentity(): Quaternion {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function quatNormalize(q: Quaternion): Quaternion {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < EPS) return quatIdentity();
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** Hamilton product `a ⊗ b` (apply `b` first, then `a`, when acting on vectors). */
export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  };
}

export function quatConjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Unit quaternion for a rotation of `angle` radians about (not-necessarily-unit) `axis`. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quaternion {
  const n = vnorm(axis);
  if (vlen(n) < EPS) return quatIdentity();
  const half = angle / 2;
  const s = Math.sin(half);
  return { x: n[0] * s, y: n[1] * s, z: n[2] * s, w: Math.cos(half) };
}

/** Rotate a vector by a unit quaternion (`q v q*`). */
export function rotateVectorByQuat(q: Quaternion, v: Vec3): Vec3 {
  // t = 2 * (q.xyz × v); v' = v + q.w * t + q.xyz × t  (Rodrigues via quaternion)
  const u: Vec3 = [q.x, q.y, q.z];
  const c1 = vcross(u, v);
  const t: Vec3 = [2 * c1[0], 2 * c1[1], 2 * c1[2]];
  const c2 = vcross(u, t);
  return [v[0] + q.w * t[0] + c2[0], v[1] + q.w * t[1] + c2[1], v[2] + q.w * t[2] + c2[2]];
}

// ---------------------------------------------------------------------------
// Quaternion → ViewMatrix (the chem-core flatten contract)
// ---------------------------------------------------------------------------

/**
 * Row-major 4×4 rotation matrix for a unit quaternion, in the convention
 * `perspective.ts.applyMatrix` consumes: `applyMatrix(M, x, y, z) = [projX, projY,
 * depthZ]`. Pass the result straight to `flattenPerspectiveFrom3D(mol, coords3d, M)`.
 */
export function quatToViewMatrix(q: Quaternion): ViewMatrix {
  const { x, y, z, w } = quatNormalize(q);
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 0,
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 0,
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1
  ];
}

/**
 * Apply a row-major 4×4 to a point — byte-identical to `perspective.ts.applyMatrix`,
 * duplicated here so this module stays dependency-free and so tests can pin the
 * projection contract at its source. Returns `[projX, projY, depthZ]`.
 */
export function projectPoint(m: ViewMatrix, p: Vec3): Vec3 {
  const [x, y, z] = p;
  const rx = m[0] * x + m[1] * y + m[2] * z + m[3];
  const ry = m[4] * x + m[5] * y + m[6] * z + m[7];
  const rz = m[8] * x + m[9] * y + m[10] * z + m[11];
  const rw = m[12] * x + m[13] * y + m[14] * z + m[15];
  const w = Math.abs(rw) < EPS ? 1 : rw;
  return [rx / w, ry / w, rz / w];
}

// ---------------------------------------------------------------------------
// Trackball
// ---------------------------------------------------------------------------

export interface TrackballConfig {
  /** Sphere center in screen coordinates (usually the molecule's screen centroid). */
  center: ScreenPoint;
  /** Sphere radius in screen pixels. Drags within this radius feel "on the ball". */
  radius: number;
}

/**
 * Lift a screen point onto the virtual trackball: inside the radius it sits on the
 * sphere; outside it falls onto a hyperbolic sheet so far-from-center drags still
 * rotate smoothly (Holroyd/Bell trackball). Returned vector is unit length, with
 * +z toward the viewer.
 */
export function projectToTrackball(point: ScreenPoint, config: TrackballConfig): Vec3 {
  const r = config.radius > EPS ? config.radius : 1;
  // Screen y grows downward; flip so the sphere's +y is up, matching world space.
  const px = (point.x - config.center.x) / r;
  const py = -(point.y - config.center.y) / r;
  const d2 = px * px + py * py;
  const rSphere = 1; // working in radius-normalized units
  let z: number;
  if (d2 <= (rSphere * rSphere) / 2) {
    z = Math.sqrt(rSphere * rSphere - d2); // on the sphere
  } else {
    z = (rSphere * rSphere) / (2 * Math.sqrt(d2)); // on the hyperbola
  }
  return vnorm([px, py, z]);
}

/**
 * The rotation that carries the trackball point under `from` onto the point under
 * `to` — the incremental "drag" rotation for one pointer move. Identity for a
 * negligible or degenerate (antipodal) move.
 */
export function trackballRotation(from: ScreenPoint, to: ScreenPoint, config: TrackballConfig): Quaternion {
  const p1 = projectToTrackball(from, config);
  const p2 = projectToTrackball(to, config);
  const axis = vcross(p1, p2);
  if (vlen(axis) < EPS) return quatIdentity(); // no move, or exactly antipodal (degenerate)
  const angle = Math.acos(clamp(vdot(p1, p2), -1, 1));
  return quatFromAxisAngle(axis, angle);
}

/**
 * Accumulate a drag onto an existing orientation. The drag rotation is composed in
 * world/screen space (pre-multiplied), so successive drags compound the way a
 * physical trackball does. Returns a normalized quaternion.
 */
export function applyTrackballDrag(
  current: Quaternion,
  from: ScreenPoint,
  to: ScreenPoint,
  config: TrackballConfig
): Quaternion {
  const drag = trackballRotation(from, to, config);
  return quatNormalize(quatMultiply(drag, current));
}
