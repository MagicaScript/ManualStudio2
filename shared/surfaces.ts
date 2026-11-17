import * as THREE from 'three';
import type { Vec3 } from './types.ts';

interface Topology { normals: THREE.Vector3[]; neighbors: number[][] }
const topologyCache = new WeakMap<THREE.BufferGeometry, Topology>();
function topology(geometry: THREE.BufferGeometry): Topology {
  const existing = topologyCache.get(geometry); if (existing) return existing;
  const position = geometry.getAttribute('position'); const index = geometry.getIndex()!; const edges = new Map<string, number>();
  const vertexKeys = Array.from({ length: position.count }, (_, i) => `${Math.round(position.getX(i) * 1e5)},${Math.round(position.getY(i) * 1e5)},${Math.round(position.getZ(i) * 1e5)}`);
  const normals: THREE.Vector3[] = []; const neighbors: number[][] = Array.from({ length: index.count / 3 }, () => []);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let offset = 0; offset < index.count; offset += 3) {
    const tri = offset / 3; const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
    a.fromBufferAttribute(position, ids[0]); b.fromBufferAttribute(position, ids[1]); c.fromBufferAttribute(position, ids[2]); normals.push(new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3()));
    for (let edge = 0; edge < 3; edge++) { const pair = [vertexKeys[ids[edge]], vertexKeys[ids[(edge + 1) % 3]]].sort(); const key = pair.join('|'); const previous = edges.get(key); if (previous === undefined) edges.set(key, tri); else { neighbors[tri].push(previous); neighbors[previous].push(tri); } }
  }
  const result = { normals, neighbors }; topologyCache.set(geometry, result); return result;
}
export function connectedFace(geometry: THREE.BufferGeometry, seed: number, angle = 25): number[] {
  const data = topology(geometry); if (!data.normals[seed]) return [];
  const visited = new Uint8Array(data.normals.length); const queue = [seed]; visited[seed] = 1; const cosine = Math.cos(angle * Math.PI / 180);
  for (let i = 0; i < queue.length; i++) for (const neighbor of data.neighbors[queue[i]]) {
    if (!visited[neighbor] && data.normals[queue[i]].dot(data.normals[neighbor]) >= cosine) { visited[neighbor] = 1; queue.push(neighbor); }
  }
  return queue;
}
export function cylinderAxis(geometry: THREE.BufferGeometry, triangles: number[], fallback: Vec3 = [0, 0, 1]): Vec3 {
  const data = topology(geometry); const seed = data.normals[triangles[0]]; if (!seed) return fallback;
  const accumulated = new THREE.Vector3(); const first = new THREE.Vector3();
  for (const i of triangles) { const axis = new THREE.Vector3().crossVectors(seed, data.normals[i]); if (axis.lengthSq() < .01) continue; axis.normalize(); if (!first.lengthSq()) first.copy(axis); if (axis.dot(first) < 0) axis.negate(); accumulated.add(axis); }
  return accumulated.lengthSq() > .01 ? accumulated.normalize().toArray() : fallback;
}
