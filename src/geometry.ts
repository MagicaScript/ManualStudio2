import * as THREE from 'three';
import type { Anchor, Part, SurfaceRegion, TargetKind, Vec3 } from '../shared/types.ts';
import { creaseNormals } from '../shared/mesh-normals.ts';

export async function loadGeometries(parts: Part[]): Promise<Map<string, THREE.BufferGeometry>> {
  const files = new Map<string, ArrayBuffer>();
  await Promise.all([...new Set(parts.map(p => p.geometry.file))].map(async file => { const response = await fetch(file); if (!response.ok) throw new Error(`Cannot load model geometry: ${file}`); files.set(file, await response.arrayBuffer()); }));
  return new Map(parts.map(part => {
    const ref = part.geometry; const buffer = files.get(ref.file)!; const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, ref.offset, ref.vertices * 3), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, ref.offset + ref.vertices * 12, ref.triangles * 3), 1));
    if (ref.normalsOffset !== undefined) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buffer, ref.normalsOffset, ref.vertices * 3), 3)); else creaseNormals(geometry);
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return [part.id, geometry];
  }));
}
import { connectedFace, cylinderAxis } from '../shared/surfaces.ts';
export { connectedFace, cylinderAxis } from '../shared/surfaces.ts';

export interface PickSettings { target: TargetKind; region: SurfaceRegion['kind']; radius: number; width: number; axis: 'auto' | 'x' | 'y' | 'z'; angle: number }
export function surfaceAnchor(hit: THREE.Intersection<THREE.Object3D>, partId: string, mesh: THREE.Mesh, settings: PickSettings, withRegion: boolean): Anchor {
  const point = mesh.worldToLocal(hit.point.clone()); const normal = hit.face?.normal.clone().normalize() ?? new THREE.Vector3(0, 0, 1);
  const triangle = hit.faceIndex ?? 0; const anchor: Anchor = { partId, point: point.toArray(), normal: normal.toArray(), target: settings.target, triangle };
  if (settings.target === 'part') { mesh.geometry.computeBoundingBox(); anchor.point = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).toArray(); }
  if (withRegion || settings.target === 'face' || settings.target === 'band') {
    const triangles = connectedFace(mesh.geometry, triangle, settings.angle);
    const axis: Vec3 = settings.axis === 'x' ? [1, 0, 0] : settings.axis === 'y' ? [0, 1, 0] : settings.axis === 'z' ? [0, 0, 1] : cylinderAxis(mesh.geometry, triangles);
    anchor.region = { kind: withRegion ? settings.region : settings.target === 'band' ? 'band' : 'face', triangles, center: point.toArray(), normal: normal.toArray(), radius: settings.radius, axis, width: settings.width };
  }
  return anchor;
}
export function triangleArea(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position'), index = geometry.getIndex()!; const triangle = new THREE.Triangle(); let sum = 0;
  for (let i = 0; i < index.count; i += 3) { triangle.a.fromBufferAttribute(position, index.getX(i)); triangle.b.fromBufferAttribute(position, index.getX(i + 1)); triangle.c.fromBufferAttribute(position, index.getX(i + 2)); sum += triangle.getArea(); }
  return sum;
}
