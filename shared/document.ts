import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { stepReorderChanges } from './step-order.ts';
import { isDisplayMode } from './types.ts';
import type { AssemblyStep, Camera, Command, FrameLabels, Keyframe, Model, Part, Pose, Project, Subassembly, Vec3 } from './types.ts';
import { browserRoots, findBrowserNode } from './model-tree.ts';
import { transformPoses } from './assembly-motion.ts';

export const uid = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
export const copy = <T>(value: T): T => structuredClone(value);
export const homePose = (part: Part): Pose => part.assemblyHome ?? part.home;
export function emptyProject(model: Model): Project {
  return { version: 1, id: uid('project'), name: model.name, revision: 0, model, steps: [], updatedAt: new Date().toISOString(),
    settings: { showLabels: false, labelMode: 'auto', labelFontSize: 13, showAxes: false, showConstructionAxes: true, constructionAxisVisibility: {}, showExplosionColumn: false,
      explodeObjects: false, playStrategy: 'sequential', title: model.name, labelOffsets: {}, hiddenLabels: [] } };
}
export function findStep(project: Project, id: string): AssemblyStep {
  const step = project.steps.find(item => item.id === id); if (!step) throw new Error(`Unknown step: ${id}`); return step;
}
export function findFrame(step: AssemblyStep, id: string): Keyframe {
  const frame = step.frames.find(item => item.id === id); if (!frame) throw new Error(`Unknown frame: ${id}`); return frame;
}
export function findPart(project: Project, id: string): Part {
  const part = project.model.parts.find(item => item.id === id); if (!part) throw new Error(`Unknown part: ${id}`); return part;
}
export function frameLabels(project: Project, frame?: Keyframe): FrameLabels { return frame?.labels ?? project.settings; }
export const DEFAULT_LABEL_OFFSET: readonly [number, number] = [20, -30];
export function interpolateOffset(start: readonly [number, number], end: readonly [number, number], t: number): [number, number] {
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}
export function assembledPartIds(project: Project): Set<string> {
  const ids = new Set(project.model.parts.filter(part => part.initiallyAssembled).map(part => part.id));
  for (const step of project.steps) {
    if (!step.final) step.partIds.forEach(id => ids.add(id));
  }
  return ids;
}
export function assemblySnapshot(step: AssemblyStep): Subassembly {
  const end = step.frames.at(-1)!;
  const partIds = step.partIds.filter(id => !step.removePartIds.includes(id) && !end.hidden.includes(id));
  return { id: uid('group'), name: step.name, sourceStepId: step.id, partIds, poses: Object.fromEntries(partIds.map(id => [id, copy(end.poses[id])])) };
}
export function explodedPoses(project: Project, step: AssemblyStep, amount = 1, preserveInstalled = true): Record<string, Pose> {
  const parts = step.partIds.map(id => findPart(project, id));
  const bounds = new Box3(); project.model.parts.filter(p => p.sourceStatus === 'active').forEach(p => { bounds.expandByPoint(new Vector3(...p.bounds[0])); bounds.expandByPoint(new Vector3(...p.bounds[1])); });
  const origin = bounds.getCenter(new Vector3());
  const groups = step.groups.map(group => group.partIds);
  if (project.settings.explodeObjects) {
    const byObject = new Map<string, string[]>();
    parts.filter(p => !groups.some(g => g.includes(p.id))).forEach(p => byObject.set(p.objectId, [...(byObject.get(p.objectId) ?? []), p.id]));
    groups.push(...byObject.values());
  }
  const poses: Record<string, Pose> = {};
  for (const part of parts) {
    const group = groups.find(ids => ids.includes(part.id));
    const members = group ? parts.filter(p => group.includes(p.id)) : [part];
    const offset = new Vector3();
    members.forEach(member => { const home = homePose(member); const delta = member.explosionOffset ? new Vector3(...member.explosionOffset).add(new Vector3(...home.position).sub(new Vector3(...member.home.position))) : new Vector3(...home.position).sub(origin); offset.add(delta.applyQuaternion(new Quaternion(...home.quaternion))); }); offset.divideScalar(members.length);
    const distance = preserveInstalled && (part.initiallyAssembled || step.groups.some(g => g.sourceStepId && g.partIds.includes(part.id))) ? 0 : amount;
    poses[part.id] = { position: new Vector3(...homePose(part).position).addScaledVector(offset, distance).toArray(), quaternion: [...homePose(part).quaternion] };
  }
  return poses;
}
/** Bambu auto-teardown packs new parts along six axes with a 5 mm gap. */
export function teardownPoses(project: Project, step: AssemblyStep): Record<string, Pose> {
  const poses: Record<string, Pose> = {}, overall = new Box3();
  const groups = step.groups.map(group => ({ ids: group.partIds, fixed: !!group.sourceStepId, poses: group.poses }));
  const items: { ids: string[]; bounds: Box3; fixed: boolean; direction: number; distance: number }[] = [];
  const visited = new Set<string>();
  for (const id of step.partIds) {
    if (visited.has(id)) continue;
    const part = findPart(project, id), group = groups.find(g => g.ids.includes(id));
    const ids = (group?.ids ?? (step.final || project.settings.explodeObjects ? step.partIds.filter(other => findPart(project, other).objectId === part.objectId) : [id])).filter(other => step.partIds.includes(other));
    const bounds = new Box3();
    for (const memberId of ids) {
      visited.add(memberId); const member = findPart(project, memberId), pose = copy(group?.fixed && group.poses[memberId] || homePose(member)); poses[memberId] = pose;
      const local = new Box3(new Vector3(...member.bounds[0]).sub(new Vector3(...member.home.position)), new Vector3(...member.bounds[1]).sub(new Vector3(...member.home.position)));
      bounds.union(local.applyMatrix4(new Matrix4().compose(new Vector3(...pose.position), new Quaternion(...pose.quaternion), new Vector3(1, 1, 1))));
    }
    overall.union(bounds); items.push({ ids, bounds, fixed: !!group?.fixed || ids.every(memberId => findPart(project, memberId).initiallyAssembled), direction: 0, distance: 0 });
  }
  const center = overall.getCenter(new Vector3());
  for (const item of items) {
    const delta = item.bounds.getCenter(new Vector3()).sub(center).toArray(); let axis = 0;
    if (Math.abs(delta[1]) > Math.abs(delta[axis])) axis = 1; if (Math.abs(delta[2]) > Math.abs(delta[axis])) axis = 2;
    item.direction = axis * 2 + (delta[axis] >= 0 ? 0 : 1); item.distance = Math.abs(delta[axis]);
  }
  for (let direction = 0; direction < 6; direction++) {
    const axis = Math.floor(direction / 2), positive = direction % 2 === 0;
    let boundary = (positive ? overall.max : overall.min).getComponent(axis);
    for (const item of items.filter(item => !item.fixed && item.direction === direction).sort((a, b) => a.distance - b.distance)) {
      const move = boundary + (positive ? 5 : -5) - (positive ? item.bounds.min : item.bounds.max).getComponent(axis);
      boundary = (positive ? item.bounds.max : item.bounds.min).getComponent(axis) + move;
      item.ids.forEach(id => { poses[id].position[axis] += move; });
    }
  }
  return poses;
}
export function makeStep(project: Project, name: string, partIds: string[] = []): AssemblyStep {
  partIds.forEach(id => findPart(project, id));
  const step: AssemblyStep = { id: uid('step'), name, description: '', partIds: [...new Set(partIds)], groups: [], removePartIds: [], frames: [], final: false };
  const poses = Object.fromEntries(step.partIds.map(id => [id, copy(homePose(findPart(project, id)))]));
  step.frames = [
    { id: uid('frame'), name: 'Start frame', kind: 'start', poses: teardownPoses(project, step), hidden: [], notes: [], duration: 1.5 },
    { id: uid('frame'), name: 'End frame', kind: 'end', poses, hidden: [], notes: [], duration: 1.5 },
  ]; return step;
}
export function addGroup(project: Project, step: AssemblyStep, source: AssemblyStep): void {
  if (step.final || source.final) throw new Error('Final assembly is a summary and cannot be inherited or edited as an operation.');
  if (step.id === source.id) throw new Error('A step cannot inherit itself.');
  const group = assemblySnapshot(source);
  if (!group.partIds.length) throw new Error('The source step has no assembled parts.');
  if (project.steps.indexOf(source) >= project.steps.indexOf(step)) throw new Error('Choose an earlier assembly step.');
  step.groups = step.groups.filter(g => g.sourceStepId !== source.id);
  step.groups.push(group); step.partIds = [...new Set([...step.partIds, ...group.partIds])];
  for (const frame of step.frames) {
    for (const id of group.partIds) frame.poses[id] = copy(group.poses[id]);
    frame.hidden = frame.hidden.filter(id => !group.partIds.includes(id));
    delete frame.image;
  }
}
export function setMembers(project: Project, step: AssemblyStep, partIds: string[]): void {
  if (step.final) throw new Error('Final assembly always contains every active source part.');
  partIds.forEach(id => findPart(project, id));
  const previous = new Set(step.partIds); step.partIds = [...new Set(partIds)];
  const membershipChanged = previous.size !== step.partIds.length || step.partIds.some(id => !previous.has(id));
  step.groups = step.groups.map(group => ({ ...group, partIds: group.partIds.filter(id => partIds.includes(id)) })).filter(group => group.partIds.length);
  step.removePartIds = step.removePartIds.filter(id => partIds.includes(id));
  if (step.removalRestore) step.removalRestore = Object.fromEntries(Object.entries(step.removalRestore).filter(([id]) => partIds.includes(id)));
  const exploded = teardownPoses(project, step);
  for (const frame of step.frames) {
    frame.poses = Object.fromEntries(step.partIds.map(id => [id, previous.has(id) ? frame.poses[id] ?? copy(homePose(findPart(project, id))) : frame.kind === 'start' ? exploded[id] : copy(homePose(findPart(project, id)))]));
    frame.hidden = frame.hidden.filter(id => partIds.includes(id));
    if (frame.xrayPartIds) frame.xrayPartIds = frame.xrayPartIds.filter(id => partIds.includes(id));
    frame.notes = frame.notes.filter(note => note.anchors.every(anchor => partIds.includes(anchor.partId)));
    if (membershipChanged) delete frame.image;
  }
}
export function finalAssembly(project: Project): AssemblyStep | undefined {
  const finals = project.steps.filter(step => step.final);
  if (finals.length > 1) throw new Error('Only one dedicated Final assembly is allowed.');
  const final = finals[0];
  if (final && project.steps.at(-1) !== final) throw new Error('Final assembly must follow all ordinary steps.');
  return final;
}
export function mergeSources(project: Project, stepIds: string[]): AssemblyStep[] {
  const ids = new Set(stepIds); if (ids.size < 2) throw new Error('Select at least two assembly steps to merge.');
  stepIds.forEach(id => findStep(project, id));
  return project.steps.filter(step => ids.has(step.id));
}
export function mergeCoversWholeModel(project: Project, sources: AssemblyStep[]): boolean {
  const active = project.model.parts.filter(part => part.sourceStatus === 'active');
  const members = new Set(sources.flatMap(step => step.partIds));
  return !!active.length && active.every(part => members.has(part.id));
}
function mergedEndpoints(project: Project, sources: AssemblyStep[]): AssemblyStep {
  const step = makeStep(project, 'Merged Step', [...new Set(sources.flatMap(source => source.partIds))]);
  for (const frame of step.frames) {
    const hidden = new Set<string>(), xray = new Set<string>();
    for (const source of sources) {
      const snapshot = source.frames.find(candidate => candidate.kind === frame.kind) ?? (frame.kind === 'end' ? source.frames.find(candidate => candidate.kind === 'start') : undefined);
      if (!snapshot) continue;
      frame.labels = copy(frameLabels(project, snapshot));
      for (const id of source.partIds) {
        if (snapshot.poses[id]) frame.poses[id] = copy(snapshot.poses[id]);
        if (snapshot.hidden.includes(id)) hidden.add(id); else hidden.delete(id);
        if (snapshot.xrayPartIds?.includes(id)) xray.add(id); else xray.delete(id);
      }
    }
    frame.hidden = step.partIds.filter(id => hidden.has(id));
    if (xray.size) frame.xrayPartIds = step.partIds.filter(id => xray.has(id));
  }
  const removed = new Set<string>();
  for (const source of sources) for (const id of source.partIds) { if (source.removePartIds.includes(id)) removed.add(id); else removed.delete(id); }
  step.removePartIds = [...removed]; return step;
}
function framePresentation(project: Project, step: AssemblyStep, frame: Keyframe, camera?: Camera): void {
  const bounds = new Box3();
  for (const id of step.partIds) {
    if (frame.hidden.includes(id)) continue; const part = findPart(project, id), pose = frame.poses[id];
    const local = new Box3(new Vector3(...part.bounds[0]).sub(new Vector3(...part.home.position)), new Vector3(...part.bounds[1]).sub(new Vector3(...part.home.position)));
    bounds.union(local.applyMatrix4(new Matrix4().compose(new Vector3(...pose.position), new Quaternion(...pose.quaternion), new Vector3(1, 1, 1))));
  }
  const center = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3()), radius = bounds.isEmpty() ? 1 : Math.max(1, bounds.getSize(new Vector3()).length() / 2);
  const direction = camera ? new Vector3(...camera.eye).sub(new Vector3(...camera.target)) : new Vector3(1, -1.5, .9); if (!direction.lengthSq()) direction.set(1, -1.5, .9);
  frame.camera = { eye: center.clone().addScaledVector(direction.normalize(), radius * 1.35 / Math.sin(16 * Math.PI / 180)).toArray(), target: center.toArray(), up: camera?.up ?? [0, 0, 1], margin: 1.35 };
  frame.labels = { showLabels: true, labelMode: frame.labels?.labelMode ?? project.settings.labelMode, labelFontSize: frame.labels?.labelFontSize ?? project.settings.labelFontSize, labelOffsets: {}, hiddenLabels: [] };
}
/** Refresh source inventory while retaining independently authored Final frames. */
export function refreshFinalAssembly(project: Project, resetEnd = false): AssemblyStep | undefined {
  const final = finalAssembly(project); if (!final) return;
  const parts = project.model.parts.filter(part => part.sourceStatus === 'active');
  const ids = parts.map(part => part.id), poses = Object.fromEntries(parts.map(part => [part.id, copy(homePose(part))]));
  const hidden = new Set<string>();
  for (const step of project.steps) {
    if (step.final) continue; const end = step.frames.at(-1); if (!end) continue;
    for (const id of step.partIds) {
      if (!poses[id]) continue;
      if (end.poses[id]) poses[id] = copy(end.poses[id]);
      if (step.removePartIds.includes(id) || end.hidden.includes(id)) hidden.add(id); else hidden.delete(id);
    }
  }
  const removedMembers = new Set(final.partIds.filter(id => !Object.hasOwn(poses, id)));
  final.partIds = ids; final.groups = []; final.removePartIds = final.removePartIds.filter(id => ids.includes(id));
  for (const frame of final.frames) {
    const replace = resetEnd && frame.kind === 'end';
    const nextPoses = Object.fromEntries(ids.map(id => [id, copy(replace ? poses[id] : frame.poses[id] ?? poses[id])]));
    const nextHidden = replace ? ids.filter(id => hidden.has(id)) : frame.hidden.filter(id => ids.includes(id));
    const changed = Object.keys(frame.poses).length !== ids.length || ids.some(id => {
      const previous = frame.poses[id], next = nextPoses[id];
      return !previous || previous.position.some((value, index) => value !== next.position[index]) || previous.quaternion.some((value, index) => value !== next.quaternion[index]);
    }) || frame.hidden.length !== nextHidden.length || frame.hidden.some(id => !nextHidden.includes(id));
    frame.poses = nextPoses; frame.hidden = nextHidden;
    if (removedMembers.size && Array.isArray(frame.xrayPartIds)) frame.xrayPartIds = frame.xrayPartIds.filter(id => !removedMembers.has(id));
    frame.notes = frame.notes.filter(note => note.anchors.every(anchor => ids.includes(anchor.partId)));
    if (changed) delete frame.image;
  }
  if (resetEnd) { final.removePartIds = []; delete final.removalRestore; for (const [id, pose] of Object.entries(final.frames.at(-1)!.poses)) findPart(project, id).assemblyHome = copy(pose); }
  return final;
}
export function applyCommand(project: Project, command: Command): string | undefined {
  const final = finalAssembly(project);
  let result: string | undefined;
  switch (command.type) {
    case 'model.pose': {
      for (const [id, pose] of Object.entries(command.poses)) { findPart(project, id).assemblyHome = copy(pose); if (final?.partIds.includes(id)) { final.frames.at(-1)!.poses[id] = copy(pose); delete final.frames.at(-1)!.image; } }
      break;
    }
    case 'step.add': {
      if (project.steps.filter(step => !step.final).length >= 99) throw new Error('No more than 99 assembly steps plus the final assembly are allowed.');
      const step = makeStep(project, command.name ?? 'Install parts', command.parts);
      const end = final ? project.steps.indexOf(final) : project.steps.length;
      const index = Math.min(end, command.before ? project.steps.indexOf(findStep(project, command.before)) : command.after ? project.steps.indexOf(findStep(project, command.after)) + 1 : end);
      project.steps.splice(index, 0, step); if (command.inherit) { addGroup(project, step, findStep(project, command.inherit)); step.inheritedFrom = command.inherit; }
      result = step.id; break;
    }
    case 'step.rename': findStep(project, command.stepId).name = command.name.trim() || 'Assembly Step'; break;
    case 'step.description': findStep(project, command.stepId).description = command.text; break;
    case 'step.delete': findStep(project, command.stepId); project.steps = project.steps.filter(s => s.id !== command.stepId); break;
    case 'step.reorder': {
      const step = findStep(project, command.stepId);
      if (step.final) throw new Error('Final assembly stays after all ordinary steps.');
      const before = command.before ?? final?.id;
      if (!stepReorderChanges(project.steps.map(item => item.id), step.id, before)) break;
      project.steps = project.steps.filter(item => item !== step);
      project.steps.splice(before ? project.steps.findIndex(item => item.id === before) : project.steps.length, 0, step); break;
    }
    case 'step.copy': {
      if (project.steps.filter(step => !step.final).length >= 99) throw new Error('No more than 99 assembly steps plus the final assembly are allowed.');
      const source = findStep(project, command.stepId); if (source.final) throw new Error('Final assembly cannot be copied or inherited as an operation.');
      const next = command.inherit ? makeStep(project, `${source.name} — next`) : copy(source);
      next.id = uid('step'); next.final = false;
      if (!command.inherit) { next.name += ' copy'; next.frames.forEach(f => { f.id = uid('frame'); f.notes.forEach(n => { n.id = uid('note'); }); }); next.groups.forEach(g => { g.id = uid('group'); }); }
      project.steps.splice(project.steps.indexOf(source) + 1, 0, next);
      if (command.inherit) { addGroup(project, next, source); next.inheritedFrom = source.id; }
      result = next.id; break;
    }
    case 'step.merge': {
      const sources = mergeSources(project, command.stepIds), complete = mergeCoversWholeModel(project, sources), merged = mergedEndpoints(project, sources);
      if ((!complete || final) && project.steps.filter(step => !step.final).length >= 99) throw new Error(complete ? 'Preserving the previous Final assembly requires an available ordinary-step slot (maximum 99).' : 'No more than 99 assembly steps plus the final assembly are allowed.');
      if (complete) {
        merged.final = true; merged.name = 'Final assembly';
        if (final) final.final = false;
        project.steps.push(merged);
      } else project.steps.splice(project.steps.indexOf(sources.at(-1)!) + 1, 0, merged);
      for (const frame of merged.frames) framePresentation(project, merged, frame, command.camera);
      if (complete) for (const [id, pose] of Object.entries(merged.frames.at(-1)!.poses)) findPart(project, id).assemblyHome = copy(pose);
      result = merged.id; break;
    }
    case 'step.members': setMembers(project, findStep(project, command.stepId), command.partIds); break;
    case 'step.group': addGroup(project, findStep(project, command.stepId), findStep(project, command.sourceStepId)); break;
    case 'step.final': {
      findStep(project, command.stepId);
      if (!command.value) { if (final) project.steps = project.steps.filter(step => step !== final); break; }
      const summary = final ?? makeStep(project, 'Final assembly');
      if (!final) { summary.final = true; summary.frames[0].name = 'Final assembly view'; summary.frames[1].name = 'Final assembly'; project.steps.push(summary); }
      refreshFinalAssembly(project, true);
      if (!final) summary.frames[0].hidden = [...summary.frames[1].hidden];
      result = summary.id; break;
    }
    case 'part.rename': {
      const part = findPart(project, command.partId); part.name = command.name.trim() || part.sourceName;
      const visit = (nodes: NonNullable<Model['browserTree']>): void => { for (const node of nodes) { if (node.partId === part.id) node.name = part.name; if (node.children) visit(node.children); } };
      if (project.model.browserTree) visit(project.model.browserTree); break;
    }
    case 'object.rename': {
      project.model.browserTree ??= browserRoots(project.model);
      const node = findBrowserNode(project.model, command.nodeId); if (!node || node.kind !== 'object') throw new Error('Unknown model object.');
      const name = command.name.trim();
      if (name && name !== node.name) { node.sourceName ??= node.name; node.name = name; }
      break;
    }
    case 'axis.rename': {
      const axis = project.model.constructionAxes?.find(item => item.id === command.axisId); if (!axis) throw new Error('Unknown construction axis.');
      const name = command.name.trim(); if (!name || name === axis.name) break;
      axis.sourceName ??= axis.name; axis.name = name;
      const visit = (nodes: NonNullable<Model['browserTree']>): void => { for (const node of nodes) { if (node.axisId === axis.id) node.name = name; if (node.children) visit(node.children); } };
      if (project.model.browserTree) visit(project.model.browserTree); break;
    }
    case 'group.rename': {
      const group = findStep(project, command.stepId).groups.find(item => item.id === command.groupId); if (!group) throw new Error('Unknown assembly group.');
      const name = command.name.trim(); if (name) group.name = name; break;
    }
    case 'part.initial': {
      for (const id of command.partIds) {
        const part = findPart(project, id);
        if (part.initiallyAssembled === command.value) continue;
        part.initiallyAssembled = command.value;
        if (command.value) for (const step of project.steps.filter(step => step.partIds.includes(id))) {
          step.frames[0].poses[id] = copy(homePose(part));
          delete step.frames[0].image;
        }
      }
      break;
    }
    case 'part.remove': {
      const step = findStep(project, command.stepId);
      command.partIds.forEach(id => { if (!step.partIds.includes(id)) throw new Error('Add the part to this step first.'); });
      const removed = new Set(step.removePartIds), start = step.frames[0], end = step.frames.at(-1)!;
      for (const id of command.partIds) {
        if (command.value === removed.has(id)) continue;
        if (command.value) {
          (step.removalRestore ??= {})[id] = { start: copy(start.poses[id]), end: copy(end.poses[id]), endHidden: end.hidden.includes(id) };
          removed.add(id); start.poses[id] = copy(homePose(findPart(project, id)));
          end.hidden = [...new Set([...end.hidden, id])]; const pose = copy(homePose(findPart(project, id))); pose.position[2] += 60; end.poses[id] = pose;
        } else {
          removed.delete(id); const previous = step.removalRestore?.[id];
          if (previous) start.poses[id] = copy(previous.start);
          end.poses[id] = copy(previous?.end ?? homePose(findPart(project, id)));
          end.hidden = previous?.endHidden ? [...new Set([...end.hidden, id])] : end.hidden.filter(value => value !== id);
          if (step.removalRestore) delete step.removalRestore[id];
        }
        delete start.image; delete end.image;
      }
      step.removePartIds = [...removed]; if (step.removalRestore && !Object.keys(step.removalRestore).length) delete step.removalRestore;
      if (step.final) for (const id of command.partIds) findPart(project, id).assemblyHome = copy(end.poses[id]); break;
    }
    case 'frame.add': {
      const step = findStep(project, command.stepId);
      const source = findFrame(step, command.afterId); const frame = copy(source);
      if (command.frameId && project.steps.some(step => step.frames.some(frame => frame.id === command.frameId))) throw new Error(`Keyframe ID is already in use: ${command.frameId}.`);
      frame.id = command.frameId ?? uid('frame'); frame.kind = 'transition'; frame.name = 'Transition frame'; delete frame.image;
      step.frames.splice(Math.min(step.frames.indexOf(source) + 1, step.frames.length - 1), 0, frame); result = frame.id; break;
    }
    case 'frame.delete': {
      const step = findStep(project, command.stepId); const frame = findFrame(step, command.frameId);
      if (frame.kind !== 'transition') throw new Error('Start and end frames are required.'); step.frames = step.frames.filter(f => f !== frame); break;
    }
    case 'frame.update': {
      const step = findStep(project, command.stepId), frame = findFrame(step, command.frameId);
      const { image, ...patch } = command.patch;
      Object.assign(frame, copy(patch));
      if (typeof image === 'string') frame.image = image;
      else if (image === null || patch.poses || patch.camera || patch.hidden || patch.xrayPartIds || patch.labels) delete frame.image;
      if (step.final && frame.kind === 'end' && patch.poses) for (const [id, pose] of Object.entries(patch.poses)) findPart(project, id).assemblyHome = copy(pose);
      break;
    }
    case 'frame.transform': {
      const step = findStep(project, command.stepId), frame = findFrame(step, command.frameId);
      const parts = new Map(project.model.parts.map(part => [part.id, part]));
      frame.poses = transformPoses(command.motions, frame.poses, parts, project.model.constructionAxes ?? [], step);
      delete frame.image;
      if (step.final && frame.kind === 'end') for (const id of step.partIds) parts.get(id)!.assemblyHome = copy(frame.poses[id]);
      break;
    }
    case 'frame.cameraAll': {
      for (const frame of findStep(project, command.stepId).frames) {
        frame.camera = copy(command.camera);
        delete frame.image;
      }
      break;
    }
    case 'note.put': {
      const step = findStep(project, command.stepId); const frame = findFrame(step, command.frameId);
      command.note.anchors.forEach(anchor => { if (!step.partIds.includes(anchor.partId)) throw new Error('Add the target part to this step first.'); });
      const index = frame.notes.findIndex(note => note.id === command.note.id);
      if (index >= 0) frame.notes[index] = copy(command.note); else frame.notes.push(copy(command.note)); break;
    }
    case 'note.update': { const note = findFrame(findStep(project, command.stepId), command.frameId).notes.find(note => note.id === command.noteId); if (!note) throw new Error('The annotation is no longer present.'); Object.assign(note, copy(command.patch)); break; }
    case 'note.delete': { const frame = findFrame(findStep(project, command.stepId), command.frameId); frame.notes = frame.notes.filter(note => note.id !== command.noteId); break; }
    case 'settings.update': Object.assign(project.settings, copy(command.patch)); break;
    default: { const unknownCommand: never = command; throw new Error(`Unknown command: ${JSON.stringify(unknownCommand)}`); }
  }
  refreshFinalAssembly(project); return result;
}
export function interpolatePose(start: Pose, end: Pose, t: number): Pose {
  return { position: new Vector3(...start.position).lerp(new Vector3(...end.position), t).toArray(),
    quaternion: new Quaternion(...start.quaternion).slerp(new Quaternion(...end.quaternion), t).toArray() };
}
export function interpolateCamera(start: Camera, end: Camera, t: number): Camera {
  if (t === 0 || start === end) return start;
  if (t === 1) return end;
  return { margin: start.margin + (end.margin - start.margin) * t,
    eye: new Vector3(...start.eye).lerp(new Vector3(...end.eye), t).toArray(),
    target: new Vector3(...start.target).lerp(new Vector3(...end.target), t).toArray(),
    up: new Vector3(...start.up).lerp(new Vector3(...end.up), t).normalize().toArray() };
}
export function interpolateFrames(from: Keyframe, to: Keyframe, t: number, defaultLabels?: FrameLabels): Keyframe {
  if (t <= 0) return copy(from);
  if (t >= 1) return copy(to);
  const firstHalf = t < .5, frame = copy(firstHalf ? from : to);
  frame.poses = Object.fromEntries(Object.entries(to.poses).map(([id, pose]) => [id, interpolatePose(from.poses[id] ?? pose, pose, t)]));
  frame.hidden = [...(t < .999 ? from.hidden : to.hidden)];
  if (from.xrayPartIds) frame.xrayPartIds = [...from.xrayPartIds];
  else delete frame.xrayPartIds;
  if (from.camera && to.camera) frame.camera = interpolateCamera(from.camera, to.camera, t);
  const otherNotes = new Map((firstHalf ? to : from).notes.filter(note => !note.hidden).map(note => [note.id, note]));
  for (const note of frame.notes) {
    const other = otherNotes.get(note.id);
    if (note.hidden || !other) continue;
    note.offset = firstHalf ? interpolateOffset(note.offset, other.offset, t) : interpolateOffset(other.offset, note.offset, t);
  }
  const startLabels = from.labels ?? defaultLabels, endLabels = to.labels ?? defaultLabels;
  if (startLabels && endLabels && startLabels !== endLabels) {
    const ids = new Set([...Object.keys(startLabels.labelOffsets), ...Object.keys(endLabels.labelOffsets)]);
    const { showLabels, labelMode, labelFontSize, hiddenLabels } = firstHalf ? startLabels : endLabels;
    frame.labels = { showLabels, labelMode, labelFontSize, hiddenLabels: [...hiddenLabels], labelOffsets: Object.fromEntries([...ids].map(id => [id,
      interpolateOffset(startLabels.labelOffsets[id] ?? DEFAULT_LABEL_OFFSET, endLabels.labelOffsets[id] ?? DEFAULT_LABEL_OFFSET, t)])) };
  }
  return frame;
}
export function validateProject(project: Project): string[] {
  const errors: string[] = []; const ids = new Set(project.model.parts.map(p => p.id)); const stepIds = new Set<string>();
  if (project.settings.defaultDisplayMode !== undefined && !isDisplayMode(project.settings.defaultDisplayMode)) errors.push('Default assembly display must be all, xray, or current.');
  const finite = (v: number[], n: number): boolean => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  const poseValid = (p: Pose): boolean => p && finite(p.position, 3) && finite(p.quaternion, 4) && Math.abs(p.quaternion.reduce((sum, x) => sum + x * x, 0) - 1) < .001;
  for (const part of project.model.parts) if (!poseValid(part.home) || part.assemblyHome && !poseValid(part.assemblyHome)) errors.push(`${part.name}: invalid assembly pose.`);
  if (ids.size !== project.model.parts.length) errors.push('Duplicate model part IDs.');
  const finals = project.steps.filter(step => step.final);
  if (finals.length > 1) errors.push('Only one dedicated Final assembly is allowed.');
  if (finals.some(step => step !== project.steps.at(-1))) errors.push('Final assembly must follow all ordinary steps.');
  if (finals.some(step => step.partIds.length !== project.model.parts.filter(part => part.sourceStatus === 'active').length || step.partIds.some(id => project.model.parts.find(part => part.id === id)?.sourceStatus !== 'active'))) errors.push('Final assembly must contain every active source part.');
  for (const step of project.steps) {
    if (stepIds.has(step.id)) errors.push('Duplicate step IDs.'); stepIds.add(step.id);
    if (step.partIds.some(id => !ids.has(id))) errors.push(`${step.name}: unknown part.`);
    if (new Set(step.partIds).size !== step.partIds.length) errors.push(`${step.name}: repeated part.`);
    if (step.frames[0]?.kind !== 'start' || step.frames.at(-1)?.kind !== 'end') errors.push(`${step.name}: start and end frames are required.`);
    for (const frame of step.frames) {
      for (const id of step.partIds) if (!poseValid(frame.poses[id])) errors.push(`${frame.name}: invalid pose for ${id}.`);
      if (frame.hidden.some(id => !step.partIds.includes(id))) errors.push(`${frame.name}: unknown hidden part.`);
      if (frame.xrayPartIds !== undefined && (!Array.isArray(frame.xrayPartIds) || frame.xrayPartIds.some(id => !step.partIds.includes(id)))) errors.push(`${frame.name}: X-Ray part IDs must belong to this step.`);
      if (!(frame.duration > 0 && Number.isFinite(frame.duration))) errors.push('Frame duration must be positive.');
      for (const note of frame.notes) for (const anchor of note.anchors) {
        if (!step.partIds.includes(anchor.partId) || !finite(anchor.point, 3) || !finite(anchor.normal, 3)) errors.push(`${note.id}: invalid surface anchor.`);
      }
    }
    if (step.removePartIds.some(id => !step.partIds.includes(id))) errors.push('Removal target is outside its step.');
    if (step.groups.some(group => group.partIds.some(id => !step.partIds.includes(id)))) errors.push('Assembly group is outside its step.');
  }
  return [...new Set(errors)];
}
export function frameQueue(project: Project, stepId?: string): { step: AssemblyStep; frame: Keyframe }[] {
  finalAssembly(project);
  let steps = stepId ? [findStep(project, stepId)] : [...project.steps];
  if (!stepId && project.settings.playStrategy === 'subassembly') {
    const ordered: AssemblyStep[] = []; const seen = new Set<string>();
    const visit = (step: AssemblyStep): void => { if (seen.has(step.id)) return; seen.add(step.id); for (const group of step.groups) { const source = steps.find(s => s.id === group.sourceStepId); if (source) visit(source); } ordered.push(step); };
    steps.forEach(visit); steps = ordered;
  }
  return steps.flatMap(step => step.frames.map(frame => ({ step, frame })));
}
export function modelCenter(model: Model): Vec3 {
  const center = new Vector3(); model.parts.forEach(part => center.add(new Vector3(...part.home.position))); return center.divideScalar(model.parts.length || 1).toArray();
}
