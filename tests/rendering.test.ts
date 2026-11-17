import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, CylinderGeometry, Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { creaseNormals } from '../shared/mesh-normals.ts';
import { navigatorDirection, orbitDirection, shortcutView } from '../shared/navigation.ts';

test('sharp cube edges retain separate face normals and original triangle positions', () => {
  const cube = new BoxGeometry(); cube.deleteAttribute('normal'); cube.deleteAttribute('uv');
  const geometry = mergeVertices(cube), source = geometry.clone(); geometry.computeVertexNormals();
  const before = geometry.getAttribute('normal'); assert.ok(Math.abs(before.getX(0)) < .99);
  creaseNormals(geometry);
  assert.equal(geometry.getAttribute('position').count, 24);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), index = geometry.getIndex()!;
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i), old = source.getIndex()!.getX(i);
    assert.deepEqual(new Vector3().fromBufferAttribute(positions, v).toArray(), new Vector3().fromBufferAttribute(source.getAttribute('position'), old).toArray());
    const n = new Vector3().fromBufferAttribute(normals, v); assert.equal(Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)), 1);
  }
});

test('a cylinder stays smooth around its side while both end caps remain sharp', () => {
  const cylinder = new CylinderGeometry(2, 2, 10, 64); cylinder.deleteAttribute('normal'); cylinder.deleteAttribute('uv');
  const geometry = mergeVertices(cylinder); creaseNormals(geometry);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'); let sides = 0, caps = 0;
  for (let i = 0; i < positions.count; i++) {
    const p = new Vector3().fromBufferAttribute(positions, i), n = new Vector3().fromBufferAttribute(normals, i);
    if (Math.abs(n.y) > .99) { assert.equal(Math.abs(n.y), 1); caps++; }
    else { assert.ok(Math.abs(n.y) < 1e-5); assert.ok(n.dot(new Vector3(p.x, 0, p.z).normalize()) > .998); sides++; }
  }
  assert.ok(sides >= 128); assert.ok(caps >= 128);
});

test('the navigator distinguishes all 6 faces, 12 edges and 8 corners', () => {
  const results = new Set<string>();
  for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) for (const a of [-.375, 0, .375]) for (const b of [-.375, 0, .375]) {
    const point: [number, number, number] = [0, 0, 0]; point[axis] = sign * .5; point[(axis + 1) % 3] = a; point[(axis + 2) % 3] = b;
    results.add(navigatorDirection(point).join(','));
  }
  assert.equal(results.size, 26);
  const cardinality = [...results].map(value => value.split(',').filter(v => Number(v) !== 0).length);
  assert.equal(cardinality.filter(n => n === 1).length, 6); assert.equal(cardinality.filter(n => n === 2).length, 12); assert.equal(cardinality.filter(n => n === 3).length, 8);
});

test('navigator dragging clamps elevation and Ctrl number keys match Bambu view ordering', () => {
  for (const dy of [-2000, -50, 0, 50, 2000]) {
    const direction = orbitDirection([1, -1, 1], 130, dy); assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-8); assert.ok(Math.abs(direction[2]) < 1);
  }
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => shortcutView(String(i + 1), `Digit${i + 1}`)), ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso']);
  assert.equal(shortcutView('End', 'Numpad1'), 'top'); assert.equal(shortcutView('8', 'Digit8'), undefined);
});
