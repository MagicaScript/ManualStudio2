import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCommand, emptyProject } from '../shared/document.ts';
import { applySync, planSync } from '../server/sync.ts';
import { fusionJob, fusionStatus, queueFusion, setFusionOrigin } from '../server/fusion.ts';
import type { Model } from '../shared/types.ts';

function model(id: string): Model {
  return { id, name: 'Native Assembly', sourceFile: 'Native Assembly.f3d', revision: 1, importedAt: '', materials: ['#eeeeee'], materialNames: ['ABS (White)'],
    source: { kind: 'fusion', fileId: 'cloud-file', version: 6, archiveFile: `/models/${id}/source.f3d`, documentName: 'Native Assembly' },
    parts: [{ id: `part-${id}`, name: 'Bracket', sourceName: 'Bracket', objectName: 'Bracket:1', objectId: 'occurrence', path: 'Bracket:1/Bracket', sourceKey: 'persistent-body', sourceObject: 'body', nativeToken: 'body-token', occurrenceToken: 'occurrence-token', geometry: { file: `/models/${id}/geometry.bin`, offset: 0, vertices: 3, triangles: 1 }, home: { position: [5, 6, 7], quaternion: [0, 0, 0, 1] }, bounds: [[4, 5, 7], [6, 7, 7]], color: '#eeeeee', material: 0, materialName: 'ABS Plastic', appearanceName: 'ABS (White)', sourceStatus: 'active', initiallyAssembled: false }],
    constructionAxes: [{ id: 'axis-hinge', name: 'Hinge axis', componentPath: 'Bracket:1', nativeToken: 'axis-token', origin: [5, 6, 7], direction: [0, 1, 0], extent: [-10, 10], visible: true, partIds: [`part-${id}`] }] };
}
const bytes = new Uint8Array(48); new Float32Array(bytes.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]); new Uint32Array(bytes.buffer, 36, 3).set([0, 1, 2]);

test('native synchronization retains the authored origin, frames, material names and axis owners', () => {
  const previous = model('old'); setFusionOrigin(previous, [0, -30, 200]); const project = emptyProject(previous);
  const stepId = applyCommand(project, { type: 'step.add', parts: [previous.parts[0].id] })!; const step = project.steps[0];
  const camera = { eye: [100, -100, 300] as [number, number, number], target: [0, 0, 200] as [number, number, number], up: [0, 0, 1] as [number, number, number], margin: 1.2 };
  applyCommand(project, { type: 'frame.update', stepId, frameId: step.frames[0].id, patch: { camera } });
  const next = model('new'); next.parts[0].name = 'Renamed bracket'; setFusionOrigin(next, [0, -30, 200]);
  const plan = planSync(project, next, () => bytes); const result = applySync(project, plan, () => bytes);
  assert.deepEqual(result.steps, project.steps); assert.equal(result.model.parts[0].id, previous.parts[0].id);
  assert.equal(result.model.parts[0].materialName, 'ABS Plastic'); assert.equal(result.model.parts[0].appearanceName, 'ABS (White)');
  assert.deepEqual(result.model.constructionAxes![0].partIds, [previous.parts[0].id]); assert.deepEqual(result.model.constructionAxes![0].origin, [5, -24, 207]);
  setFusionOrigin(result.model, [0, -30, 200]); assert.deepEqual(result.model.parts[0].home.position, [5, -24, 207]);
});

test('Fusion jobs require a live reader and transfer native identities for future name updates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'manualstudio-fusion-'));
  try {
    assert.equal((await fusionStatus(directory)).connected, false);
    await assert.rejects(queueFusion(directory, 'cloud-file'), /Start ManualStudio Bridge/);
    await mkdir(path.join(directory, 'fusion'), { recursive: true }); await writeFile(path.join(directory, 'fusion/bridge.json'), JSON.stringify({ connected: true, updatedAt: new Date().toISOString() }));
    const project = emptyProject(model('old')); const job = await queueFusion(directory, 'cloud-file', project);
    const loaded = await fusionJob(directory, job.id); assert.equal(loaded.status.state, 'queued');
    const request = JSON.parse(await readFile(path.join(loaded.folder, 'request.json'), 'utf8'));
    assert.equal(request.knownParts[0].nativeToken, 'body-token'); assert.equal(request.knownAxes[0].id, 'axis-hinge');
    await writeFile(path.join(loaded.folder, 'status.json'), JSON.stringify({ state: 'complete', parts: 1, axes: 1 })); assert.equal((await fusionJob(directory, job.id)).status.state, 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
