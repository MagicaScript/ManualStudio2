import * as THREE from 'three';
import { applySurfacePaint, type SurfacePaint } from '../../src/surface-paint.ts';
import { SectionView } from '../../src/section-view.ts';
import { DEFAULT_GLUE_COLOR } from '../../shared/render-style.ts';
import type { SurfaceRegion } from '../../shared/types.ts';

const size = 256;
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.localClippingEnabled = true;
renderer.setSize(size, size);
const target = new THREE.WebGLRenderTarget(size, size, { samples: 4, stencilBuffer: true });
const camera = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, .1, 20);
camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);

function read(scene: THREE.Scene): Uint8Array {
  scene.updateMatrixWorld(true); renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const pixels = new Uint8Array(size * size * 4); renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels); return pixels;
}
function picture(id: string, label: string, pixels: Uint8Array): void {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size); for (let y = 0; y < size; y++) image.data.set(pixels.subarray((size - y - 1) * size * 4, (size - y) * size * 4), y * size * 4);
  context.putImageData(image, 0, 0); const figure = document.createElement('figure'); const img = document.createElement('img'); img.src = canvas.toDataURL(); img.alt = label;
  const caption = document.createElement('figcaption'); caption.textContent = label; figure.append(img, caption); document.getElementById(id)!.append(figure);
}
function difference(a: Uint8Array, b: Uint8Array): number { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; }
function sample(pixels: Uint8Array, x: number, y: number): number[] { const offset = (Math.floor((y + 1.5) / 3 * size) * size + Math.floor((x + 1.5) / 3 * size)) * 4; return [...pixels.subarray(offset, offset + 3)]; }
function capEdges(pixels: Uint8Array): number { let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 25 && pixels[i] < 245 && pixels[i] > pixels[i + 1] * 1.8 && pixels[i] > pixels[i + 2] * 1.8) count++; return count; }

