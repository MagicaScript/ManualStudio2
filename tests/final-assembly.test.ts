import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, copy, emptyProject, finalAssembly, findStep, frameQueue, homePose, validateProject } from '../shared/document.ts';
import { createPickerDraft, pickerCommands, stagePickerAssembly } from '../shared/picker-draft.ts';
import { parse3mf } from '../server/import-3mf.ts';
import { applySync, planSync } from '../server/sync.ts';
import { transactionModel } from './fixtures/assembly-transaction.ts';

test('Final is one whole-model summary and preserves every ordinary operation and its frames', () => {
  const project = emptyProject(parse3mf(transactionModel(), 'Demo Assembly.3mf').model), [shell, support, unused] = project.model.parts;
  const firstId = applyCommand(project, { type: 'step.add', name: 'Install shell', parts: [shell.id] })!;
  const secondId = applyCommand(project, { type: 'step.add', name: 'Remove support', parts: [support.id] })!;
  const first = findStep(project, firstId), second = findStep(project, secondId);
  first.frames[1].poses[shell.id].position = [41, 42, 43];
  applyCommand(project, { type: 'part.remove', stepId: secondId, partIds: [support.id], value: true });
  const operations = copy(project.steps), finalId = applyCommand(project, { type: 'step.final', stepId: firstId, value: true })!;
  assert.notEqual(finalId, firstId); assert.deepEqual(project.steps.slice(0, -1), operations);
  const summary = finalAssembly(project)!; assert.deepEqual(summary.partIds, project.model.parts.map(part => part.id));
  for (const frame of summary.frames) { assert.deepEqual(frame.poses[shell.id], first.frames[1].poses[shell.id]); assert.deepEqual(frame.poses[unused.id], homePose(unused)); assert.deepEqual(frame.hidden, [support.id]); }
  assert.equal(applyCommand(project, { type: 'step.final', stepId: secondId, value: true }), finalId);
  assert.equal(project.steps.filter(step => step.final).length, 1); assert.equal(frameQueue(project).length, 6);
  const camera = { eye: [1, 2, 3] as [number, number, number], target: [4, 5, 6] as [number, number, number], up: [0, 0, 1] as [number, number, number], margin: 1.2 };
  applyCommand(project, { type: 'frame.update', stepId: finalId, frameId: summary.frames[1].id, patch: { camera } });
  applyCommand(project, { type: 'frame.update', stepId: firstId, frameId: first.frames[1].id, patch: { poses: { [shell.id]: { position: [11, 12, 13], quaternion: [0, 0, 0, 1] } } } });
  assert.deepEqual(summary.frames[0].poses[shell.id].position, [41, 42, 43], 'Ordinary edits must not flatten authored Final frames.');
  applyCommand(project, { type: 'step.final', stepId: finalId, value: true });
  assert.deepEqual(summary.frames[1].poses[shell.id].position, [11, 12, 13]); assert.deepEqual(summary.frames[1].camera, camera);
  applyCommand(project, { type: 'step.members', stepId: firstId, partIds: [] }); assert.deepEqual(summary.frames[0].poses[shell.id].position, [41, 42, 43]);
  applyCommand(project, { type: 'step.delete', stepId: secondId }); applyCommand(project, { type: 'step.final', stepId: finalId, value: true }); assert.deepEqual(summary.frames[1].hidden, []);
  assert.deepEqual(validateProject(project), []);
});

test('ordinary insertion, copy and reorder remain before Final; invalid Final structures are rejected', () => {
  const project = emptyProject(parse3mf(transactionModel(), 'Demo Assembly.3mf').model);
  const first = applyCommand(project, { type: 'step.add', parts: [project.model.parts[0].id] })!;
  const final = applyCommand(project, { type: 'step.final', stepId: first, value: true })!;
  const added = applyCommand(project, { type: 'step.add', after: final })!;
  const copied = applyCommand(project, { type: 'step.copy', stepId: first })!;
  applyCommand(project, { type: 'step.reorder', stepId: first });
  assert.deepEqual(project.steps.map(step => step.id), [copied, added, first, final]);
  const before = copy(project);
  assert.throws(() => applyCommand(project, { type: 'step.reorder', stepId: final, before: first }), /stays after/);
  assert.throws(() => applyCommand(project, { type: 'step.copy', stepId: final }), /cannot be copied/);
  assert.throws(() => applyCommand(project, { type: 'step.members', stepId: final, partIds: [] }), /every active/);
  assert.throws(() => applyCommand(project, { type: 'step.group', stepId: added, sourceStepId: final }), /cannot be inherited/);
  assert.deepEqual(project, before);
  const duplicate = copy(project); duplicate.steps[0].final = true;
  assert.ok(validateProject(duplicate).some(error => /Only one/.test(error))); assert.throws(() => frameQueue(duplicate), /Only one/);
  const misplaced = copy(project); misplaced.steps.unshift(misplaced.steps.pop()!);
  assert.ok(validateProject(misplaced).some(error => /follow all/.test(error))); assert.throws(() => frameQueue(misplaced), /follow all/);
  applyCommand(project, { type: 'step.final', stepId: final, value: false }); assert.equal(finalAssembly(project), undefined); assert.equal(project.steps.length, 3);
});

