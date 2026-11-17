import * as THREE from 'three';
import type { SurfaceRegion } from '../shared/types.ts';

export interface SurfacePaint { region: SurfaceRegion; color: string }

/** Paint in the body's own draw, preserving its depth, sample coverage and triangle order. */
export function applySurfacePaint(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>, areas: SurfacePaint[]): () => void {
  if (!areas.length) return () => {};
  const source = mesh.geometry, sourceMaterial = mesh.material, material = sourceMaterial.clone();
  const geometry = source.getIndex() ? source.toNonIndexed() : source.clone();
  const vertices = geometry.getAttribute('position').count, triangles = vertices / 3;
  geometry.setIndex(Array.from({ length: vertices }, (_, index) => index));
  geometry.setAttribute('surfaceTriangle', new THREE.Float32BufferAttribute(Array.from({ length: vertices }, (_, index) => Math.floor(index / 3)), 1));
  const width = Math.min(4096, Math.max(1, triangles)), height = Math.max(1, Math.ceil(triangles * areas.length / width));
  const masks = new Uint8Array(width * height);
  areas.forEach(({ region }, index) => { for (const triangle of region.triangles) if (Number.isInteger(triangle) && triangle >= 0 && triangle < triangles) masks[index * triangles + triangle] = 255; });
  const texture = new THREE.DataTexture(masks, width, height, THREE.RedFormat); texture.needsUpdate = true;
  const previousCompile = sourceMaterial.onBeforeCompile;
  const declarations = ['varying vec3 surfacePoint;', 'varying float surfaceTriangleId;', 'uniform sampler2D surfaceMasks,surfaceParameters;'];
  const parameters: number[] = [];
  const parameter = (values: number[]): number => { const index = parameters.length / 4; parameters.push(...values); return index; };
  const code = ['float surfacePaintCoverage=0.0;', 'float colorCoverage=0.0;'];
  for (let index = 0; index < areas.length; index++) {
    const { region, color } = areas[index], prefix = `surface${index}`;
    const centerIndex = parameter([...region.center, region.radius]);
    const axisIndex = parameter([...new THREE.Vector3(...region.axis).normalize().toArray(), region.width]);
    const normalIndex = parameter([...new THREE.Vector3(...region.normal).normalize().toArray(), 0]);
    const colorIndex = parameter([...new THREE.Color(color).toArray(), 1]);
    code.push(`{
      float maskIndex=${(index * triangles).toFixed(1)}+floor(surfaceTriangleId+.5);
      vec2 maskUv=(vec2(mod(maskIndex,${width.toFixed(1)}),floor(maskIndex/${width.toFixed(1)}))+.5)/vec2(${width.toFixed(1)},${height.toFixed(1)});
      float member=texture2D(surfaceMasks,maskUv).r;
      vec4 centerRadius=surfaceParameter(${centerIndex.toFixed(1)}),axisWidth=surfaceParameter(${axisIndex.toFixed(1)});
      vec3 regionNormal=surfaceParameter(${normalIndex.toFixed(1)}).xyz;
      vec3 delta=surfacePoint-centerRadius.xyz;
      float distanceToRegion=-1.0;`);
    if (region.kind === 'band') code.push(`distanceToRegion=abs(dot(delta,axisWidth.xyz))-axisWidth.w*.5;`);
    if (region.kind === 'circle' || region.kind === 'brush') code.push(`distanceToRegion=max(length(delta-regionNormal*dot(delta,regionNormal))-centerRadius.w,abs(dot(delta,regionNormal))-centerRadius.w);`);
    (region.clipPlanes ?? []).forEach((plane, planeIndex) => {
      const name = `${prefix}Plane${planeIndex}`, planeOffset = parameter([...plane.normal, plane.constant]);
      code.push(`vec4 ${name}=surfaceParameter(${planeOffset.toFixed(1)});distanceToRegion=max(distanceToRegion,dot(surfacePoint,${name}.xyz)+${name}.w);`);
    });
    code.push(`float gradient=max(fwidth(distanceToRegion),1e-5);
      float coverage=member*(1.0-smoothstep(-gradient*.5,gradient*.5,distanceToRegion));
      colorCoverage=max(colorCoverage,coverage);
      surfacePaintCoverage=max(surfacePaintCoverage,coverage);`);
    if (areas[index + 1]?.color !== color) code.push(`diffuseColor.rgb=mix(diffuseColor.rgb,surfaceParameter(${colorIndex.toFixed(1)}).rgb,colorCoverage);colorCoverage=0.0;`);
    code.push("}");
  }
  // Brush strokes can contain hundreds of samples; textures avoid fragment-uniform limits.
  const parameterWidth = Math.min(256, parameters.length / 4), parameterHeight = Math.ceil(parameters.length / 4 / parameterWidth);
  const parameterData = new Float32Array(parameterWidth * parameterHeight * 4); parameterData.set(parameters);
  const parameterTexture = new THREE.DataTexture(parameterData, parameterWidth, parameterHeight, THREE.RGBAFormat, THREE.FloatType); parameterTexture.needsUpdate = true;
  const uniforms: Record<string, THREE.IUniform> = { surfaceMasks: { value: texture }, surfaceParameters: { value: parameterTexture } };
  declarations.push(`vec4 surfaceParameter(float index){return texture2D(surfaceParameters,(vec2(mod(index,${parameterWidth.toFixed(1)}),floor(index/${parameterWidth.toFixed(1)}))+.5)/vec2(${parameterWidth.toFixed(1)},${parameterHeight.toFixed(1)}));}`);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer); Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float surfaceTriangle;varying float surfaceTriangleId;varying vec3 surfacePoint;').replace('#include <begin_vertex>', '#include <begin_vertex>\nsurfacePoint=position;surfaceTriangleId=surfaceTriangle;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${declarations.join('\n')}`).replace('#include <color_fragment>', `#include <color_fragment>\n${code.join('\n')}`).replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.8,surfacePaintCoverage);').replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor*=1.0-surfacePaintCoverage;');
  };
  const signature = JSON.stringify(areas.map(({ region, color }, index) => [region.kind, region.clipPlanes?.length ?? 0, areas[index + 1]?.color === color]));
  material.customProgramCacheKey = () => `surface-paint:${triangles}:${width}:${height}:${signature}`;
  // A new material binds current uniforms even when a previous frame used the same shader program.
  mesh.geometry = geometry; mesh.material = material; material.needsUpdate = true;
  return () => { mesh.geometry = source; sourceMaterial.copy(material); mesh.material = sourceMaterial; sourceMaterial.needsUpdate = true; material.dispose(); geometry.dispose(); texture.dispose(); parameterTexture.dispose(); };
}
