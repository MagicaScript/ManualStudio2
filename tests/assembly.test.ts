import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parse3mf } from '../server/import-3mf.ts';
import { applyCommand, assemblySnapshot, emptyProject, explodedPoses, findStep, interpolateFrames, teardownPoses, validateProject } from '../shared/document.ts';
import { applySync, planSync } from '../server/sync.ts';

function fixture(names = ['Housing', 'Support'], units = 'millimeter', uuid = true): Uint8Array {
  const objects = names.map((name, i) => `<object id="${i + 1}" name="${name}" ${uuid ? `p:UUID="part-${i + 1}"` : ''}><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${i + 2}" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>`).join('');
  return zipSync({ '3D/3dmodel.model': strToU8(`<model unit="${units}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>${objects}</resources><build>${names.map((_, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${i * 5} 0 0"/>`).join('')}</build></model>`) });
}
test('assembly operations retain finished groups and remove printed supports at the end frame', () => {
  const imported = parse3mf(fixture(), 'Model.3mf'); const project = emptyProject(imported.model); const [part, support] = project.model.parts;
  applyCommand(project, { type: 'part.initial', partIds: [part.id, support.id], value: true });
  const firstId = applyCommand(project, { type: 'step.add', name: 'Remove support', parts: [part.id, support.id] })!;
  const first = findStep(project, firstId); assert.deepEqual(first.frames[0].poses[part.id], part.home);
  applyCommand(project, { type: 'part.remove', stepId: firstId, partIds: [support.id], value: true });
  assert.equal(first.frames[0].hidden.includes(support.id), false); assert.equal(first.frames.at(-1)!.hidden.includes(support.id), true);
  assert.deepEqual(assemblySnapshot(first).partIds, [part.id]);
  const nextId = applyCommand(project, { type: 'step.copy', stepId: firstId, inherit: true })!; const next = findStep(project, nextId);
  assert.deepEqual(next.partIds, [part.id]); assert.equal(next.groups[0].sourceStepId, firstId); assert.deepEqual(next.frames[0].poses[part.id], first.frames.at(-1)!.poses[part.id]);
  const frameId = applyCommand(project, { type: 'frame.add', stepId: nextId, afterId: next.frames[0].id })!; assert.equal(next.frames.length, 3);
  applyCommand(project, { type: 'frame.delete', stepId: nextId, frameId }); assert.equal(next.frames.length, 2);
  assert.throws(() => applyCommand(project, { type: 'frame.delete', stepId: nextId, frameId: next.frames[0].id }), /required/);
  assert.deepEqual(validateProject(project), []);
});
test('keyframe interpolation moves parts and hides removed parts only at the endpoint', () => {
  const imported = parse3mf(fixture(), 'Model.3mf'); const project = emptyProject(imported.model); const part = project.model.parts[0];
  const step = findStep(project, applyCommand(project, { type: 'step.add', parts: [part.id] })!);
  step.frames[0].poses[part.id].position = [0, 0, 10]; step.frames[1].poses[part.id].position = [0, 0, 0]; step.frames[1].hidden = [part.id];
  assert.deepEqual(interpolateFrames(step.frames[0], step.frames[1], .5).poses[part.id].position, [0, 0, 5]);
  assert.deepEqual(interpolateFrames(step.frames[0], step.frames[1], .5).hidden, []); assert.deepEqual(interpolateFrames(step.frames[0], step.frames[1], 1).hidden, [part.id]);
});
test('3MF unit conversion and Bambu assembly transforms override print placement', () => {
  const imported = parse3mf(fixture(['Part'], 'inch'), 'inch.3mf'); assert.equal(imported.model.parts[0].bounds[1][0], 50.8);
  const xml = `<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="2" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object><object id="2"><components><component objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 200 300"/></build></model>`;
  const config = `<config><object id="2"><metadata key="name" value="Panel"/><part id="1" uuid="stable-plate"><metadata key="name" value="Panel A"/></part></object><assemble><assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 10"/><assemble_item object_id="2" volume_id="0" transform="1 0 0 0 1 0 0 0 1 5 6 7"/></assemble></config>`;
  const bambu = parse3mf(zipSync({ '3D/3dmodel.model': strToU8(xml), 'Metadata/model_settings.config': strToU8(config) }), 'Bambu.3mf');
  assert.deepEqual(bambu.model.parts[0].home.position, [6, 7, 17]); assert.equal(bambu.model.parts[0].name, 'Panel A'); assert.equal(bambu.model.parts[0].sourceKey, 'stable-plate');
  assert.deepEqual(bambu.model.parts[0].explosionOffset, [5, 6, 7]);
  const project = emptyProject(bambu.model), id = applyCommand(project, { type: 'step.add', parts: [bambu.model.parts[0].id] })!;
  const step = findStep(project, id); assert.deepEqual(explodedPoses(project, step, 1)[step.partIds[0]].position, [11, 13, 24]);
  assert.deepEqual(explodedPoses(project, step, 2)[step.partIds[0]].position, [16, 19, 31]);
});

