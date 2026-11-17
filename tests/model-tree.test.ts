import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { emptyProject } from '../shared/document.ts';
import { browserRoots, findBrowserNode, modelVisibility, nodeAxisIds, nodeOwnVisibility, nodePartIds } from '../shared/model-tree.ts';
import { axisComponentTransform } from '../src/construction-axes.ts';
import type { ConstructionAxis, Model, Part } from '../shared/types.ts';

function part(id: string, objectName = 'Panel:1'): Part {
  return { id, name: id, sourceName: id, sourceObject: id, objectId: objectName, objectName, path: `${objectName}/${id}`, sourceStatus: 'active', initiallyAssembled: false,
    color: '#eeeeee', material: 0, geometry: { file: '/models/test/geometry.bin', offset: 0, vertices: 3, triangles: 1 }, home: { position: [10, 20, 30], quaternion: [0, 0, 0, 1] }, bounds: [[9, 19, 29], [11, 21, 31]] };
}
function model(): Model {
  const axis: ConstructionAxis = { id: 'hinge-axis', name: 'Hinge Axis', componentPath: 'Panel:1+Hinge:1', occurrenceToken: 'hinge-occurrence', nativeToken: 'hinge-reference', origin: [10, 20, 30], direction: [0, 0, 1], extent: [0, 8], visible: true, partIds: ['Hinge'] };
  return { id: 'model-test', name: 'Demo Assembly', sourceFile: 'Demo Assembly.f3d', revision: 1, importedAt: '', materials: ['#eeeeee'], parts: [part('Panel'), part('Hinge', 'Panel:1+Hinge:1')], constructionAxes: [axis] };
}

test('native occurrence paths retain nested bodies and axes without a separate reference tree', () => {
  const source = model(), roots = browserRoots(source);
  assert.equal(roots.length, 1); assert.equal(roots[0].name, 'Panel:1');
  const hinge = roots[0].children?.find(node => node.name === 'Hinge:1'); assert.ok(hinge);
  assert.deepEqual(nodePartIds(hinge), ['Hinge']); assert.deepEqual(nodeAxisIds(hinge), ['hinge-axis']);
});

test('object eye visibility cascades while an axis remains independent of its body eye', () => {
  const project = emptyProject(model()); project.model.browserTree = browserRoots(project.model);
  const parent = project.model.browserTree[0]; project.settings.partVisibility = { Hinge: false };
  assert.equal(modelVisibility(project).parts.get('Hinge'), false); assert.equal(modelVisibility(project).axes.get('hinge-axis'), true);
  project.settings.objectVisibility = { [parent.id]: false };
  const hidden = modelVisibility(project); assert.equal(hidden.parts.get('Panel'), false); assert.equal(hidden.axes.get('hinge-axis'), false);
  project.settings.objectVisibility[parent.id] = true;
  assert.equal(modelVisibility(project).parts.get('Hinge'), false); assert.equal(modelVisibility(project).axes.get('hinge-axis'), true);
});

test('hidden native bodies and axes remain in source order under their owning occurrences', () => {
  const source = model();
  source.browserTree = [{ id: 'panel-occurrence', name: 'Panel:1', kind: 'object', visible: true, children: [
    { id: 'part:Panel', name: 'Panel', kind: 'part', partId: 'Panel', visible: false },
    { id: 'hinge-occurrence', name: 'Hinge:1', kind: 'object', visible: false, children: [
      { id: 'part:Hinge', name: 'Hinge', kind: 'part', partId: 'Hinge', visible: true },
      { id: 'axis:hinge-axis', name: 'Hinge Axis', kind: 'axis', axisId: 'hinge-axis', visible: true },
    ] },
  ] }];
  const project = emptyProject(source), roots = browserRoots(source);
  assert.equal(roots, source.browserTree);
  assert.deepEqual(roots[0].children?.map(node => node.id), ['part:Panel', 'hinge-occurrence']);
  assert.deepEqual(nodePartIds(roots[0]), ['Panel', 'Hinge']);
  assert.deepEqual(nodeAxisIds(roots[0]), ['hinge-axis']);
  const hinge = findBrowserNode(source, 'part:Hinge'); assert.ok(hinge);
  assert.equal(nodeOwnVisibility(project, hinge), true);
  assert.equal(modelVisibility(project).parts.get('Panel'), false);
  assert.equal(modelVisibility(project).parts.get('Hinge'), false);
  assert.equal(modelVisibility(project).axes.get('hinge-axis'), false);

  project.settings.objectVisibility = { 'hinge-occurrence': true };
  const shown = modelVisibility(project);
  assert.equal(shown.parts.get('Panel'), false);
  assert.equal(shown.parts.get('Hinge'), true);
  assert.equal(shown.axes.get('hinge-axis'), true);
});

