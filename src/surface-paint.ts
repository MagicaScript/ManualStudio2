import * as THREE from 'three';
import type { SurfaceRegion } from '../shared/types.ts';

export interface SurfacePaint { region: SurfaceRegion; color: string }
type ClipPlane = NonNullable<SurfaceRegion['clipPlanes']>[number];
type PaintEntry = [style: number, firstPlane: number, endPlane: number];

function coversTriangle(plane: ClipPlane, positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, triangle: number): boolean {
  const [x, y, z] = plane.normal;
  for (let i = triangle * 3; i < triangle * 3 + 3; i++) {
    const a = x * positions.getX(i), b = y * positions.getY(i), c = z * positions.getZ(i);
    // The rasterizer already covers the triangle's own edges. Tolerate rounding in the GPU plane equation.
    const roundoff = 4 * 2 ** -23 * (Math.abs(a) + Math.abs(b) + Math.abs(c) + Math.abs(plane.constant));
    if (a + b + c + plane.constant > roundoff) return false;
  }
  return true;
}

function paintTexture(positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, areas: SurfacePaint[]): THREE.DataTexture {
  const triangles = positions.count / 3;
  const entries = new Map<number, PaintEntry[]>();
  const records: number[] = [];
  const next = () => triangles + records.length / 4;
  for (const { region, color } of areas) {
    const disk = region.kind === 'circle' || region.kind === 'brush';
    const center = new THREE.Vector3(...region.center);
    const normal = new THREE.Vector3(...region.normal).normalize();
    const planes = [...(region.clipPlanes ?? [])];
    if (disk || region.kind === 'band') {
      const axis = disk ? normal : new THREE.Vector3(...region.axis).normalize();
      const halfWidth = disk ? region.radius : region.width / 2, mid = center.dot(axis);
      planes.push({ normal: axis.toArray(), constant: -mid - halfWidth }, { normal: axis.clone().negate().toArray(), constant: mid - halfWidth });
    }
    const style = next();
    records.push(...region.center, disk ? region.radius : -1, ...normal.toArray(), 0, ...new THREE.Color(color).toArray(), 0);
    const planeRanges = new Map<string, PaintEntry>();
    for (const triangle of new Set(region.triangles)) {
      if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangles) continue;
      const boundaries = planes.map((plane, index) => coversTriangle(plane, positions, triangle) ? -1 : index).filter(index => index >= 0);
      const key = boundaries.join(',');
      let entry = planeRanges.get(key);
      if (!entry) {
        const first = next();
        for (const index of boundaries) records.push(...planes[index].normal, planes[index].constant);
        entry = [style, first, next()];
        planeRanges.set(key, entry);
      }
      const stack = entries.get(triangle);
      if (stack) stack.push(entry);
      else entries.set(triangle, [entry]);
    }
  }

  // Each triangle has a span of paint entries. Evaluate only the areas that touch it.
  const spans = new Float32Array(triangles * 4);
  for (const [triangle, stack] of entries) {
    spans[triangle * 4] = next();
    for (const entry of stack) records.push(...entry, 0);
    spans[triangle * 4 + 1] = next();
  }
  const width = Math.min(4096, next()), height = Math.ceil(next() / width);
  const pixels = new Float32Array(width * height * 4);
  pixels.set(spans); pixels.set(records, spans.length);
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

