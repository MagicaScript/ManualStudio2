import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, copy, emptyProject, finalAssembly, findStep, frameQueue, validateProject } from '../shared/document.ts';
import type { Command } from '../shared/types.ts';
import { parse3mf } from '../server/import-3mf.ts';
import { transactionModel } from './fixtures/assembly-transaction.ts';

function fixture() {
  const project = emptyProject(parse3mf(transactionModel(), 'Merged assemblies.3mf').model), [shell, support, unused, extra] = project.model.parts;
  const first = findStep(project, applyCommand(project, { type: 'step.add', name: 'First operation', parts: [shell.id, support.id] })!);
  const second = findStep(project, applyCommand(project, { type: 'step.add', name: 'Second operation', parts: [support.id, unused.id] })!);
  const third = findStep(project, applyCommand(project, { type: 'step.add', name: 'Third operation', parts: [extra.id] })!);
  first.frames[0].poses[support.id].position = [1, 2, 3]; first.frames[1].poses[support.id].position = [4, 5, 6];
  second.frames[0].poses[support.id].position = [20, 30, 40]; second.frames[1].poses[support.id].position = [50, 60, 70];
  first.frames[0].notes.push({ id: 'source-note', kind: 'text', text: 'Keep this source annotation', color: '#eee', background: '#333', size: 3, offset: [10, 20], anchors: [{ partId: shell.id, point: [0, 0, 0], normal: [0, 0, 1], triangle: 0, target: 'point' }] });
  applyCommand(project, { type: 'frame.add', stepId: first.id, afterId: first.frames[0].id });
  project.settings.showLabels = false; project.settings.labelOffsets[shell.id] = [123, 456];
  return { project, first, second, third, shell, support, unused, extra };
}

test('native partial card merge adds endpoints after the last checked card, keeping every source record', () => {
  const { project, first, second, third, support } = fixture(), original = copy(project);
  const id = applyCommand(project, { type: 'step.merge', stepIds: [second.id, first.id] })!, merged = findStep(project, id);
  assert.deepEqual(project.steps.map(step => step.id), [first.id, second.id, id, third.id]);
  assert.deepEqual(project.steps.filter(step => step.id !== id), original.steps); assert.deepEqual(project.model, original.model); assert.deepEqual(project.settings, original.settings);
  assert.equal(merged.name, 'Merged Step'); assert.equal(merged.final, false); assert.equal(merged.frames.length, 2); assert.deepEqual(merged.frames.map(frame => frame.notes), [[], []]);
  assert.deepEqual(merged.frames[0].poses[support.id].position, [20, 30, 40]); assert.deepEqual(merged.frames[1].poses[support.id].position, [50, 60, 70]);
  for (const frame of merged.frames) { assert.ok(frame.camera); assert.equal(frame.labels?.showLabels, true); assert.deepEqual(frame.labels?.labelOffsets, {}); }
  assert.deepEqual(validateProject(project), []); assert.equal(frameQueue(project).length, 9);
  assert.throws(() => applyCommand(project, { type: 'step.merge', stepIds: [id] }), /at least two/);
});

test('full coverage merge retains composite Start and End in the single editable Final', () => {
  const { project, first, second, third, support } = fixture(), original = copy(project);
  const id = applyCommand(project, { type: 'step.merge', stepIds: [third.id, second.id, first.id] })!, final = finalAssembly(project)!;
  assert.equal(final.id, id); assert.equal(final.partIds.length, 4); assert.deepEqual(project.steps.slice(0, -1), original.steps); assert.deepEqual(project.settings, original.settings);
  assert.deepEqual(final.frames[0].poses[support.id].position, [20, 30, 40]); assert.deepEqual(final.frames[1].poses[support.id].position, [50, 60, 70]);
  const nativeHome = copy(support.home), transitionId = applyCommand(project, { type: 'frame.add', stepId: id, afterId: final.frames[0].id })!;
  applyCommand(project, { type: 'frame.update', stepId: id, frameId: transitionId, patch: { poses: { ...final.frames[1].poses, [support.id]: { position: [30, 40, 50], quaternion: [0, 0, 0, 1] } } } });
  applyCommand(project, { type: 'frame.update', stepId: id, frameId: final.frames.at(-1)!.id, patch: { poses: { ...final.frames.at(-1)!.poses, [support.id]: { position: [90, 80, 70], quaternion: [0, 0, 0, 1] } } } });
  assert.deepEqual(support.home, nativeHome); assert.deepEqual(support.assemblyHome?.position, [90, 80, 70]); assert.deepEqual(project.steps.slice(0, -1), original.steps);
  const initial = copy(final.frames[0]), transition = copy(final.frames[1]);
  applyCommand(project, { type: 'step.final', stepId: id, value: true });
  assert.deepEqual(final.frames[0], initial); assert.deepEqual(final.frames[1], transition); assert.deepEqual(final.frames.at(-1)!.poses[support.id].position, [50, 60, 70]);
  applyCommand(project, { type: 'note.put', stepId: id, frameId: transitionId, note: { id: 'final-annotation', kind: 'text', text: 'Preserve this Final authoring', color: '#eee', background: '#333', size: 3, offset: [5, 6], anchors: [{ partId: support.id, point: [0, 0, 0], normal: [0, 0, 1], triangle: 0, target: 'point' }] } });
  const previousFinal = copy(final), newId = applyCommand(project, { type: 'step.merge', stepIds: [first.id, second.id, third.id] }); assert.notEqual(newId, id);
  assert.equal(project.steps.length, 5); assert.equal(finalAssembly(project)!.frames.length, 2); assert.deepEqual(project.steps.slice(0, 3), original.steps);
  assert.deepEqual(findStep(project, id), { ...previousFinal, final: false }); assert.equal(project.steps.filter(step => step.final).length, 1);
});

test('add, copy and partial merge accept ordinary step 255 and reject step 256', () => {
  const { project, first, second } = fixture();
  while (project.steps.length < 254) applyCommand(project, { type: 'step.add' });
  const final = applyCommand(project, { type: 'step.final', stepId: first.id, value: true });
  const commands: Command[] = [
    { type: 'step.add' },
    { type: 'step.copy', stepId: first.id },
    { type: 'step.merge', stepIds: [first.id, second.id] },
  ];
  for (const command of commands) {
    const draft = copy(project);
    assert.ok(applyCommand(draft, command));
    assert.equal(draft.steps.length, 256);
    assert.equal(draft.steps.at(-1)?.id, final);
    const atCapacity = copy(draft);
    assert.throws(() => applyCommand(draft, command), /No more than 255 assembly steps/);
    assert.deepEqual(draft, atCapacity);
  }
});

test('a full merge can create Final at the limit but cannot demote a previous Final', () => {
  const { project, first, second, third } = fixture();
  while (project.steps.length < 255) applyCommand(project, { type: 'step.add' });
  const merge: Command = { type: 'step.merge', stepIds: [first.id, second.id, third.id] };
  const id = applyCommand(project, merge);
  assert.equal(project.steps.at(-1)?.id, id);
  assert.equal(project.steps.at(-1)?.final, true);
  assert.equal(project.steps.length, 256);
  const original = copy(project);
  assert.throws(() => applyCommand(project, merge), /Preserving the previous Final.*maximum 255/);
  assert.deepEqual(project, original);
});
