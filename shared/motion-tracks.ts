import { Matrix4, Quaternion, Vector3 } from 'three';
import { isAxisReference, isFiniteNumber, isMotionMembers, isRecord, isVec3, motionPartIds, poseMatrix, resolveAxis, rotationDelta, type PartTransform, type RigidDelta, type WorldAxis } from './assembly-motion.ts';
import { compileCenterline, isCenterline } from './centerline.ts';
import { prepareFourBar } from './four-bar.ts';
import { curveScalar } from './motion-curve.ts';
import type { AssemblyStep, AxisReference, Centerline, FourBarArm, Keyframe, MotionMembers, MotionTrack, Pose, Project, Vec3 } from './types.ts';

function isFourBarArm(value: unknown): value is FourBarArm {
  return isRecord(value) && isMotionMembers(value) && isAxisReference(value.axis) && isRecord(value.joint)
    && isVec3(value.joint.point) && (value.joint.partId === undefined || typeof value.joint.partId === 'string');
}

export function isMotionTrack(value: unknown): value is MotionTrack {
  if (!isRecord(value)) return false;
  if (value.kind === 'four-bar') return isFiniteNumber(value.angleDegrees) && isFourBarArm(value.input) && isFourBarArm(value.output)
    && isMotionMembers(value.coupler) && (value.branch === undefined || value.branch === 'positive' || value.branch === 'negative');
  if (!isMotionMembers(value) || !isAxisReference(value.axis)) return false;
  if (value.kind === 'rotate' || value.kind === 'follow-rotation') {
    return isFiniteNumber(value.angleDegrees) && (value.kind === 'rotate' || isVec3(value.point));
  }
  return value.kind === 'path-through-axis' && isCenterline(value.path) && isFiniteNumber(value.startDistance) && isFiniteNumber(value.endDistance)
    && isFiniteNumber(value.halfSpan) && value.halfSpan > 0;
}

type Member = [string, Pose];
interface TrackPlan {
  track: MotionTrack;
  axis: WorldAxis;
  span: number;
  groups: Member[][];
  deltasAt(travel: number): RigidDelta[];
  linkage?: ReturnType<typeof prepareFourBar>;
}

const positionTolerance = 1e-5;
const basis = (direction: Vector3, normal: Vector3) => new Matrix4().makeBasis(direction, normal, direction.clone().cross(normal));

function prepareWireMotion(track: Extract<MotionTrack, { kind: 'path-through-axis' }>, axis: WorldAxis, reference: Pose) {
  const path = compileCenterline(track.path), { startDistance, endDistance, halfSpan } = track;
  if ([startDistance, endDistance].some(distance => distance < 0 || distance > path.length + 1e-8)) {
    throw new Error(`Centerline distances must be between 0 and ${path.length} mm.`);
  }
  const start = Math.min(startDistance, path.length), end = Math.min(endDistance, path.length);
  const referenceRotation = new Quaternion(...reference.quaternion).normalize(), referencePosition = new Vector3(...reference.position);
  const inverse = referenceRotation.clone().invert();
  const startTangent = path.chordAt(start, halfSpan), aligned = new Quaternion()
    .setFromUnitVectors(startTangent.clone().applyQuaternion(referenceRotation), axis.direction).multiply(referenceRotation);
  const holeNormal = path.normal.clone().applyQuaternion(aligned).projectOnPlane(axis.direction).normalize();
  const holeBasis = basis(axis.direction, holeNormal);
  const deltaAt = (travel: number): RigidDelta => {
    const distance = Math.min(path.length, Math.max(0, start + travel));
    const tangent = path.chordAt(distance, halfSpan), normal = path.normal.clone().projectOnPlane(tangent).normalize();
    // The fixed transverse direction preserves the bend plane's roll as each chord enters the hole.
    const nextRotation = new Quaternion().setFromRotationMatrix(holeBasis.clone().multiply(basis(tangent, normal).transpose())).normalize();
    const nextPosition = axis.origin.clone().sub(path.pointAt(distance).applyQuaternion(nextRotation));
    const rotation = nextRotation.multiply(inverse);
    return { rotation, translation: nextPosition.sub(referencePosition.clone().applyQuaternion(rotation)) };
  };
  return { span: end - start, deltaAt };
}