try {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0, 0, 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.5, 1.9), new THREE.MeshBasicMaterial({ color: '#555555', clippingPlanes: [plane], alphaToCoverage: true }));
  body.rotation.set(.35, .22, .28); body.updateMatrixWorld(true); scene.add(body);
  const section = new SectionView(plane); section.load([body]); section.active = section.root.visible = true; scene.add(section.root);
  section.update(new THREE.Box3().setFromObject(body));
  for (const child of section.root.children) if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial && child.material.stencilFunc === THREE.NotEqualStencilFunc) child.material.color.setRGB(1, .37, 0);
  const smooth = read(scene);
  body.material.alphaToCoverage = false; body.material.needsUpdate = true;
  for (const child of section.root.children) if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) { child.material.alphaToCoverage = false; child.material.needsUpdate = true; }
  const binary = read(scene);
  picture('sectionCoverage', 'Binary fragment clipping', binary); picture('sectionCoverage', 'Sample coverage clipping', smooth);

  section.dispose(); scene.remove(body); body.geometry.dispose(); body.material.dispose();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.8, .25, 32, 96), new THREE.MeshBasicMaterial({ color: '#555555', clippingPlanes: [plane], alphaToCoverage: true }));
  scene.add(ring); ring.updateMatrixWorld(true); section.load([ring]); section.root.visible = true; section.update(new THREE.Box3().setFromObject(ring));
  const ringPixels = read(scene); const hole = sample(ringPixels, 0, 0);
  section.dispose(); scene.remove(ring, section.root); ring.geometry.dispose(); ring.material.dispose();

  scene.background = new THREE.Color('#202020'); scene.add(new THREE.AmbientLight(0xffffff, 2));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), new THREE.MeshStandardMaterial({ color: '#888888', roughness: .8, alphaToCoverage: true })); scene.add(panel);
  const region: SurfaceRegion = { kind: 'circle', triangles: [0, 1, 0], center: [-.35, 0, 0], normal: [0, 0, 1], radius: .7, axis: [0, 1, 0], width: .4 };
  const first: SurfacePaint = { region, color: DEFAULT_GLUE_COLOR };
  const second: SurfacePaint = { region: { ...region, center: [.35, 0, 0] }, color: DEFAULT_GLUE_COLOR };
  let reset = applySurfacePaint(panel, [first]); const one = read(scene); reset();
  reset = applySurfacePaint(panel, [first, first]); const twice = read(scene); reset();
  reset = applySurfacePaint(panel, Array.from({ length: 256 }, () => first)); const brushStroke = read(scene); reset();
  reset = applySurfacePaint(panel, [first, second]); const overlap = read(scene); reset();
  picture('paintCoverage', 'One surface region', one); picture('paintCoverage', 'Two overlapping regions', overlap);
  reset = applySurfacePaint(panel, [first, { ...second, color: '#b58d93' }]); const repainted = read(scene); reset();
  reset = applySurfacePaint(panel, [first]); const erased = read(scene); reset();
  const unpainted = read(scene);
  reset = applySurfacePaint(panel, [{ ...first, region: { ...region, kind: 'band', center: [0, 0, 0], width: 1.2, clipPlanes: [{ normal: [1, 0, 0], constant: .123 }] } }]);
  const clippedPixels = read(scene); reset();
  reset = applySurfacePaint(panel, [{ ...first, region: { ...region, kind: 'band', center: [0, 0, 0], width: 1.2, clipPlanes: [{ normal: [-1, 0, 0], constant: .123 }] } }]);
  const reversedClipPixels = read(scene); reset();
  reset = applySurfacePaint(panel, [first]);
  const compile = panel.material.onBeforeCompile, key = panel.material.customProgramCacheKey();
  panel.material.onBeforeCompile = (shader, renderer) => { compile.call(panel.material, shader, renderer); shader.fragmentShader = shader.fragmentShader.replaceAll('1.0-smoothstep(-gradient*.5,gradient*.5,distanceToRegion)', '1.0-step(0.0,distanceToRegion)'); };
  panel.material.customProgramCacheKey = () => `${key}:binary-reference`; panel.material.needsUpdate = true;
  const binaryPaint = read(scene); reset();
  const solid = sample(one, -.35, 0), bare = sample(unpainted, 0, 0);
  const paintEdges = (pixels: Uint8Array): number => {
    let count = 0;
    for (let y = 30; y < size - 30; y++) for (let x = 30; x < size - 30; x++) {
      const offset = (y * size + x) * 4, color = [...pixels.subarray(offset, offset + 3)];
      if (color.every((channel, index) => channel >= Math.min(solid[index], bare[index]) && channel <= Math.max(solid[index], bare[index])) && color.some((channel, index) => channel !== solid[index]) && color.some((channel, index) => channel !== bare[index])) count++;
    }
    return count;
  };
  const report = {
    maxSamples: renderer.capabilities.maxSamples,
    binaryCapEdgePixels: capEdges(binary), coveredCapEdgePixels: capEdges(smooth), capChangedPixels: difference(binary, smooth),
    holeCenter: hole, duplicatePaintDifference: difference(one, twice), erasedRegionDifference: difference(one, erased),
    longStrokeDifference: difference(one, brushStroke),
    singlePaintColor: sample(overlap, -.7, 0), overlappingPaintColor: sample(overlap, 0, 0), duplicateTriangleCount: new Set(region.triangles).size,
    latestPaintColor: sample(repainted, .7, 0), latestOverlapColor: sample(repainted, 0, 0),
    clippedInsideColor: sample(clippedPixels, -.5, 0), clippedOutsideColor: sample(clippedPixels, .5, 0), unpaintedColor: sample(unpainted, .5, 0),
    smoothPaintEdgePixels: paintEdges(one), binaryPaintEdgePixels: paintEdges(binaryPaint),
    nextFrameInsideColor: sample(reversedClipPixels, .5, 0), nextFrameOutsideColor: sample(reversedClipPixels, -.5, 0),
  };
  document.querySelector('output')!.textContent = JSON.stringify(report, null, 2);
  panel.geometry.dispose(); panel.material.dispose();
} catch (error) { document.querySelector('output')!.textContent = JSON.stringify({ error: String(error) }); }
finally { target.dispose(); renderer.dispose(); document.documentElement.dataset.renderingTestComplete = 'true'; }
