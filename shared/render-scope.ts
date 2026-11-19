import { isFiniteNumber, isRecord } from './assembly-motion.ts';
import { framePlayback, playbackPlan, type PlaybackSegment } from './playback.ts';
import type { Project } from './types.ts';

export interface RenderScope {
  stepId?: string;
  frameId?: string;
  progress?: number;
  time?: number;
  range?: [number, number];
}
export interface PlaybackSlice { segment: PlaybackSegment; start: number; end: number; duration: number }

export function readRenderScope(kind: string, value: unknown): RenderScope {
  if (kind !== 'png' && kind !== 'mp4') throw new Error('Render scopes require PNG or MP4.');
  if (!isRecord(value)) throw new Error('Provide a render scope object.');
  const { stepId, frameId, progress, time, range } = value;
  if (stepId !== undefined && (typeof stepId !== 'string' || !stepId) || frameId !== undefined && (typeof frameId !== 'string' || !frameId)) {
    throw new Error('Step and keyframe IDs must be nonempty text.');
  }
  if (kind === 'png') {
    if (range !== undefined || time !== undefined && (!isFiniteNumber(time) || time < 0 || frameId !== undefined) ||
      progress !== undefined && (!isFiniteNumber(progress) || progress < 0 || progress > 1 || frameId === undefined) ||
      stepId === undefined && frameId === undefined && time === undefined) {
      throw new Error('Select a step, a keyframe with optional progress from 0 to 1, or a timeline time in seconds.');
    }
    return { stepId, frameId, progress, time };
  }
  if (progress !== undefined || time !== undefined || range !== undefined && (frameId !== undefined || !Array.isArray(range) ||
    range.length !== 2 || !range.every(isFiniteNumber) || range[0] < 0 || range[0] >= range[1]) ||
    stepId === undefined && frameId === undefined && range === undefined) {
    throw new Error('Select a step, an outgoing keyframe transition, or an increasing time range in seconds.');
  }
  return { stepId, frameId, range: range === undefined ? undefined : [range[0], range[1]] };
}

function timedSegments(project: Project, stepId?: string) {
  let end = 0;
  return playbackPlan(project, stepId).map(segment => {
    const start = end;
    end += segment.duration;
    return { segment, start, end };
  });
}

export function renderImageSample(project: Project, scope: RenderScope): { segment: PlaybackSegment; progress: number } {
  if (scope.time === undefined) return { segment: framePlayback(project, scope.frameId, scope.stepId), progress: scope.progress ?? 0 };
  const timeline = timedSegments(project, scope.stepId), last = timeline.at(-1);
  if (!last || scope.time > last.end + 1e-9) throw new Error('The requested time is outside the playback timeline.');
  const time = scope.time, entry = timeline.find(entry => time < entry.end - 1e-9) ?? last;
  return { segment: entry.segment, progress: Math.max(0, Math.min(1, (time - entry.start) / entry.segment.duration)) };
}

export function renderVideoSlices(project: Project, scope: RenderScope): PlaybackSlice[] {
  if (scope.frameId !== undefined) {
    const segment = framePlayback(project, scope.frameId, scope.stepId);
    const duration = segment.kind === 'hold' ? segment.step.frames[0].duration : segment.duration;
    return [{ segment, start: 0, end: 1, duration }];
  }
  const timeline = timedSegments(project, scope.stepId), last = timeline.at(-1);
  if (!last) throw new Error('The selected playback timeline has no segments.');
  const [from, to] = scope.range ?? [0, last.end];
  if (from >= last.end || to > last.end + 1e-9) throw new Error('The requested range is outside the playback timeline.');
  return timeline.flatMap(({ segment, start, end }) => {
    const lower = Math.max(start, from), upper = Math.min(end, to);
    if (upper <= lower) return [];
    return [{ segment, start: (lower - start) / segment.duration, end: (upper - start) / segment.duration, duration: upper - lower }];
  });
}
