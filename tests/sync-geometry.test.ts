import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyProject, findStep } from '../shared/document.ts';
import { applySync, identicalGeometry, planSync } from '../server/sync.ts';
import type { Model, Part, Vec3 } from '../shared/types.ts';

function mesh(file: string, positions: number[], indices: number[], normals?: number[]): { part: Part; bytes: Uint8Array } {
  const vertices = positions.length / 3, buffer = new ArrayBuffer((positions.length + indices.length + (normals?.length ?? 0)) * 4);
  new Float32Array(buffer, 0, positions.length).set(positions); new Uint32Array(buffer, positions.length * 4, indices.length).set(indices);
  if (normals) new Float32Array(buffer, (positions.length + indices.length) * 4, normals.length).set(normals);
  const part: Part = { id: file, name: 'Panel', sourceName: 'Panel', sourceKey: 'native-panel', objectName: 'Assembly', objectId: 'assembly', sourceObject: 'panel', path: 'Assembly/Panel',
    geometry: { file, offset: 0, vertices, triangles: indices.length / 3, ...(normals ? { normalsOffset: (positions.length + indices.length) * 4 } : {}) },
    home: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, bounds: [[-1, -1, 0], [1, 1, 0]], color: '#ffffff', material: 0, sourceStatus: 'active', initiallyAssembled: false };
  return { part, bytes: new Uint8Array(buffer) };
}
const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], indices = [0, 1, 2, 0, 2, 3], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
function model(part: Part): Model { return { id: part.geometry.file, name: 'Assembly', sourceFile: 'Assembly.f3d', revision: 1, importedAt: '', parts: [part], materials: ['#ffffff'] }; }

test('equivalent vertex and oriented triangle permutations retain painted triangle bindings and update source metadata', () => {
  const old = mesh('/old.bin', positions, indices, normals);
  const fresh = mesh('/new.bin', [1, 1, 0, -1, -1, 0, -1, 1, 0, 1, -1, 0], [0, 2, 1, 0, 1, 3], normals);
  fresh.part.name = fresh.part.sourceName = 'Renamed Panel'; fresh.part.materialName = 'ABS Plastic'; fresh.part.nativeRevision = 'new-native-revision';
  const read = (part: Part): Uint8Array => part.geometry.file === old.part.geometry.file ? old.bytes : fresh.bytes;
  const project = emptyProject(model(old.part)); const step = findStep(project, applyCommand(project, { type: 'step.add', parts: [old.part.id] })!);
  const point: Vec3 = [.25, -.5, 0];
  applyCommand(project, { type: 'note.put', stepId: step.id, frameId: step.frames[0].id, note: { id: 'paint', kind: 'glue', text: 'Bond this face', color: '#8c91b5', background: '#30343c', size: 3, offset: [20, -30], anchors: [{ partId: old.part.id, triangle: 0, point, normal: [0, 0, 1], target: 'face', region: { kind: 'face', triangles: [0], center: point, normal: [0, 0, 1], radius: 3, axis: [0, 0, 1], width: 1 } }] } });
  const before = structuredClone(project.steps), plan = planSync(project, model(fresh.part), read);
  assert.equal(plan.matches[0].geometryChanged, false);
  const updated = applySync(project, plan, read);
  assert.deepEqual(updated.steps, before);
  assert.deepEqual(updated.model.parts[0].geometry, old.part.geometry);
  assert.equal(updated.model.parts[0].id, old.part.id);
  assert.equal(updated.model.parts[0].name, 'Renamed Panel');
  assert.equal(updated.model.parts[0].materialName, 'ABS Plastic');
  assert.equal(updated.model.parts[0].nativeRevision, 'new-native-revision');
});

test('geometry equivalence rejects changed shape, winding, normals and connectivity', () => {
  const old = mesh('/old.bin', positions, indices, normals);
  const changedShape = positions.map((value, index) => index === 2 ? .02 : value);
  const changedNormals = normals.map((value, index) => index % 3 === 2 ? -value : value);
  const cases = [mesh('/shape.bin', changedShape, indices, normals), mesh('/winding.bin', positions, [0, 2, 1, 0, 3, 2], normals),
    mesh('/normals.bin', positions, indices, changedNormals), mesh('/connectivity.bin', positions, [0, 1, 3, 1, 2, 3], normals)];
  for (const changed of cases) assert.equal(identicalGeometry(old.part, changed.part, part => part.geometry.file === old.part.geometry.file ? old.bytes : changed.bytes), false, changed.part.geometry.file);
});

test('native float noise retains existing comparison tolerances without discarding significant normal changes', () => {
  const old = mesh('/old.bin', positions, indices, normals), perturbed = mesh('/noise.bin', positions.map(value => value + .00001), indices, normals.map((value, index) => index === 0 ? 1e-14 : value));
  assert.equal(identicalGeometry(old.part, perturbed.part, part => part.geometry.file === old.part.geometry.file ? old.bytes : perturbed.bytes), true);
});

test('reordered meshes without supplied normals still preserve winding', () => {
  const old = mesh('/old.bin', positions, indices), fresh = mesh('/new.bin', [1, 1, 0, -1, -1, 0, -1, 1, 0, 1, -1, 0], [0, 2, 1, 0, 1, 3]);
  assert.equal(identicalGeometry(old.part, fresh.part, part => part.geometry.file === old.part.geometry.file ? old.bytes : fresh.bytes), true);
});