function tracksFor(project: Project, step: AssemblyStep, from: Keyframe, motions: MotionTrack[]): TrackPlan[] {
  const parts = new Map(project.model.parts.map(part => [part.id, part])), assigned = new Set<string>();
  const lookup: PartTransform = id => {
    const part = parts.get(id);
    return part && { part, matrix: poseMatrix(from.poses[id] ?? part.assemblyHome ?? part.home) };
  };
  const axisFor = (reference: AxisReference) => resolveAxis(reference, project.model.constructionAxes ?? [], lookup, true);
  const jointFor = ({ point, partId }: FourBarArm['joint']): Vector3 => {
    const position = new Vector3(...point);
    if (partId === undefined) return position;
    const reference = lookup(partId);
    if (!reference) throw new Error(`Unknown four-bar joint reference part: ${partId}.`);
    return position.applyMatrix4(reference.matrix);
  };
  const membersFor = (selection: MotionMembers): Member[] => motionPartIds(selection, parts, step, true).map(id => {
    const pose = Object.hasOwn(from.poses, id) && from.poses[id];
    if (!pose || !step.partIds.includes(id)) throw new Error(`Add ${id} to the step before assigning it a motion.`);
    if (assigned.has(id)) throw new Error(`Part ${id} has overlapping motion tracks or roles in this transition.`);
    assigned.add(id);
    return [id, pose];
  });
  return motions.map(track => {
    if (track.kind === 'four-bar') {
      const { input, output, coupler, branch, angleDegrees } = track;
      const groups = [membersFor(input), membersFor(output), membersFor(coupler)], axis = axisFor(output.axis), span = angleDegrees * (Math.PI / 180);
      const linkage = prepareFourBar(axisFor(input.axis), axis, jointFor(input.joint), jointFor(output.joint), span, branch);
      return { track, axis, span, groups, linkage, deltasAt: linkage.deltasAt };
    }
    const members = membersFor(track), groups = [members], axis = axisFor(track.axis);
    if (track.kind === 'path-through-axis') {
      const reference = members.find(([id]) => id === track.path.partId)?.[1];
      if (!reference) throw new Error('Select the centerline reference part as a moving member of the track.');
      const { span, deltaAt } = prepareWireMotion(track, axis, reference);
      return { track, axis, span, groups, deltasAt: travel => [deltaAt(travel)] };
    }
    const radial = track.kind === 'follow-rotation' ? new Vector3(...track.point).sub(axis.origin) : undefined;
    const deltasAt = (travel: number): RigidDelta[] => {
      if (!radial) return [rotationDelta(axis, travel)];
      const rotation = new Quaternion().setFromAxisAngle(axis.direction, travel);
      return [{ rotation: new Quaternion(), translation: radial.clone().applyQuaternion(rotation).sub(radial) }];
    };
    return { track, axis, groups, span: track.angleDegrees * (Math.PI / 180), deltasAt };
  });
}

function trackPoses(plan: TrackPlan, travel: number): [string, Pose][] {
  const deltas = plan.deltasAt(travel);
  return plan.groups.flatMap((group, index) => {
    const { rotation, translation } = deltas[index];
    return group.map(([id, pose]): [string, Pose] => [id, {
      position: new Vector3(...pose.position).applyQuaternion(rotation).add(translation).toArray(),
      quaternion: rotation.clone().multiply(new Quaternion(...pose.quaternion)).normalize().toArray(),
    }]);
  });
}

function samePose(a: Pose, b?: Pose): boolean {
  return !!b && new Vector3(...a.position).distanceTo(new Vector3(...b.position)) <= positionTolerance
    && Math.abs(new Quaternion(...a.quaternion).dot(new Quaternion(...b.quaternion).normalize())) >= 1 - 1e-12;
}

export function solveMotionEndpoints(project: Project, step: AssemblyStep, from: Keyframe, motions: MotionTrack[], alignStart: boolean) {
  let plans = tracksFor(project, step, from, motions);
  const startChanges = plans.flatMap(plan => trackPoses(plan, 0)).filter(([id, pose]) => !samePose(pose, from.poses[id]));
  if (startChanges.length) {
    if (!alignStart) throw new Error('The start pose does not meet the hole constraint. Use alignStart to align the preceding keyframe.');
    const aligned = { ...from, poses: { ...from.poses, ...Object.fromEntries(startChanges) } };
    plans = tracksFor(project, step, aligned, motions);
    if (plans.some(plan => trackPoses(plan, 0).some(([id, pose]) => !samePose(pose, aligned.poses[id])))) {
      throw new Error('The hole axis must remain fixed when aligning the wire start.');
    }
  }
  return { startChanges, endChanges: plans.flatMap(plan => trackPoses(plan, plan.span)) };
}

