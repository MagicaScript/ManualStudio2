import { findFrame, findStep, frameQueue, interpolateFrames, type FrameInterpolation } from './document.ts';
import { incomingMotionSampler } from './motion-tracks.ts';
import type { AssemblyStep, FrameLabels, Keyframe, Pose, Project } from './types.ts';

export interface PlaybackSegment { kind: 'cover' | 'title' | 'motion' | 'hold'; duration: number; step: AssemblyStep; from: Keyframe; to: Keyframe; before?: Keyframe; after?: Keyframe; sampleMotion?: ReturnType<typeof incomingMotionSampler> }
export interface PlaybackCard { title: string; subtitle?: string }

export function framePlayback(project: Project, frameId?: string, stepId?: string): PlaybackSegment {
  const step = stepId ? findStep(project, stepId) : project.steps.find(step => step.frames.some(frame => frame.id === frameId));
  if (!step) throw new Error(`Unknown keyframe: ${frameId}.`);
  return stepPlayback(project, step, frameId === undefined ? step.frames[0] : findFrame(step, frameId));
}

export function stepPlayback(project: Project, step: AssemblyStep, from: Keyframe): PlaybackSegment {
  const index = step.frames.indexOf(from), to = step.frames[index + 1];
  if (!to) return { kind: 'hold', step, from, to: from, duration: 0 };
  const before = from.kind === 'transition' && from.passThrough ? step.frames[index - 1] : undefined;
  const after = to.kind === 'transition' && to.passThrough ? step.frames[index + 2] : undefined;
  return { kind: 'motion', step, from, to, duration: to.duration, before, after, sampleMotion: incomingMotionSampler(project, step, from, to, before, after) };
}

export function continuousBoundary(segment: PlaybackSegment, next?: PlaybackSegment): boolean {
  return !!segment.after && next?.from === segment.to && next.to === segment.after;
}

export function playbackPlan(project: Project, localStepId?: string): PlaybackSegment[] {
  const queue = frameQueue(project, localStepId), segments: PlaybackSegment[] = [];
  if (!queue.length) return segments;
  const first = queue[0];
  if (!localStepId) segments.push({ kind: 'cover', duration: 2, step: first.step, from: first.frame, to: first.frame });
  for (let index = 0; index < queue.length;) {
    const step = queue[index].step, entries = queue.filter(item => item.step.id === step.id), start = entries[0].frame, end = entries.at(-1)!.frame;
    if (!localStepId) segments.push({ kind: 'title', duration: 1.5, step, from: start, to: start });
    if (step.partIds.length) {
      for (let frameIndex = 1; frameIndex < entries.length; frameIndex++) {
        segments.push(stepPlayback(project, step, entries[frameIndex - 1].frame));
      }
      // The start frame has no incoming transition; its duration controls the completed-step hold.
      segments.push({ kind: 'hold', duration: start.duration, step, from: end, to: end });
    }
    index += entries.length;
  }
  return segments;
}

export function playbackDuration(segment: PlaybackSegment, speed = 1): number {
  return segment.duration / (segment.kind === 'motion' || segment.kind === 'hold' ? speed : 1);
}

export function easeMotion(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}

export function playbackFrame(segment: PlaybackSegment, progress: number, defaultLabels?: FrameLabels): Keyframe {
  return segment.kind === 'motion' ? interpolateFrames(segment.from, segment.to, playbackInterpolation(segment, progress), defaultLabels) : segment.to;
}

export function playbackInterpolation(segment: PlaybackSegment, progress: number): FrameInterpolation {
  const fraction = easeMotion(progress), { from, to, before, after, sampleMotion } = segment;
  const curve = before || after ? {
    progress, fraction, duration: to.duration, beforeDuration: before && from.duration, afterDuration: after?.duration,
  } : undefined;
  let poses: ReadonlyMap<string, Pose> | undefined;
  const rigidPose = sampleMotion && ((id: string) => (poses ??= sampleMotion(progress, fraction)).get(id));
  return { fraction, curve, before, after, rigidPose };
}

export function playbackCard(project: Project, segment: PlaybackSegment): PlaybackCard | undefined {
  if (segment.kind === 'cover') return { title: project.settings.title || project.name || 'Assembly Guide', subtitle: '---- Assembly Guide' };
  if (segment.kind === 'title') return { title: segment.step.name || 'Assembly Step' };
  return undefined;
}

export function resumeAfterTitle(segments: PlaybackSegment[], index: number): number {
  if (segments[index]?.kind !== 'cover' && segments[index]?.kind !== 'title') return index;
  const next = segments.findIndex((segment, candidate) => candidate > index && (segment.kind === 'motion' || segment.kind === 'hold'));
  return next >= 0 ? next : segments.length;
}
