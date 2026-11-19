import { open } from 'node:fs/promises';
import path from 'node:path';
import { BufferAttribute, BufferGeometry, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { poseMatrix, type PartTransform } from '../shared/assembly-motion.ts';
import { homePose } from '../shared/document.ts';
import { framePlayback, playbackFrame } from '../shared/playback.ts';
import type { Part, Pose, Project } from '../shared/types.ts';
import { geometryArrays } from './import-3mf.ts';

export function poseContext(project: Project, frameId?: string, progress = 0, stepId?: string) {
  const segment = frameId !== undefined || stepId !== undefined ? framePlayback(project, frameId, stepId) : undefined;
  const frame = segment && playbackFrame(segment, progress);
  const final = !frame ? project.steps.find(step => step.final)?.frames.at(-1) : undefined;
  const parts = new Map(project.model.parts.map(part => [part.id, part]));
  const pose = (id: string): Pose => {
    const part = parts.get(id);
    if (!part) throw new Error(`Unknown part: ${id}.`);
    return frame?.poses[id] ?? final?.poses[id] ?? homePose(part);
  };
  const lookup: PartTransform = id => {
    const part = parts.get(id);
    return part ? { part, matrix: poseMatrix(pose(id)) } : undefined;
  };
  return { parts, frame, step: segment?.step, pose, lookup };
}

export async function loadGeometry(part: Part, directory: string): Promise<BufferGeometry> {
  const { file, offset, vertices, triangles } = part.geometry;
  const length = (vertices + triangles) * 12;
  if (!vertices || !triangles) throw new Error(`Part ${part.id} has no triangle geometry.`);
  const modelDirectory = path.resolve(directory, 'models');
  const filename = path.resolve(directory, file.replace(/^\//, ''));
  const relative = path.relative(modelDirectory, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid model geometry path.');
  const handle = await open(filename, 'r');
  const bytes = Buffer.alloc(length);
  try {
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
      if (!bytesRead) throw new Error(`Geometry file is incomplete for ${part.id}.`);
      read += bytesRead;
    }
  } finally { await handle.close(); }
  const { positions, indices } = geometryArrays({ ...part, geometry: { ...part.geometry, offset: 0 } }, bytes);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

export function meshTree(geometry: BufferGeometry): MeshBVH {
  const indexed = geometry as BufferGeometry & { boundsTree?: MeshBVH };
  return indexed.boundsTree ??= new MeshBVH(geometry, { indirect: true });
}

export function readTriangle(geometry: BufferGeometry, index: number, triangle: Triangle): Triangle {
  const positions = geometry.getAttribute('position'), indices = geometry.getIndex()!;
  const start = index * 3;
  triangle.a.fromBufferAttribute(positions, indices.getX(start));
  triangle.b.fromBufferAttribute(positions, indices.getX(start + 1));
  triangle.c.fromBufferAttribute(positions, indices.getX(start + 2));
  return triangle;
}

export function surfaceVertices(geometry: BufferGeometry, triangles: number[]): Vector3[] {
  const ids = new Set<number>(), indices = geometry.getIndex()!, positions = geometry.getAttribute('position');
  for (const triangle of triangles) for (let i = 0; i < 3; i++) ids.add(indices.getX(triangle * 3 + i));
  return [...ids].map(id => new Vector3().fromBufferAttribute(positions, id));
}