const fragmentDeclarations = /* glsl */ `
  varying vec3 surfacePoint;
  flat varying float surfaceTriangleId;
  uniform highp sampler2D surfacePaintData;
  const uint surfaceSampleCount = 16u;
  const uint surfaceAllSamples = (1u << surfaceSampleCount) - 1u;

  vec4 surfaceRecord(int index) {
    int width = textureSize(surfacePaintData, 0).x;
    return texelFetch(surfacePaintData, ivec2(index % width, index / width), 0);
  }

  vec2 surfaceSampleOffset(uint index) {
    uint column = index % 4u, row = index / 4u;
    vec2 cell = vec2(column, row);
    vec2 stagger = vec2(row, (column + row) % 4u);
    return (cell + (stagger + .5) * .25) * .25 - .5;
  }

  float surfaceCoverage(uint mask) {
    if (mask == 0u) return 0.0;
    if (mask == surfaceAllSamples) return 1.0;
    uint count = 0u;
    for (uint i = 0u; i < surfaceSampleCount; ++i) count += (mask >> i) & 1u;
    return float(count) / float(surfaceSampleCount);
  }

  uint surfaceClip(uint mask, vec4 plane, vec3 dx, vec3 dy) {
    float distance = dot(surfacePoint, plane.xyz) + plane.w;
    vec2 slope = vec2(dot(plane.xyz, dx), dot(plane.xyz, dy));
    float spread = (abs(slope.x) + abs(slope.y)) * .5;
    if (distance <= -spread) return mask;
    if (distance > spread) return 0u;
    for (uint i = 0u; i < surfaceSampleCount; ++i) {
      if (distance + dot(slope, surfaceSampleOffset(i)) > 0.0) mask &= ~(1u << i);
    }
    return mask;
  }

  uint surfaceDisk(uint mask, vec4 disk, vec3 normal, vec3 dx, vec3 dy) {
    vec3 delta = surfacePoint - disk.xyz;
    vec3 radial = delta - normal * dot(normal, delta);
    vec3 radialX = dx - normal * dot(normal, dx), radialY = dy - normal * dot(normal, dy);
    float distance = length(radial), spread = (length(radialX) + length(radialY)) * .5;
    if (distance + spread <= disk.w) return mask;
    if (distance - spread > disk.w) return 0u;
    for (uint i = 0u; i < surfaceSampleCount; ++i) {
      vec2 offset = surfaceSampleOffset(i);
      vec3 point = radial + radialX * offset.x + radialY * offset.y;
      if (dot(point, point) > disk.w * disk.w) mask &= ~(1u << i);
    }
    return mask;
  }
`;

const fragmentPaint = /* glsl */ `
  vec3 surfaceDx = dFdx(surfacePoint), surfaceDy = dFdy(surfacePoint);
  ivec2 surfaceSpan = ivec2(surfaceRecord(int(surfaceTriangleId)).xy);
  uint paintedSamples = 0u;
  vec3 surfaceColor = vec3(0.0);
  for (int index = surfaceSpan.y - 1; index >= surfaceSpan.x && paintedSamples != surfaceAllSamples; --index) {
    ivec3 entry = ivec3(surfaceRecord(index).xyz);
    uint mask = surfaceAllSamples & ~paintedSamples;
    for (int plane = entry.y; plane < entry.z && mask != 0u; ++plane) {
      mask = surfaceClip(mask, surfaceRecord(plane), surfaceDx, surfaceDy);
    }
    vec4 disk = surfaceRecord(entry.x);
    if (mask != 0u && disk.w >= 0.0) {
      mask = surfaceDisk(mask, disk, surfaceRecord(entry.x + 1).xyz, surfaceDx, surfaceDy);
    }
    if (mask != 0u) {
      surfaceColor += surfaceRecord(entry.x + 2).rgb * surfaceCoverage(mask);
      paintedSamples |= mask;
    }
  }
  float surfacePaintCoverage = surfaceCoverage(paintedSamples);
  diffuseColor.rgb = diffuseColor.rgb * (1.0 - surfacePaintCoverage) + surfaceColor;
`;

/** Paint in the body's own draw, preserving its depth, sample coverage and triangle order. */
export function applySurfacePaint(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>, areas: SurfacePaint[]): () => void {
  if (!areas.length) return () => {};
  const source = mesh.geometry, sourceMaterial = mesh.material, material = sourceMaterial.clone();
  const geometry = source.getIndex() ? source.toNonIndexed() : source.clone();
  const position = geometry.getAttribute('position'), vertices = position.count;
  geometry.setIndex(Array.from({ length: vertices }, (_, index) => index));
  geometry.setAttribute('surfaceTriangle', new THREE.Float32BufferAttribute(Array.from({ length: vertices }, (_, index) => Math.floor(index / 3)), 1));
  const texture = paintTexture(position, areas);
  const previousCompile = sourceMaterial.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.surfacePaintData = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float surfaceTriangle; flat varying float surfaceTriangleId; varying vec3 surfacePoint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nsurfacePoint = position; surfaceTriangleId = surfaceTriangle;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentDeclarations}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${fragmentPaint}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, .8, surfacePaintCoverage);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - surfacePaintCoverage;');
  };
  material.customProgramCacheKey = () => `surface-paint:${sourceMaterial.customProgramCacheKey()}`;
  mesh.geometry = geometry; mesh.material = material; material.needsUpdate = true;
  return () => { mesh.geometry = source; sourceMaterial.copy(material); mesh.material = sourceMaterial; sourceMaterial.needsUpdate = true; material.dispose(); geometry.dispose(); texture.dispose(); };
}
