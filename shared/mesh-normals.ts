import { BufferAttribute, BufferGeometry } from 'three';

/** Split shading vertices at creases without reordering triangles used by surface anchors. */
export function creaseNormals(geometry: BufferGeometry, creaseDegrees = 30): void {
  const position = geometry.getAttribute('position'), index = geometry.getIndex();
  if (!index) throw new Error('Crease normals require indexed mesh geometry.');
  const faceNormals = new Float32Array(index.count), weights = new Float32Array(index.count);
  const offsets = new Uint32Array(position.count + 1);
  for (let i = 0; i < index.count; i++) offsets[index.getX(i) + 1]++;
  for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
  const cursors = offsets.slice(), corners = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) corners[cursors[index.getX(i)]++] = i;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    const abx = position.getX(b) - position.getX(a), aby = position.getY(b) - position.getY(a), abz = position.getZ(b) - position.getZ(a);
    const acx = position.getX(c) - position.getX(a), acy = position.getY(c) - position.getY(a), acz = position.getZ(c) - position.getZ(a);
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const area = Math.hypot(nx, ny, nz), length = area || 1;
    faceNormals[i] = nx / length; faceNormals[i + 1] = ny / length; faceNormals[i + 2] = nz / length;
    const angleA = Math.atan2(area, abx * acx + aby * acy + abz * acz);
    const angleB = Math.atan2(area, abx * (abx - acx) + aby * (aby - acy) + abz * (abz - acz));
    weights[i] = angleA; weights[i + 1] = angleB; weights[i + 2] = Math.max(0, Math.PI - angleA - angleB);
  }
  const remapped = new Uint32Array(index.count); remapped.fill(0xffffffff);
  const normals = new Float32Array(position.count * 3), extraPositions: number[] = [], extraNormals: number[] = [];
  const cosine = Math.cos(creaseDegrees * Math.PI / 180);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const start = offsets[vertex], end = offsets[vertex + 1]; let group = 0;
    for (let seed = start; seed < end; seed++) {
      const corner = corners[seed]; if (remapped[corner] !== 0xffffffff) continue;
      const face = corner - corner % 3, nx = faceNormals[face], ny = faceNormals[face + 1], nz = faceNormals[face + 2];
      const output = group++ === 0 ? vertex : position.count + extraPositions.length / 3;
      let x = 0, y = 0, z = 0;
      for (let k = seed; k < end; k++) {
        const candidate = corners[k]; if (remapped[candidate] !== 0xffffffff) continue;
        const other = candidate - candidate % 3, ox = faceNormals[other], oy = faceNormals[other + 1], oz = faceNormals[other + 2];
        if (candidate !== corner && nx * ox + ny * oy + nz * oz < cosine) continue;
        remapped[candidate] = output; const weight = weights[candidate]; x += ox * weight; y += oy * weight; z += oz * weight;
      }
      const length = Math.hypot(x, y, z) || 1; x /= length; y /= length; z /= length;
      if (output === vertex) { normals[vertex * 3] = x; normals[vertex * 3 + 1] = y; normals[vertex * 3 + 2] = z; }
      else { extraPositions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex)); extraNormals.push(x, y, z); }
    }
  }
  const positions = new Float32Array(position.count * 3 + extraPositions.length), combinedNormals = new Float32Array(normals.length + extraNormals.length);
  for (let i = 0; i < position.count; i++) { positions[i * 3] = position.getX(i); positions[i * 3 + 1] = position.getY(i); positions[i * 3 + 2] = position.getZ(i); }
  positions.set(extraPositions, position.count * 3); combinedNormals.set(normals); combinedNormals.set(extraNormals, normals.length);
  geometry.setAttribute('position', new BufferAttribute(positions, 3)); geometry.setAttribute('normal', new BufferAttribute(combinedNormals, 3)); geometry.setIndex(new BufferAttribute(remapped, 1));
}
