import { Matrix4, Quaternion, Vector3 } from 'three';
import type { AssemblyStep, AxisReference, ConstructionAxis, MotionMembers, Part, Pose, RigidMotion, Vec3 } from './types.ts';

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
export const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
export const isPose = (value: unknown): value is Pose => isRecord(value) && isVec3(value.position)
  && Array.isArray(value.quaternion) && value.quaternion.length === 4 && value.quaternion.every(isFiniteNumber)
  && Math.abs(Math.hypot(...value.quaternion) - 1) < 1e-5;
export function isDirection(value: unknown): value is Vec3 {
  if (!isVec3(value)) return false;
  const length = Math.hypot(...value);
  return Number.isFinite(length) && length > 1e-12;
}
export function isAxisReference(value: unknown): value is AxisReference {
  if (!isRecord(value)) return false;
  if ('axisId' in value) return typeof value.axisId === 'string' && !('origin' in value || 'direction' in value || 'partId' in value);
  return isVec3(value.origin) && isDirection(value.direction) && (value.partId === undefined || typeof value.partId === 'string');
}
export function isMotionMembers(value: unknown): value is MotionMembers {
  return isRecord(value) && (value.partIds === undefined || isIdList(value.partIds))
    && (value.groupIds === undefined || isIdList(value.groupIds))
    && ((isIdList(value.partIds) && !!value.partIds.length) || (isIdList(value.groupIds) && !!value.groupIds.length));
}
export function isRigidMotion(value: unknown): value is RigidMotion {
  if (!isRecord(value) || !isMotionMembers(value)) return false;
  const { axis, distance, angleDegrees, translation } = value;
  return (axis === undefined || isAxisReference(axis))
    && (distance === undefined || isFiniteNumber(distance) && axis !== undefined)
    && (angleDegrees === undefined || isFiniteNumber(angleDegrees) && axis !== undefined)
    && (translation === undefined || isVec3(translation))
    && (distance !== undefined || angleDegrees !== undefined || translation !== undefined);
}

export type PartTransform = (id: string) => { part: Part; matrix: Matrix4 } | undefined;
export function poseMatrix(pose: Pose): Matrix4 {
  return new Matrix4().compose(new Vector3(...pose.position), new Quaternion(...pose.quaternion), new Vector3(1, 1, 1));
}
export function axisComponentMatrix(axis: ConstructionAxis, lookup: PartTransform): Matrix4 {
  let common: Matrix4 | undefined;
  for (const id of axis.partIds) {
    const input = lookup(id);
    if (!input) continue;
    const transform = input.matrix.clone().multiply(poseMatrix(input.part.home).invert());
    if (common && common.elements.some((value, index) => Math.abs(value - transform.elements[index]) > 1e-6)) return new Matrix4();
    common = transform;
  }
  return common ?? new Matrix4();
}
export function resolveAxis(reference: AxisReference, axes: ConstructionAxis[], lookup: PartTransform): { origin: Vector3; direction: Vector3 } {
  if ('axisId' in reference) {
    const axis = axes.find(axis => axis.id === reference.axisId);
    if (!axis) throw new Error(`Unknown construction axis: ${reference.axisId}.`);
    const matrix = axisComponentMatrix(axis, lookup);
    return {
      origin: new Vector3(...axis.origin).applyMatrix4(matrix),
      direction: new Vector3(...axis.direction).transformDirection(matrix),
    };
  }
  const origin = new Vector3(...reference.origin), direction = new Vector3(...reference.direction).normalize();
  if (reference.partId !== undefined) {
    const input = lookup(reference.partId);
    if (!input) throw new Error(`Unknown axis reference part: ${reference.partId}.`);
    origin.applyMatrix4(input.matrix);
    direction.transformDirection(input.matrix);
  }
  return { origin, direction };
}

export function motionPartIds(members: MotionMembers, parts: ReadonlyMap<string, Part>, step?: AssemblyStep): string[] {
  const ids = new Set(members.partIds);
  for (const groupId of members.groupIds ?? []) {
    const group = step?.groups.find(group => group.id === groupId);
    if (!group) throw new Error(`Unknown group in the selected step: ${groupId}.`);
    for (const id of group.partIds) ids.add(id);
  }
  if (!ids.size) throw new Error('Select at least one part to move.');
  for (const id of ids) if (parts.get(id)?.sourceStatus !== 'active') throw new Error(`Unknown active part: ${id}.`);
  return [...ids];
}

export function transformPoses(motions: RigidMotion[], poses: Readonly<Record<string, Pose>>, parts: ReadonlyMap<string, Part>, axes: ConstructionAxis[], step: AssemblyStep): Record<string, Pose> {
  const result = { ...poses };
  for (const motion of motions) {
    const ids = motionPartIds(motion, parts, step);
    const lookup: PartTransform = id => {
      const part = parts.get(id);
      return part ? { part, matrix: poseMatrix(result[id] ?? part.assemblyHome ?? part.home) } : undefined;
    };
    const axis = motion.axis && resolveAxis(motion.axis, axes, lookup);
    const rotation = new Quaternion();
    const offset = new Vector3(...motion.translation ?? [0, 0, 0]);
    if (axis) {
      rotation.setFromAxisAngle(axis.direction, (motion.angleDegrees ?? 0) * Math.PI / 180);
      offset.add(axis.origin.clone().sub(axis.origin.clone().applyQuaternion(rotation)));
      offset.addScaledVector(axis.direction, motion.distance ?? 0);
    }
    for (const id of ids) {
      const pose = Object.hasOwn(result, id) && result[id];
      if (!pose || !step.partIds.includes(id)) throw new Error(`Add ${id} to the step before transforming it.`);
      result[id] = {
        position: new Vector3(...pose.position).applyQuaternion(rotation).add(offset).toArray(),
        quaternion: rotation.clone().multiply(new Quaternion(...pose.quaternion)).normalize().toArray(),
      };
    }
  }
  return result;
}