export function validateIncomingMotion(project: Project, step: AssemblyStep, from: Keyframe | undefined, to: Keyframe): void {
  if (!from || to.kind === 'start') throw new Error('The start keyframe has no incoming motion.');
  if (!Array.isArray(to.incomingMotion) || !to.incomingMotion.length || !to.incomingMotion.every(isMotionTrack)) throw new Error('Invalid motion tracks.');
  for (const plan of tracksFor(project, step, from, to.incomingMotion)) {
    if (trackPoses(plan, 0).some(([id, pose]) => !samePose(pose, from.poses[id]))
      || trackPoses(plan, plan.span).some(([id, pose]) => !samePose(pose, to.poses[id]))) {
      throw new Error('The stored poses no longer match this motion. Reapply the motion to update its endpoints, or clear it to edit them directly.');
    }
  }
}

const sameVector = (a: Vec3, b: Vec3): boolean => a.every((value, index) => value === b[index]);
function sameCenterline(a: Centerline, b: Centerline): boolean {
  return a.partId === b.partId && sameVector(a.start, b.start) && a.segments.length === b.segments.length && a.segments.every((segment, index) => {
    const other = b.segments[index];
    if (segment.kind === 'line' && other.kind === 'line') return sameVector(segment.to, other.to);
    return segment.kind === 'arc' && other.kind === 'arc' && sameVector(segment.center, other.center)
      && sameVector(segment.normal, other.normal) && segment.angleDegrees === other.angleDegrees;
  });
}

function connects(first: TrackPlan, next: TrackPlan): boolean {
  const a = first.track, b = next.track;
  const sameMembers = (group: Member[], other: Member[]): boolean => group.length === other.length && group.every(([id]) => other.some(([match]) => match === id));
  if (a.kind !== b.kind || first.groups.length !== next.groups.length || !first.groups.every((group, index) => sameMembers(group, next.groups[index]))
    || first.axis.direction.dot(next.axis.direction) < 1 - 1e-10) return false;
  const originOffset = first.axis.origin.clone().sub(next.axis.origin);
  if (a.kind === 'path-through-axis' && b.kind === 'path-through-axis') {
    return originOffset.length() <= positionTolerance && Math.abs(a.endDistance - b.startDistance) <= 1e-8
      && a.halfSpan === b.halfSpan && sameCenterline(a.path, b.path);
  }
  if (originOffset.cross(first.axis.direction).length() > positionTolerance) return false;
  if (first.linkage && next.linkage) {
    const end = first.linkage.jointsAt(first.span);
    return first.linkage.branch === next.linkage.branch && first.linkage.inputPivot.distanceTo(next.linkage.inputPivot) <= positionTolerance
      && end.input.distanceTo(next.linkage.inputJoint) <= positionTolerance && end.output.distanceTo(next.linkage.outputJoint) <= positionTolerance;
  }
  if (a.kind === 'follow-rotation' && b.kind === 'follow-rotation') {
    return new Vector3(...a.point).add(first.deltasAt(first.span)[0].translation).distanceTo(new Vector3(...b.point)) <= positionTolerance;
  }
  return true;
}

export function incomingMotionSampler(project: Project, step: AssemblyStep, from: Keyframe, to: Keyframe, before?: Keyframe, after?: Keyframe) {
  if (!to.incomingMotion?.length) return;
  const previous = before && from.incomingMotion ? tracksFor(project, step, before, from.incomingMotion) : [];
  const next = after?.incomingMotion ? tracksFor(project, step, to, after.incomingMotion) : [];
  const tracks = tracksFor(project, step, from, to.incomingMotion).map(plan => ({ plan,
    earlier: previous.find(other => connects(other, plan)), later: next.find(other => connects(plan, other)) }));
  return (progress: number, fraction: number): ReadonlyMap<string, Pose> => new Map(tracks.flatMap(({ plan, earlier, later }) => {
    const travel = curveScalar({ progress, fraction, duration: to.duration, beforeDuration: earlier && from.duration, afterDuration: later && after?.duration },
      0, plan.span, earlier && -earlier.span, later && plan.span + later.span);
    return trackPoses(plan, travel);
  }));
}