test('native source defaults and explicit eye choices remain independent', () => {
  const source = model(); source.browserTree = browserRoots(source);
  const panel = findBrowserNode(source, 'part:Panel'), hinge = findBrowserNode(source, 'part:Hinge');
  assert.ok(panel && hinge);
  panel.visible = false;
  source.constructionAxes![0].visible = false;
  const project = emptyProject(source);
  assert.equal(modelVisibility(project).parts.get('Panel'), false);
  assert.equal(modelVisibility(project).axes.get('hinge-axis'), false);

  project.settings.partVisibility = { Panel: true, Hinge: false };
  project.settings.constructionAxisVisibility = { 'hinge-axis': true };
  assert.equal(modelVisibility(project).parts.get('Panel'), true);
  assert.equal(modelVisibility(project).parts.get('Hinge'), false);
  assert.equal(modelVisibility(project).axes.get('hinge-axis'), true);
  assert.equal(panel.visible, false);
  assert.equal(source.constructionAxes![0].visible, false);

  project.settings.showConstructionAxes = false;
  assert.equal(modelVisibility(project).axes.get('hinge-axis'), false);
  assert.equal(modelVisibility(project).parts.get('Panel'), true);
  project.settings.partVisibility = {};
  project.settings.constructionAxisVisibility = {};
  project.settings.showConstructionAxes = true;
  assert.equal(modelVisibility(project).parts.get('Panel'), false);
  assert.equal(modelVisibility(project).parts.get('Hinge'), true);
  assert.equal(modelVisibility(project).axes.get('hinge-axis'), false);
});

test('retained removed source parts stay reachable after a native tree refresh', () => {
  const source = model(); source.browserTree = browserRoots(source);
  source.parts.push({ ...part('Retired support'), sourceStatus: 'removed' });
  const retained = browserRoots(source).at(-1)!;
  assert.equal(retained.name, 'Removed source parts'); assert.deepEqual(nodePartIds(retained), ['Retired support']);
  assert.equal(findBrowserNode(source, `part:Retired support`)?.partId, 'Retired support');
});

test('construction axes follow a whole component move and never jump to a separately exploded visible child', () => {
  const parts = new Map(['Shell', 'Spar'].map(id => [id, part(id)]));
  const meshes = new Map([...parts].map(([id, value]) => { const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); mesh.position.fromArray(value.home.position); mesh.updateMatrixWorld(true); return [id, mesh]; }));
  const axis: ConstructionAxis = { id: 'axis', name: 'Reference Axis', componentPath: 'Panel:1', nativeToken: 'axis-token', origin: [10, 20, 30], direction: [1, 0, 0], extent: [-2, 2], visible: true, partIds: [...parts.keys()] };
  meshes.get('Shell')!.position.x += 40; meshes.get('Shell')!.updateMatrixWorld(true); meshes.get('Spar')!.visible = false;
  assert.deepEqual(axisComponentTransform(axis, parts, meshes).elements, new Matrix4().elements);
  meshes.get('Spar')!.position.x += 40; meshes.get('Spar')!.updateMatrixWorld(true);
  assert.deepEqual(new Vector3().setFromMatrixPosition(axisComponentTransform(axis, parts, meshes)).toArray(), [40, 0, 0]);
  meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
});
