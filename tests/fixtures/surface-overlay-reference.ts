import * as THREE from 'three';
import type { SurfaceRegion } from '../../shared/types.ts';
const SURFACE_PAINT_OPACITY = 1;

export function legacySurfaceOverlay(geometry: THREE.BufferGeometry, region: SurfaceRegion, color: string): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const clipPlanes = region.clipPlanes ?? [];
  const source = geometry.getIndex()!; const overlay = new THREE.BufferGeometry(); overlay.setAttribute('position', geometry.getAttribute('position'));
  if (geometry.hasAttribute('normal')) overlay.setAttribute('normal', geometry.getAttribute('normal'));
  const indices = [...new Set(region.triangles)].flatMap(t => Number.isInteger(t) && t >= 0 && t < source.count / 3 ? [source.getX(t * 3), source.getX(t * 3 + 1), source.getX(t * 3 + 2)] : []);
  overlay.setIndex(indices);
  if (!overlay.hasAttribute('normal')) overlay.computeVertexNormals();
  // Reuse the body's exact depth samples: slope bias can pull an inner tube's paint through its sleeve.
  const material = new THREE.MeshStandardMaterial({ color, opacity: SURFACE_PAINT_OPACITY, transparent: false, depthWrite: false, depthFunc: THREE.EqualDepth, side: THREE.DoubleSide, roughness: .8, metalness: 0, alphaToCoverage: true });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, { regionCenter: { value: new THREE.Vector3(...region.center) }, regionAxis: { value: new THREE.Vector3(...region.axis).normalize() }, regionNormal: { value: new THREE.Vector3(...region.normal).normalize() }, regionRadius: { value: region.radius }, regionWidth: { value: region.width }, regionMode: { value: region.kind === 'face' ? 0 : region.kind === 'band' ? 2 : 1 }, regionClipPlanes: { value: clipPlanes.length ? clipPlanes.map(plane => new THREE.Vector4(...plane.normal, plane.constant)) : [new THREE.Vector4()] } });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 regionPoint;').replace('#include <begin_vertex>', '#include <begin_vertex>\nregionPoint=position;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 regionPoint;uniform vec3 regionCenter;uniform vec3 regionAxis;uniform vec3 regionNormal;uniform float regionRadius;uniform float regionWidth;uniform int regionMode;uniform vec4 regionClipPlanes[${Math.max(1, clipPlanes.length)}];`).replace('#include <color_fragment>', `#include <color_fragment>
vec3 delta=regionPoint-regionCenter;
float regionDistance=-1.0;
if(regionMode==1)regionDistance=max(length(delta-regionNormal*dot(delta,regionNormal))-regionRadius,abs(dot(delta,regionNormal))-regionRadius);
if(regionMode==2)regionDistance=abs(dot(delta,regionAxis))-regionWidth*.5;
for(int planeIndex=0;planeIndex<${clipPlanes.length};planeIndex++)regionDistance=max(regionDistance,dot(regionPoint,regionClipPlanes[planeIndex].xyz)+regionClipPlanes[planeIndex].w);
if(regionMode!=0||${clipPlanes.length}>0){
  float regionGradient=max(fwidth(regionDistance),1e-5);
  diffuseColor.a*=1.0-smoothstep(-regionGradient*.5,regionGradient*.5,regionDistance);
  if(diffuseColor.a==0.0)discard;
}`);
  };
  material.customProgramCacheKey = () => `manualstudio-solid-surface-region-${clipPlanes.length}`;
  const mesh = new THREE.Mesh(overlay, material); mesh.renderOrder = 4; mesh.userData.overlay = true; mesh.raycast = () => {}; return mesh;
}