test('support removal is reversible and retains the authored end pose across repeated toggles and source updates', () => {
  const old = parse3mf(transactionModel(), 'Demo Assembly.3mf'), project = emptyProject(old.model), part = project.model.parts[1];
  const stepId = applyCommand(project, { type: 'step.add', parts: [part.id] })!, step = findStep(project, stepId);
  step.frames[0].poses[part.id].position = [19, 20, 21]; step.frames[1].poses[part.id].position = [26, 27, 28];
  const before = copy(step.frames); applyCommand(project, { type: 'step.final', stepId, value: true });
  applyCommand(project, { type: 'part.remove', stepId, partIds: [part.id], value: true });
  applyCommand(project, { type: 'part.remove', stepId, partIds: [part.id], value: true });
  applyCommand(project, { type: 'step.final', stepId, value: true });
  assert.ok(finalAssembly(project)!.frames[1].hidden.includes(part.id));
  applyCommand(project, { type: 'part.remove', stepId, partIds: [part.id], value: false });
  applyCommand(project, { type: 'step.final', stepId, value: true });
  assert.deepEqual(step.frames, before); assert.equal(step.removalRestore, undefined); assert.deepEqual(finalAssembly(project)!.frames[1].poses[part.id].position, [26, 27, 28]);
  applyCommand(project, { type: 'part.remove', stepId, partIds: [part.id], value: true });
  const incoming = copy(project.model); incoming.id = 'moved-source'; incoming.parts.forEach(item => { item.home.position[0] += 5; });
  const plan = planSync(project, incoming, () => old.binary), updated = applySync(project, plan, () => old.binary);
  applyCommand(updated, { type: 'part.remove', stepId, partIds: [part.id], value: false });
  assert.deepEqual(findStep(updated, stepId).frames[1].poses[part.id].position, [31, 27, 28]);
  assert.deepEqual(finalAssembly(updated)!.frames[1].poses[part.id].position, [31, 27, 28]);
});

test('Final refresh tracks the changed Fusion baseline without adding new parts to ordinary operations', () => {
  const old = parse3mf(transactionModel(), 'Old.3mf'), incoming = parse3mf(transactionModel(['Shell', 'Support', 'New body']), 'New.3mf');
  old.model.source = { kind: 'fusion', fileId: 'demo-assembly', version: 3, archiveFile: '/old.f3d', documentName: 'Demo Assembly' };
  incoming.model.source = { ...old.model.source, version: 4, archiveFile: '/new.f3d' };
  const project = emptyProject(old.model), stepId = applyCommand(project, { type: 'step.add', parts: [old.model.parts[0].id] })!;
  const summaryId = applyCommand(project, { type: 'step.final', stepId, value: true })!, original = copy(project.steps[0]);
  const reader = (part: typeof old.model.parts[number]): Uint8Array => part.geometry.file === old.model.parts[0].geometry.file ? old.binary : incoming.binary;
  const synced = applySync(project, planSync(project, incoming.model, reader, { [incoming.model.parts[2].id]: 'new' }), reader);
  assert.deepEqual(synced.steps[0], original); assert.equal(finalAssembly(synced)!.id, summaryId);
  assert.deepEqual(finalAssembly(synced)!.partIds, synced.model.parts.map(part => part.id)); assert.equal(finalAssembly(synced)!.partIds.length, 3);
  assert.deepEqual(validateProject(synced), []);
});

test('picker drafts retain manual checks and group poses, and commit the final selection in one batch', () => {
  const project = emptyProject(parse3mf(transactionModel(), 'Demo Assembly.3mf').model), [shell, support, unused, extra] = project.model.parts;
  const first = applyCommand(project, { type: 'step.add', parts: [shell.id, support.id] })!;
  findStep(project, first).frames[1].poses[shell.id].position = [40, 50, 60];
  const target = applyCommand(project, { type: 'step.add', parts: [unused.id] })!, original = copy(project);
  const draft = createPickerDraft(project, target); draft.ids.add(extra.id); stagePickerAssembly(project, draft, first); draft.ids.delete(support.id);
  assert.deepEqual(project, original); assert.ok(draft.ids.has(extra.id));
  const commands = pickerCommands(project, draft); assert.equal(commands.length, 2); commands.forEach(command => applyCommand(project, command));
  const result = findStep(project, target); assert.deepEqual(new Set(result.partIds), new Set([unused.id, extra.id, shell.id]));
  assert.deepEqual(result.groups[0].partIds, [shell.id]); assert.deepEqual(result.frames[0].poses[shell.id].position, [40, 50, 60]);
  assert.deepEqual(pickerCommands(project, createPickerDraft(project, target)), []);
});
