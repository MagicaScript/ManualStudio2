import { Box3, DoubleSide, Ray, Vector3, type BufferGeometry, type Matrix4 } from 'three';
import type { HitPointInfo, MeshBVH } from 'three-mesh-bvh';
import type { Vec3 } from '../shared/types.ts';
import { meshTree } from './geometry-data.ts';

const contactTolerance = 1e-6;
const rayDirections = [[1, .3417, .1953], [.2387, 1, .5733], [.7197, -.3231, 1]].map(direction => new Vector3().fromArray(direction).normalize());

interface VolumeTopology { closed: boolean; witnesses: Vector3[] }
export interface CollisionMesh { geometry: BufferGeometry; tree: MeshBVH; bounds: Box3; topology?: VolumeTopology }
export interface MeshPlacement { mesh: CollisionMesh; matrix: Matrix4; inverse: Matrix4; worldBounds: Box3 }
export interface Contact { clearance: number; kind: 'separated' | 'surface-contact' | 'containment'; movingPoint: Vec3; obstaclePoint: Vec3 }

export function collisionMesh(geometry: BufferGeometry): CollisionMesh {
  geometry.computeBoundingBox();
  return { geometry, tree: meshTree(geometry), bounds: geometry.boundingBox! };
}
export function meshPlacement(mesh: CollisionMesh, matrix: Matrix4): MeshPlacement {
  return { mesh, matrix, inverse: matrix.clone().invert(), worldBounds: mesh.bounds.clone().applyMatrix4(matrix) };
}

/** Weld mesh seams for closure and keep one containment witness per connected shell. */
function volumeTopology(geometry: BufferGeometry): VolumeTopology {
  const position = geometry.getAttribute('position'), index = geometry.getIndex()!;
  const welded = new Map<string, number>(), vertices: Vector3[] = [];
  const ids = Array.from({ length: position.count }, (_, i) => {
    const p = new Vector3().fromBufferAttribute(position, i), key = p.toArray().map(value => Math.round(value * 1e5)).join(',');
    const existing = welded.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length; vertices.push(p); welded.set(key, id); return id;
  });
  const parent = vertices.map((_, i) => i);
  const root = (id: number): number => {
    while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; }
    return id;
  };
  const edges = new Map<number, number>();
  const used = new Set<number>();
  for (let i = 0; i < index.count; i += 3) {
    const a = ids[index.getX(i)], b = ids[index.getX(i + 1)], c = ids[index.getX(i + 2)];
    if (a === b || b === c || a === c) continue;
    const triangle = [a, b, c];
    for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3];
      used.add(a);
      parent[root(a)] = root(b);
      const edge = Math.min(a, b) * vertices.length + Math.max(a, b);
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  return { closed: edges.size > 0 && [...edges.values()].every(count => count === 2), witnesses: [...new Set([...used].map(root))].map(id => vertices[id]) };
}

function inside(mesh: CollisionMesh, point: Vector3): boolean {
  return rayDirections.filter(direction => {
    const hits = mesh.tree.raycast(new Ray(point, direction), DoubleSide, contactTolerance).sort((a, b) => a.distance - b.distance);
    let count = 0, previous = -Infinity;
    for (const hit of hits) {
      if (hit.distance - previous > contactTolerance) count++;
      previous = hit.distance;
    }
    return count % 2 === 1;
  }).length >= 2;
}

function containsWitness(container: CollisionMesh, other: CollisionMesh, otherToContainer: Matrix4): boolean {
  if (!(container.topology ??= volumeTopology(container.geometry)).closed) return false;
  const candidates = (other.topology ??= volumeTopology(other.geometry)).witnesses;
  const point = new Vector3();
  return candidates.some(candidate => {
    point.copy(candidate).applyMatrix4(otherToContainer);
    return container.bounds.containsPoint(point) && inside(container, point);
  });
}
export function boxDistance(a: Box3, b: Box3): number {
  return Math.hypot(...(['x', 'y', 'z'] as const).map(axis => Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis])));
}

export function meshContact(moving: MeshPlacement, obstacle: MeshPlacement, maxClearance: number): Contact | undefined {
  const lowerBound = boxDistance(moving.worldBounds, obstacle.worldBounds);
  if (lowerBound > Math.max(maxClearance, contactTolerance)) return;
  const relative = moving.inverse.clone().multiply(obstacle.matrix);
  const other: HitPointInfo = { point: new Vector3(), distance: Infinity, faceIndex: -1 };
  const hit = moving.mesh.tree.closestPointToGeometry(obstacle.mesh.geometry, relative, undefined, other, contactTolerance,
    Math.max(maxClearance, contactTolerance) + contactTolerance);
  const contained = lowerBound === 0 && (!hit || hit.distance > contactTolerance) && (
    containsWitness(moving.mesh, obstacle.mesh, relative) || containsWitness(obstacle.mesh, moving.mesh, relative.clone().invert()));
  if (!hit && !contained) return;
  // For nesting, nearest surface points still describe the two shells even when their solids overlap.
  const nearest = hit ?? moving.mesh.tree.closestPointToGeometry(obstacle.mesh.geometry, relative, undefined, other)!;
  const touching = nearest.distance <= contactTolerance;
  return {
    clearance: touching || contained ? 0 : nearest.distance,
    kind: contained ? 'containment' : touching ? 'surface-contact' : 'separated',
    movingPoint: nearest.point.applyMatrix4(moving.matrix).toArray(),
    obstaclePoint: other.point.applyMatrix4(obstacle.matrix).toArray(),
  };
}
