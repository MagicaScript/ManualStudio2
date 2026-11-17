import { assemblySnapshot, findStep } from './document.ts';
import type { Command, Project } from './types.ts';

export interface PickerDraft { stepId: string; ids: Set<string>; assemblies: Set<string> }

export function createPickerDraft(project: Project, stepId: string): PickerDraft {
  const step = findStep(project, stepId);
  if (step.final) throw new Error('Final assembly includes every active source part automatically.');
  return { stepId, ids: new Set(step.partIds), assemblies: new Set() };
}

export function stagePickerAssembly(project: Project, draft: PickerDraft, sourceId: string): void {
  const source = findStep(project, sourceId), target = findStep(project, draft.stepId);
  if (source.final || project.steps.indexOf(source) >= project.steps.indexOf(target)) throw new Error('Choose an earlier ordinary assembly step.');
  const snapshot = assemblySnapshot(source);
  if (!snapshot.partIds.length) throw new Error('The source step has no assembled parts.');
  draft.assemblies.add(sourceId); snapshot.partIds.forEach(id => draft.ids.add(id));
}

export function pickerCommands(project: Project, draft: PickerDraft): Command[] {
  const original = findStep(project, draft.stepId);
  const assemblies = [...draft.assemblies].filter(id => assemblySnapshot(findStep(project, id)).partIds.some(partId => draft.ids.has(partId)));
  if (!assemblies.length && original.partIds.length === draft.ids.size && original.partIds.every(id => draft.ids.has(id))) return [];
  return [...assemblies.map(sourceStepId => ({ type: 'step.group' as const, stepId: draft.stepId, sourceStepId })), { type: 'step.members', stepId: draft.stepId, partIds: [...draft.ids] }];
}
