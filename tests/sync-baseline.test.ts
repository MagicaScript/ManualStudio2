import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, copy, emptyProject, validateProject } from '../shared/document.ts';
import { modelVisibility, nodeAxisIds, nodePartIds } from '../shared/model-tree.ts';
import { applySync, planSync } from '../server/sync.ts';
import type { Model, Note, Part } from '../shared/types.ts';

const bytes = new Uint8Array(48);
new Float32Array(bytes.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
new Uint32Array(bytes.buffer, 36, 3).set([0, 1, 2]);

function model(tag: string, version: number, names: string[]): Model {
  const parts: Part[] = names.map(name => ({
    id: `${tag}-${name}`, name, sourceName: name, sourceKey: `body-${name}`, nativeToken: `token-${name}`,
    objectId: `component-${name}`, objectName: `${name}:1`, path: `${name}:1/${name}`, sourceObject: name,
    geometry: { file: `/models/${tag}/geometry.bin`, offset: 0, vertices: 3, triangles: 1 },
    home: { position: [5, 6, 7], quaternion: [0, 0, 0, 1] }, bounds: [[5, 6, 7], [6, 7, 7]],
    color: '#eeeeee', material: 0, sourceStatus: 'active', initiallyAssembled: false,
  }));
  return {
    id: tag, name: `Demo Assembly v${version}`, sourceFile: `Demo Assembly v${version}.f3d`, revision: 1, importedAt: '', parts, materials: ['#eeeeee'],
    source: { kind: 'fusion', fileId: 'demo-assembly-cloud-file', version, documentName: `Demo Assembly v${version}`, archiveFile: `/models/${tag}/source.f3d` },
    constructionAxes: parts.map(part => ({ id: `axis-${part.sourceName}`, name: `${part.sourceName} axis`, componentPath: part.objectName, nativeToken: `axis-token-${part.sourceName}`, origin: [5, 6, 7], direction: [0, 0, 1], extent: [-2, 2], visible: true, partIds: [part.id] })),
    browserTree: parts.map(part => ({ id: `object:${part.objectId}`, name: part.objectName, kind: 'object', visible: true, children: [
      { id: `part:${part.id}`, name: part.name, kind: 'part', partId: part.id, visible: true },
      { id: `axis:axis-${part.sourceName}`, name: `${part.sourceName} axis`, kind: 'axis', axisId: `axis-${part.sourceName}`, visible: true },
    ] })),
  };
}

function note(id: string, partIds: string[]): Note {
  return { id, kind: 'glue', text: id, color: '#8c91b5', background: '#333438', size: 3, offset: [10, -20],
    anchors: partIds.map(partId => ({ partId, point: [0, 0, 0], normal: [0, 0, 1], target: 'point', triangle: 0 })) };
}

test('same-version native metadata refresh retains authored axis and object names', () => {
  const project = emptyProject(model('saved', 3, ['Shell', 'Support']));
  project.model.source!.versionId = 'native-version-3';
  applyCommand(project, { type: 'axis.rename', axisId: 'axis-Shell', name: 'Shell alignment axis' });
  applyCommand(project, { type: 'object.rename', nodeId: 'object:component-Shell', name: 'Cover assembly' });
  const refreshed = model('refresh', 3, ['Shell', 'Support']);
  refreshed.source!.versionId = 'native-version-3';
  refreshed.constructionAxes![0].name = 'Shell axis from Fusion';
  refreshed.browserTree![0].children![1].name = 'Shell axis from Fusion';
  refreshed.browserTree![1].name = 'Support occurrence from Fusion';
  const read = () => bytes;
  const next = applySync(project, planSync(project, refreshed, read), read);
  assert.equal(next.model.constructionAxes![0].name, 'Shell alignment axis');
  assert.equal(next.model.constructionAxes![0].sourceName, 'Shell axis from Fusion');
  assert.equal(next.model.browserTree![0].name, 'Cover assembly');
  assert.equal(next.model.browserTree![0].children![1].name, 'Shell alignment axis');
  assert.equal(next.model.browserTree![1].name, 'Support occurrence from Fusion');

  const newBaseline = model('new-baseline', 4, ['Shell', 'Support']);
  newBaseline.source!.versionId = 'native-version-4';
  const advanced = applySync(next, planSync(next, newBaseline, read), read);
  assert.equal(advanced.model.constructionAxes![0].name, 'Shell axis');
  assert.equal(advanced.model.browserTree![0].name, 'Shell:1');
});

test('a changed Fusion version replaces the inventory and only removes references to deleted parts', () => {
  const old = model('old', 3, ['Shell', 'Support', 'Retired']);
  const [shell, support, retired] = old.parts; retired.sourceStatus = 'removed'; shell.name = 'Authored shell name';
  const project = emptyProject(old);
  const firstId = applyCommand(project, { type: 'step.add', name: 'Remove support', parts: [shell.id, support.id] })!;
  const first = project.steps[0];
  applyCommand(project, { type: 'part.remove', stepId: firstId, partIds: [support.id], value: true });
  first.description = 'Preserve this authored description.';
  first.frames[0].duration = 3;
  first.frames[0].xrayPartIds = [shell.id, support.id];
  first.frames[0].notes = [note('shell-note', [shell.id]), note('support-note', [support.id]), note('joint-note', [shell.id, support.id])];
  first.groups = [
    { id: 'shell-group', name: 'Assembly', partIds: [shell.id, support.id], poses: copy(first.frames[0].poses) },
    { id: 'support-group', name: 'Support', partIds: [support.id], poses: { [support.id]: copy(support.home) } },
  ];
  applyCommand(project, { type: 'step.add', name: 'Support detail', parts: [support.id] });
  applyCommand(project, { type: 'step.add', name: 'Finish shell', parts: [shell.id] });
  const unaffected = copy(project.steps[2]);
  project.settings.partVisibility = { [shell.id]: false, [support.id]: true };
  project.settings.objectVisibility = { 'object:component-Shell': true, 'object:component-Support': false };
  project.settings.constructionAxisVisibility = { 'axis-Shell': false, 'axis-Support': true };
  project.settings.showConstructionAxes = false;
  project.settings.labelOffsets = { [shell.id]: [1, 2], [support.id]: [3, 4], 'shell-group': [5, 6], 'support-group': [7, 8] };
  project.settings.hiddenLabels = [shell.id, support.id];
  const original = copy(project), incoming = model('next', 4, ['Shell']);
  const plan = planSync(project, incoming, () => bytes);
  assert.equal(plan.replacesBaseline, true);
  assert.deepEqual(plan.removed, [support.id, retired.id]);
  assert.deepEqual(plan.removedFromSteps, [
    { stepId: first.id, partIds: [support.id], noteIds: ['support-note', 'joint-note'] },
    { stepId: project.steps[1].id, partIds: [support.id], noteIds: [] },
  ]);
  const result = applySync(project, plan, () => bytes);
  assert.deepEqual(project, original);
  assert.equal(result.model.source?.version, 4);
  assert.deepEqual(result.model.parts.map(part => part.id), [shell.id]);
  assert.equal(result.model.parts[0].name, shell.name);
  assert.equal(result.model.parts[0].geometry.file, shell.geometry.file);
  assert.deepEqual(result.steps.map(step => step.id), original.steps.map(step => step.id));
  assert.deepEqual(result.steps.flatMap(step => step.frames.map(frame => frame.id)), original.steps.flatMap(step => step.frames.map(frame => frame.id)));
  assert.deepEqual(result.steps[2], unaffected);
  assert.deepEqual(result.steps[0].partIds, [shell.id]);
  assert.deepEqual(result.steps[0].removePartIds, []);
  assert.deepEqual(result.steps[0].frames[0].notes, [first.frames[0].notes[0]]);
  assert.deepEqual(result.steps[0].frames[0].poses, { [shell.id]: first.frames[0].poses[shell.id] });
  assert.equal(result.steps[0].frames[0].duration, 3);
  assert.deepEqual(result.steps[0].frames[0].xrayPartIds, [shell.id]);
  assert.equal(result.steps[0].description, first.description);
  assert.deepEqual(result.steps[0].frames[1].hidden, []);
  assert.deepEqual(result.steps[0].groups, [{ ...first.groups[0], partIds: [shell.id], poses: { [shell.id]: first.groups[0].poses[shell.id] } }]);
  assert.deepEqual(result.steps[1].partIds, []);
  assert.equal(result.steps[1].frames.length, 2);
  assert.deepEqual(result.settings.partVisibility, {});
  assert.deepEqual(result.settings.objectVisibility, {});
  assert.deepEqual(result.settings.constructionAxisVisibility, {});
  assert.equal(result.settings.showConstructionAxes, true);
  assert.deepEqual(result.settings.labelOffsets, { [shell.id]: [1, 2], 'shell-group': [5, 6] });
  assert.deepEqual(result.settings.hiddenLabels, [shell.id]);
  assert.deepEqual(result.model.browserTree?.flatMap(nodePartIds), [shell.id]);
  assert.deepEqual(result.model.browserTree?.flatMap(nodeAxisIds), ['axis-Shell']);
  assert.deepEqual(validateProject(result), []);

  const later = model('later', 5, ['Shell', 'Cover']);
  const nextPlan = planSync(result, later, () => bytes);
  const nextResult = applySync(result, nextPlan, () => bytes);
  assert.equal(nextPlan.replacesBaseline, true);
  assert.equal(nextResult.model.source?.version, 5);
  assert.deepEqual(nextResult.model.parts.map(part => part.id), [shell.id, later.parts[1].id]);
  assert.deepEqual(nextResult.steps, result.steps);
  assert.deepEqual(validateProject(nextResult), []);
});

test('same-version completeness repair adds hidden contents without replacing existing parts, axes or authored steps', () => {
  const old = model('old', 3, ['Shell', 'Support']), project = emptyProject(old);
  const [shell, support] = old.parts;
  old.browserTree![0].children![0].id = 'part:previous-import-shell';
  applyCommand(project, { type: 'step.add', name: 'Existing assembly', parts: [shell.id, support.id] });
  project.steps[0].frames[0].notes = [note('support-note', [support.id])];
  project.settings.partVisibility = { [shell.id]: false };
  project.settings.objectVisibility = { 'object:component-Support': false };
  project.settings.constructionAxisVisibility = { 'axis-Shell': false, 'axis-Support': true };
  project.settings.showConstructionAxes = false;
  const incoming = model('repair', 3, ['Shell', 'HiddenFixture']);
  incoming.browserTree![1].visible = false;
  const plan = planSync(project, incoming, () => bytes, { [incoming.parts[1].id]: 'new' });
  assert.equal(plan.replacesBaseline, false);
  assert.deepEqual(plan.removedFromSteps, []);
  const result = applySync(project, plan, () => bytes);
  assert.equal(result.model.source?.version, 3);
  assert.deepEqual(result.steps, project.steps);
  assert.deepEqual(result.settings, project.settings);
  assert.deepEqual(result.model.parts.map(part => part.id), [shell.id, incoming.parts[1].id, support.id]);
  assert.equal(result.model.parts.at(-1)?.sourceStatus, 'active');
  assert.deepEqual(result.model.constructionAxes?.map(axis => axis.id), ['axis-Shell', 'axis-HiddenFixture', 'axis-Support']);
  assert.deepEqual(result.model.browserTree?.flatMap(nodePartIds), [shell.id, incoming.parts[1].id, support.id]);
  assert.deepEqual(result.model.browserTree?.flatMap(nodeAxisIds), ['axis-Shell', 'axis-HiddenFixture', 'axis-Support']);
  assert.equal(result.model.browserTree![1].visible, false);
  assert.deepEqual(validateProject(result), []);
});

test('native version identity determines baseline replacement before numeric-version fallback', () => {
  const previous = model('old', 3, ['Shell', 'Support']), project = emptyProject(previous);
  previous.source!.versionId = 'version-token-3';
  const incoming = model('next', 3, ['Shell']); incoming.source!.versionId = 'version-token-4';
  assert.equal(planSync(project, incoming, () => bytes).replacesBaseline, true);
  incoming.source!.versionId = 'version-token-3'; incoming.source!.version = 4;
  assert.equal(planSync(project, incoming, () => bytes).replacesBaseline, false);
  delete incoming.source!.versionId;
  assert.equal(planSync(project, incoming, () => bytes).replacesBaseline, true);
  incoming.source!.fileId = 'unrelated-cloud-file'; incoming.source!.versionId = 'unrelated-version-token';
  const unrelated = planSync(project, incoming, () => bytes);
  assert.equal(unrelated.replacesBaseline, false);
  assert.equal(applySync(project, unrelated, () => bytes).model.parts.length, 2);
});

test('a new native baseline resets local eyes to Fusion body, component and axis defaults', () => {
  const previous = model('old', 3, ['Shown', 'HiddenBody', 'HiddenComponent']), project = emptyProject(previous);
  project.settings.partVisibility = Object.fromEntries(previous.parts.map(part => [part.id, part.sourceName !== 'Shown']));
  project.settings.objectVisibility = { 'object:component-Shown': false, 'object:component-HiddenBody': true, 'object:component-HiddenComponent': true };
  project.settings.constructionAxisVisibility = { 'axis-Shown': false, 'axis-HiddenBody': true, 'axis-HiddenComponent': true };
  project.settings.showConstructionAxes = false;
  const incoming = model('next', 4, ['Shown', 'HiddenBody', 'HiddenComponent']);
  incoming.browserTree![1].children![0].visible = false;
  incoming.constructionAxes![1].visible = false;
  incoming.browserTree![2].visible = false;
  const result = applySync(project, planSync(project, incoming, () => bytes), () => bytes);
  const visibility = modelVisibility(result);
  assert.deepEqual([...visibility.parts], [['old-Shown', true], ['old-HiddenBody', false], ['old-HiddenComponent', false]]);
  assert.deepEqual([...visibility.axes], [['axis-Shown', true], ['axis-HiddenBody', false], ['axis-HiddenComponent', false]]);
  assert.deepEqual(result.settings.partVisibility, {});
  assert.deepEqual(result.settings.objectVisibility, {});
  assert.deepEqual(result.settings.constructionAxisVisibility, {});
  assert.equal(result.settings.showConstructionAxes, true);
});
