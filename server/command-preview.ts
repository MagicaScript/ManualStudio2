import { isDeepStrictEqual } from 'node:util';
import { Quaternion, Vector3 } from 'three';
import { frameQueue } from '../shared/document.ts';
import type { AssemblyStep, Project } from '../shared/types.ts';

function stepChanges(before: AssemblyStep | undefined, after: AssemblyStep | undefined) {
  const previous = new Map(before?.frames.map((frame, index) => [frame.id, { frame, index }]));
  const proposed = new Map(after?.frames.map((frame, index) => [frame.id, { frame, index }]));
  const frameIds = new Set([...previous.keys(), ...proposed.keys()]);
  return [...frameIds].filter(id => !isDeepStrictEqual(previous.get(id), proposed.get(id)));
}

export function previewChanges(before: Project, after: Project) {
  const previous = new Map(before.steps.map((step, index) => [step.id, { step, index }]));
  const proposed = new Map(after.steps.map((step, index) => [step.id, { step, index }]));
  const changes = [...new Set([...previous.keys(), ...proposed.keys()])].flatMap(stepId => {
    const from = previous.get(stepId), to = proposed.get(stepId);
    if (isDeepStrictEqual(from, to)) return [];
    return [{
      stepId, name: (to ?? from)!.step.name, fromIndex: from?.index ?? null, toIndex: to?.index ?? null,
      frameIds: stepChanges(from?.step, to?.step),
    }];
  });
  const affected = new Set(changes.map(change => change.stepId));
  const playbackOrder = [...new Set(frameQueue(after).map(entry => entry.step))].filter(step => step.partIds.length);
  const handoffWarnings = playbackOrder.slice(1).flatMap((next, index) => {
    const previous = playbackOrder[index];
    if (affected.size && !affected.has(previous.id) && !affected.has(next.id)) return [];
    const end = previous.frames.at(-1)!, start = next.frames[0];
    const parts = next.partIds.flatMap(partId => {
      if (!previous.partIds.includes(partId)) return [];
      const endPose = end.poses[partId], startPose = start.poses[partId];
      const distance = new Vector3(...endPose.position).distanceTo(new Vector3(...startPose.position));
      const angleDegrees = new Quaternion(...endPose.quaternion).normalize().angleTo(new Quaternion(...startPose.quaternion).normalize()) * 180 / Math.PI;
      const hiddenBefore = end.hidden.includes(partId), hiddenAfter = start.hidden.includes(partId);
      if (distance <= .001 && angleDegrees <= .01 && hiddenBefore === hiddenAfter) return [];
      return [{ partId, distance, angleDegrees, hiddenBefore, hiddenAfter }];
    });
    return parts.length ? [{ fromStepId: previous.id, toStepId: next.id, fromFrameId: end.id, toFrameId: start.id, parts }] : [];
  });
  return { steps: changes, handoffWarnings };
}