test('auto teardown uses six axis packing and keeps inherited assemblies fixed', () => {
  const project = emptyProject(parse3mf(fixture(), 'Two parts.3mf').model); const [first, second] = project.model.parts;
  const step = findStep(project, applyCommand(project, { type: 'step.add', parts: [first.id, second.id] })!);
  const poses = teardownPoses(project, step);
  assert.deepEqual(poses[first.id].position, [-6, .5, .5]); assert.deepEqual(poses[second.id].position, [14.5, .5, .5]);
  step.groups.push({ id: 'installed', name: 'Installed assembly', partIds: [first.id], sourceStepId: 'previous', poses: { [first.id]: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } } });
  assert.deepEqual(teardownPoses(project, step)[first.id], step.groups[0].poses[first.id]);
});
test('model sync renames matching identities, retains deleted step geometry and leaves step definitions intact', () => {
  const old = parse3mf(fixture(), 'old.3mf'), fresh = parse3mf(fixture(['Renamed housing']), 'new.3mf'); const project = emptyProject(old.model);
  const stepId = applyCommand(project, { type: 'step.add', name: 'Assembly', parts: old.model.parts.map(p => p.id) })!; const snapshot = structuredClone(project.steps);
  const reader = (part: typeof old.model.parts[number]): Uint8Array => part.geometry.file.includes(old.model.id) ? old.binary : fresh.binary;
  const plan = planSync(project, fresh.model, reader); assert.equal(plan.matches.length, 1); assert.equal(plan.removed.length, 1); assert.equal(plan.unresolved.length, 0);
  const updated = applySync(project, plan, reader); assert.equal(updated.model.parts[0].name, 'Renamed housing'); assert.equal(updated.model.parts[0].id, old.model.parts[0].id); assert.equal(updated.model.parts[1].sourceStatus, 'removed');
  assert.deepEqual(updated.steps, snapshot); assert.equal(findStep(updated, stepId).frames.length, 2); assert.deepEqual(validateProject(updated), []);
  assert.throws(() => applySync({ ...project, revision: 2 }, plan, reader), /changed/);
});
test('surface notes remain attached to a part and are removed when its step membership is removed', () => {
  const project = emptyProject(parse3mf(fixture(), 'model.3mf').model); const part = project.model.parts[0]; const step = findStep(project, applyCommand(project, { type: 'step.add', parts: [part.id] })!);
  applyCommand(project, { type: 'note.put', stepId: step.id, frameId: step.frames[0].id, note: { id: 'note-one', kind: 'glue', text: 'Glue three bands', color: '#00ff00', background: '#333333', size: 4, offset: [10, -10], anchors: [-3, 0, 3].map(z => ({ partId: part.id, point: [0, 0, z], normal: [1, 0, 0], triangle: 0, target: 'band', region: { kind: 'band', triangles: [0, 1], center: [0, 0, z], normal: [1, 0, 0], radius: 2, axis: [0, 0, 1], width: 1 } })) } });
  assert.equal(step.frames[0].notes[0].anchors.length, 3); applyCommand(project, { type: 'step.members', stepId: step.id, partIds: [] }); assert.equal(step.frames[0].notes.length, 0); assert.deepEqual(validateProject(project), []);
});
test('retessellation rebinds a painted face to its connected triangles while retaining region dimensions', () => {
  const make = (subdivide: boolean): Uint8Array => zipSync({ '3D/3dmodel.model': strToU8(`<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="1" name="Panel" p:UUID="stable-panel"><mesh><vertices><vertex x="-5" y="-5" z="0"/><vertex x="5" y="-5" z="0"/><vertex x="5" y="5" z="0"/><vertex x="-5" y="5" z="0"/>${subdivide ? '<vertex x="0" y="0" z="0"/>' : ''}</vertices><triangles>${subdivide ? '<triangle v1="0" v2="1" v3="4"/><triangle v1="1" v2="2" v3="4"/><triangle v1="2" v2="3" v3="4"/><triangle v1="3" v2="0" v3="4"/>' : '<triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="2" v3="3"/>'}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`) });
  const old = parse3mf(make(false), 'old.3mf'), fresh = parse3mf(make(true), 'new.3mf'); const project = emptyProject(old.model); const part = project.model.parts[0]; const step = findStep(project, applyCommand(project, { type: 'step.add', parts: [part.id] })!);
  applyCommand(project, { type: 'note.put', stepId: step.id, frameId: step.frames[0].id, note: { id: 'glue-face', kind: 'glue', text: 'Bond', color: '#00ff00', background: '#333333', size: 3, offset: [0, 0], anchors: [{ partId: part.id, point: [0, 0, 0], normal: [0, 0, 1], target: 'face', triangle: 0, region: { kind: 'circle', triangles: [0, 1], center: [0, 0, 0], normal: [0, 0, 1], radius: 3, axis: [0, 0, 1], width: 2 } }] } });
  const read = (p: typeof part): Uint8Array => p.geometry.file.includes(old.model.id) ? old.binary : fresh.binary;
  const result = applySync(project, planSync(project, fresh.model, read), read); const anchor = result.steps[0].frames[0].notes[0].anchors[0]; assert.equal(anchor.region?.triangles.length, 4); assert.equal(anchor.region?.radius, 3); assert.equal(anchor.needsReview, true); assert.equal(result.steps[0].id, step.id);
});
