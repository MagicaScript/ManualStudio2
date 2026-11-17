import * as THREE from 'three';
import { loadGeometries } from '../../src/geometry.ts';
import { legacySurfaceOverlay } from './surface-overlay-reference.ts';
import { applySurfacePaint } from '../../src/surface-paint.ts';
import type { Part, Pose, SurfaceRegion, Vec3 } from '../../shared/types.ts';

interface TubeOcclusionFixture {
  parts: [Part, Part];
  poses: [Pose, Pose];
  region: SurfaceRegion;
  color: string;
  axis: { origin: Vec3; direction: Vec3 };
  sleeveRadius: number;
}

const width = 1536, height = 520;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height); renderer.setPixelRatio(1);
const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, stencilBuffer: true });
const scene = new THREE.Scene(); scene.background = new THREE.Color('#53545b');
scene.add(new THREE.AmbientLight(0xffffff, 2));
const camera = new THREE.PerspectiveCamera(32, width / height, 100, 500);
camera.up.set(0, 0, 1);
const results: { angle: number; coveredPaintPixels: number; coveredInteriorPixels: number; biasedPaintPixels: number; exposedPaintPixels: number }[] = [];
function read(): Uint8Array {
  scene.updateMatrixWorld(true); renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const pixels = new Uint8Array(width * height * 4); renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels); return pixels;
}
function difference(a: Uint8Array, b: Uint8Array): number { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; }
function picture(label: string, pixels: Uint8Array): void {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height); for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
  context.putImageData(image, 0, 0); const figure = document.createElement('figure'), caption = document.createElement('figcaption'); caption.textContent = label; figure.append(caption, canvas); document.querySelector('main')!.append(figure);
}
try {
  const response = await fetch('/tests/fixtures/private/tube-occlusion.json');
  if (!response.ok) throw new Error('The private tube occlusion fixture is unavailable.');
  const fixture: TubeOcclusionFixture = await response.json();
  const { region, color } = fixture;
  const parts = fixture.parts.map(part => ({ ...part, geometry: { ...part.geometry, file: `/data${part.geometry.file}` } }));
  const geometries = await loadGeometries(parts);
  const bodies = parts.map((part, index) => {
    const mesh = new THREE.Mesh(geometries.get(part.id), new THREE.MeshStandardMaterial({ color: part.color, side: THREE.DoubleSide, alphaToCoverage: true }));
    mesh.position.fromArray(fixture.poses[index].position);
    mesh.quaternion.fromArray(fixture.poses[index].quaternion);
    scene.add(mesh);
    return mesh;
  });
  const paint = legacySurfaceOverlay(bodies[0].geometry, region, color);

  const group = new THREE.Group(); group.position.copy(bodies[0].position); group.quaternion.copy(bodies[0].quaternion); group.add(paint); scene.add(group);
  const center = bodies[1].position.clone();
  const axis = new THREE.Vector3(...fixture.axis.direction);
  const axisOrigin = new THREE.Vector3(...fixture.axis.origin);
  const side = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 0, 1)).normalize();
  for (const angle of [0, .2, .65, 1.1]) {
    const direction = side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(axis, Math.sin(angle)).add(new THREE.Vector3(0, 0, .65)).normalize();
    camera.position.copy(center).addScaledVector(direction, 260); camera.lookAt(center); camera.updateMatrixWorld(true);
    paint.visible = false; const bare = read();
    const resetPaint = applySurfacePaint(bodies[0], [{ region, color }]); const covered = read(); resetPaint(); paint.visible = true;
    paint.material.depthFunc = THREE.LessEqualDepth; paint.material.polygonOffset = true; paint.material.polygonOffsetFactor = paint.material.polygonOffsetUnits = -1;
    const biased = read(); paint.material.depthFunc = THREE.EqualDepth; paint.material.polygonOffset = false; paint.visible = false;
    const ends = [-1, 1].map(sign => {
      const point = new THREE.Vector3(...region.center).addScaledVector(new THREE.Vector3(...region.axis).normalize(), sign * region.width / 2).applyMatrix4(bodies[0].matrixWorld);
      return axisOrigin.clone().addScaledVector(axis, point.sub(axisOrigin).dot(axis));
    });
    const rims = ends.map(point => {
      const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const pixelRadius = fixture.sleeveRadius * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * depth) + 2;
      const projected = point.clone().project(camera);
      return { x: (projected.x + 1) * width / 2, y: (projected.y + 1) * height / 2, pixelRadius };
    });
    let coveredInteriorPixels = 0;
    for (let offset = 0; offset < bare.length; offset += 4) {
      if (bare[offset] === covered[offset] && bare[offset + 1] === covered[offset + 1] && bare[offset + 2] === covered[offset + 2]) continue;
      const x = offset / 4 % width + .5, y = Math.floor(offset / 4 / width) + .5;
      if (!rims.some(rim => Math.hypot(x - rim.x, y - rim.y) <= rim.pixelRadius)) coveredInteriorPixels++;
    }
    bodies[1].visible = false; const exposedBare = read(); const resetExposed = applySurfacePaint(bodies[0], [{ region, color }]); const exposed = read(); resetExposed(); bodies[1].visible = true;
    results.push({ angle, coveredPaintPixels: difference(bare, covered), coveredInteriorPixels, biasedPaintPixels: difference(bare, biased), exposedPaintPixels: difference(exposedBare, exposed) });
    if (angle === 0) { picture('Original depth bias', biased); picture('Paint at the body depth', covered); picture('Exposed contact paint', exposed); }
  }
  document.querySelector('output')!.textContent = JSON.stringify(results, null, 2);
} catch (error) { document.querySelector('output')!.textContent = JSON.stringify({ error: String(error) }); }
finally { renderer.dispose(); target.dispose(); document.documentElement.dataset.complete = 'true'; }
