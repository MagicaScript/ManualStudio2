import { Vector3 } from 'three';
import { isAxisReference, isFiniteNumber, isIdList, isMotionMembers, isPose, isRecord, motionPartIds, poseMatrix, resolveAxis } from '../shared/assembly-motion.ts';
import { findFrame, interpolatedFramePose, interpolatePose } from '../shared/document.ts';
import { easeMotion, playbackInterpolation, stepPlayback, type PlaybackSegment } from '../shared/playback.ts';
import type { Pose, Project } from '../shared/types.ts';
import { loadGeometry, poseContext } from './geometry-data.ts';
import { collisionMesh, meshContact, meshPlacement, type Contact } from './motion-contact.ts';

type MotionSegment = { duration: number } & ({ playback: PlaybackSegment } | {
  from: Readonly<Record<string, Pose>>; to: Readonly<Record<string, Pose>>;
});
interface Sample extends Contact { seconds: number; progress: number; segment: number; fromFrameId?: string; toFrameId?: string }
interface Pair {
  movingPartId: string; obstaclePartId: string; allowed: boolean; minimum: Sample | null;
  firstContact: Sample | null; firstViolation: Sample | null;
}

function makeSegments(project: Project, path: Record<string, unknown>, context: ReturnType<typeof poseContext>,
  movingIds: string[], startPoses: Record<string, Pose>): MotionSegment[] {
  if (path.kind === 'saved') {
    const step = context.step;
    if (!step) throw new Error('A saved motion check requires a step or keyframe ID.');
    if (!movingIds.every(id => step.partIds.includes(id))) throw new Error('Moving parts must belong to the saved step.');
    if (path.toFrameId !== undefined && typeof path.toFrameId !== 'string') throw new Error('Expected a destination keyframe ID.');
    const from = context.frame!, to = path.toFrameId === undefined ? step.frames.at(-1)! : findFrame(step, path.toFrameId);
    const first = step.frames.indexOf(findFrame(step, from.id)), last = step.frames.indexOf(to);
    if (first >= last) throw new Error('Select an end keyframe after the starting keyframe.');
    return step.frames.slice(first, last).map(frame => {
      const playback = stepPlayback(project, step, frame);
      return { playback, duration: playback.duration };
    });
  }
  if (path.kind === 'insertion') {
    const { axis, distance, duration = 1 } = path;
    if (!isAxisReference(axis) || !isFiniteNumber(distance) || !isFiniteNumber(duration) || duration <= 0) throw new Error('Insertion requires an axis, signed distance and positive duration.');
    const translation = resolveAxis(axis, project.model.constructionAxes ?? [], context.lookup).direction.multiplyScalar(distance);
    const to = { ...startPoses };
    for (const id of movingIds) {
      const pose = startPoses[id];
      to[id] = { ...pose, position: new Vector3(...pose.position).add(translation).toArray() };
    }
    return [{ from: startPoses, to, duration }];
  }
  if (path.kind !== 'waypoints' || !Array.isArray(path.waypoints) || !path.waypoints.length) {
    throw new Error('Motion path must be saved, insertion, or waypoints with at least one target.');
  }
  let from = startPoses;
  return path.waypoints.map((waypoint: unknown) => {
    if (!isRecord(waypoint) || !isFiniteNumber(waypoint.duration) || waypoint.duration <= 0 || !isRecord(waypoint.poses)) {
      throw new Error('Waypoints require a poses object and positive duration.');
    }
    const to = { ...from };
    for (const [id, pose] of Object.entries(waypoint.poses)) {
      if (!movingIds.includes(id) || !isPose(pose)) throw new Error(`Invalid moving-part pose in waypoint: ${id}.`);
      to[id] = pose;
    }
    const segment = { from, to, duration: waypoint.duration };
    from = to; return segment;
  });
}

