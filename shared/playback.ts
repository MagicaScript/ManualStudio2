import { frameQueue, interpolateFrames } from './document.ts';
import type { AssemblyStep, Keyframe, Project } from './types.ts';

export interface PlaybackSegment { kind: 'cover' | 'title' | 'motion' | 'hold'; duration: number; step: AssemblyStep; from: Keyframe; to: Keyframe }
export interface PlaybackCard { title: string; subtitle?: string }

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
        const from = entries[frameIndex - 1].frame, to = entries[frameIndex].frame;
        segments.push({ kind: 'motion', duration: to.duration, step, from, to });
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

export function playbackFrame(segment: PlaybackSegment, progress: number): Keyframe {
  const t = Math.max(0, Math.min(1, progress));
  return segment.kind === 'motion' ? interpolateFrames(segment.from, segment.to, t * t * (3 - 2 * t)) : segment.to;
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
