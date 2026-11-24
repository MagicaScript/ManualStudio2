import { Quaternion, Vector3 } from 'three';
import type { Pose, Vec3 } from './types.ts';

export interface MotionCurve {
  progress: number;
  fraction: number;
  duration: number;
  beforeDuration?: number;
  afterDuration?: number;
}

function limitedVelocity(incoming: number, outgoing: number): number {
  return Math.sign(incoming) === Math.sign(outgoing) ? Math.sign(incoming) * Math.min(Math.abs(incoming), Math.abs(outgoing)) : 0;
}

/** A shared slope in units per second keeps adjacent segments monotone, even at unequal durations. */
export function curveScalar(curve: MotionCurve, from: number, to: number, before?: number, after?: number): number {
  const { progress: t, fraction, duration, beforeDuration, afterDuration } = curve;
  const delta = to - from;
  if (!delta || t <= 0) return from;
  if (t >= 1) return to;
  const rate = delta / duration;
  const start = before !== undefined && beforeDuration ? limitedVelocity((from - before) / beforeDuration, rate) * duration : 0;
  const end = after !== undefined && afterDuration ? limitedVelocity(rate, (after - to) / afterDuration) * duration : 0;
  return from + delta * fraction + t * (1 - t) * ((1 - t) * start - t * end);
}

export function curveOffset(curve: MotionCurve, from: readonly [number, number], to: readonly [number, number],
  before?: readonly [number, number], after?: readonly [number, number]): [number, number] {
  return [curveScalar(curve, from[0], to[0], before?.[0], after?.[0]), curveScalar(curve, from[1], to[1], before?.[1], after?.[1])];
}

export function curveVector(curve: MotionCurve, from: Vec3, to: Vec3, before?: Vec3, after?: Vec3): Vec3 {
  const at = (axis: 0 | 1 | 2) => curveScalar(curve, from[axis], to[axis], before?.[axis], after?.[axis]);
  return [at(0), at(1), at(2)];
}

function localTurn(origin: Quaternion, target: Quaternion): Vector3 {
  const relative = origin.clone().invert().multiply(target);
  const sine = Math.hypot(relative.x, relative.y, relative.z);
  const scale = sine ? 2 * Math.atan2(sine, Math.abs(relative.w)) / sine * (relative.w < 0 ? -1 : 1) : 0;
  return new Vector3(relative.x, relative.y, relative.z).multiplyScalar(scale);
}

function rotationControl(origin: Quaternion, before: Quaternion, after: Quaternion, beforeDuration: number, afterDuration: number, shift: number): Quaternion {
  const incoming = localTurn(origin, before).multiplyScalar(-1 / beforeDuration);
  const outgoing = localTurn(origin, after).multiplyScalar(1 / afterDuration);
  const tangent = new Vector3(limitedVelocity(incoming.x, outgoing.x), limitedVelocity(incoming.y, outgoing.y), limitedVelocity(incoming.z, outgoing.z)).multiplyScalar(shift);
  const angle = tangent.length();
  return angle ? origin.clone().multiply(new Quaternion().setFromAxisAngle(tangent.divideScalar(angle), angle)) : origin;
}

export function curvePose(curve: MotionCurve, from: Pose, to: Pose, before?: Pose, after?: Pose): Pose {
  const { progress: t, duration, beforeDuration, afterDuration } = curve;
  const position = curveVector(curve, from.position, to.position, before?.position, after?.position);
  if (from.quaternion.every((value, index) => value === to.quaternion[index])) return { position, quaternion: from.quaternion };
  const first = new Quaternion(...from.quaternion).normalize(), last = new Quaternion(...to.quaternion).normalize();
  const startControl = before && beforeDuration ? rotationControl(first, new Quaternion(...before.quaternion).normalize(), last, beforeDuration, duration, duration / 3) : first;
  const endControl = after && afterDuration ? rotationControl(last, first, new Quaternion(...after.quaternion).normalize(), duration, afterDuration, -duration / 3) : last;
  if (startControl === first && endControl === last) return { position, quaternion: first.slerp(last, curve.fraction).toArray() };
  // Spherical Bézier interpolation matches the angular velocities at the controls.
  const a = first.clone().slerp(startControl, t), b = startControl.clone().slerp(endControl, t), c = endControl.clone().slerp(last, t);
  return { position, quaternion: a.slerp(b, t).slerp(b.slerp(c, t), t).normalize().toArray() };
}