export async function checkMotion(project: Project, directory: string, request: Record<string, unknown>) {
  const { moving, obstaclePartIds, path, stepId, frameId, minimumClearance = 0, sampleRate = 30, allowedContacts = [] } = request;
  if (!isMotionMembers(moving) || !isIdList(obstaclePartIds) || !obstaclePartIds.length || !isRecord(path)) {
    throw new Error('Provide moving parts or groups, obstacle part IDs and a motion path.');
  }
  if (stepId !== undefined && typeof stepId !== 'string' || frameId !== undefined && typeof frameId !== 'string') throw new Error('Step and keyframe IDs must be text.');
  if (!isFiniteNumber(minimumClearance) || minimumClearance < 0 || !isFiniteNumber(sampleRate) || sampleRate <= 0) {
    throw new Error('Minimum clearance must be nonnegative and sample rate must be positive.');
  }
  const context = poseContext(project, frameId, 0, stepId), movingIds = motionPartIds(moving, context.parts, context.step);
  const obstacleIds = [...new Set(obstaclePartIds)];
  for (const id of obstacleIds) {
    if (movingIds.includes(id)) throw new Error(`Part ${id} cannot act as both a moving part and an obstacle.`);
    if (context.parts.get(id)?.sourceStatus !== 'active') throw new Error(`Unknown active obstacle: ${id}.`);
  }
  if (!Array.isArray(allowedContacts) || !allowedContacts.every(pair => Array.isArray(pair) && pair.length === 2 && movingIds.includes(pair[0]) && obstacleIds.includes(pair[1]))) {
    throw new Error('Each allowed contact must list a moving part ID followed by an obstacle part ID.');
  }
  const allowed = new Set(allowedContacts.map(pair => JSON.stringify(pair)));
  const pairs: Pair[] = movingIds.flatMap(movingPartId => obstacleIds.map(obstaclePartId => ({
    movingPartId, obstaclePartId, allowed: allowed.has(JSON.stringify([movingPartId, obstaclePartId])),
    minimum: null, firstContact: null, firstViolation: null,
  })));
  const ids = [...movingIds, ...obstacleIds];
  const startPoses = Object.fromEntries(ids.map(id => [id, context.pose(id)]));
  const segments = makeSegments(project, path, context, movingIds, startPoses);
  const meshById = new Map<string, ReturnType<typeof collisionMesh>>();
  for (const id of ids) meshById.set(id, collisionMesh(await loadGeometry(context.parts.get(id)!, directory)));
  let elapsed = 0, samples = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    const intervals = Math.max(1, Math.ceil(segment.duration * sampleRate));
    if (!Number.isSafeInteger(intervals)) throw new Error('The requested sample count is too large.');
    const fromFrameId = 'playback' in segment ? segment.playback.from.id : undefined;
    const toFrameId = 'playback' in segment ? segment.playback.to.id : undefined;
    for (let sample = segmentIndex === 0 ? 0 : 1; sample <= intervals; sample++) {
      const progress = sample / intervals, seconds = elapsed + segment.duration * progress;
      let poseAt: (id: string) => Pose;
      if ('playback' in segment) {
        const playback = segment.playback, blend = playbackInterpolation(playback, progress);
        poseAt = id => interpolatedFramePose(playback.from, playback.to, id, blend) ?? startPoses[id];
      } else {
        const eased = easeMotion(progress);
        poseAt = id => segment.from[id] === segment.to[id] ? segment.from[id] : interpolatePose(segment.from[id], segment.to[id], eased);
      }
      const placements = new Map(ids.map(id => [id, meshPlacement(meshById.get(id)!, poseMatrix(poseAt(id)))]));
      for (const pair of pairs) {
        const contact = meshContact(placements.get(pair.movingPartId)!, placements.get(pair.obstaclePartId)!,
          Math.max(pair.minimum?.clearance ?? Infinity, minimumClearance));
        if (!contact) continue;
        const finding = { ...contact, seconds, progress, segment: segmentIndex, fromFrameId, toFrameId };
        if (!pair.minimum || contact.clearance < pair.minimum.clearance) pair.minimum = finding;
        const touching = contact.kind !== 'separated';
        if (touching) pair.firstContact ??= finding;
        if (!pair.allowed && (touching || contact.clearance < minimumClearance)) pair.firstViolation ??= finding;
      }
      samples++;
    }
    elapsed += segment.duration;
  }
  let minimum = Infinity;
  let firstViolation: (Sample & Pick<Pair, 'movingPartId' | 'obstaclePartId'>) | null = null;
  for (const pair of pairs) {
    minimum = Math.min(minimum, pair.minimum?.clearance ?? Infinity);
    if (pair.firstViolation && (!firstViolation || pair.firstViolation.seconds < firstViolation.seconds)) {
      firstViolation = { movingPartId: pair.movingPartId, obstaclePartId: pair.obstaclePartId, ...pair.firstViolation };
    }
  }
  return {
    revision: project.revision, stepId: context.step?.id ?? null, frameId: context.frame?.id ?? null,
    path: path.kind, duration: elapsed, units: 'mm', sampleRate, samples, requiredClearance: minimumClearance,
    pass: firstViolation === null, minimumClearance: Number.isFinite(minimum) ? minimum : null, firstViolation, pairs,
  };
}
