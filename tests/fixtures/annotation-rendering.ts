import '../../src/style.css';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { Viewport } from '../../src/viewport.ts';
import { emptyProject, makeStep } from '../../shared/document.ts';
import type { Anchor, Note, Part, Vec3 } from '../../shared/types.ts';
import { DEFAULT_NOTE_COLOR } from '../../shared/render-style.ts';

const host = document.querySelector<HTMLElement>('#viewport')!;
const geometry = new BoxGeometry(100, 50, 40);
const positions = new Float32Array(geometry.getAttribute('position').array);
const indices = new Uint32Array(geometry.getIndex()!.array);
const buffer = new Uint8Array(positions.byteLength + indices.byteLength);
buffer.set(new Uint8Array(positions.buffer)); buffer.set(new Uint8Array(indices.buffer), positions.byteLength);
const file = URL.createObjectURL(new Blob([buffer]));
const part: Part = {
  id: 'housing', name: 'Housing', sourceName: 'Housing', objectName: 'Assembly', objectId: 'assembly', path: 'Assembly/Housing', sourceObject: 'housing',
  geometry: { file, offset: 0, vertices: positions.length / 3, triangles: indices.length / 3 },
  home: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, bounds: [[-50, -25, -20], [50, 25, 20]],
  color: '#dddddd', material: 0, sourceStatus: 'active', initiallyAssembled: false,
};
const project = emptyProject({ id: 'fixture', name: 'Annotation fixture', sourceFile: 'fixture', revision: 1, importedAt: '', parts: [part], materials: ['#dddddd'] });
const step = makeStep(project, 'Inspect anchors', [part.id]); project.steps.push(step);
const frame = step.frames[0];
const anchor = (point: Vec3): Anchor => ({ partId: part.id, point, normal: [0, -1, 0], target: 'point', triangle: 0 });
const note = (id: string, kind: Note['kind'], anchors: Anchor[]): Note => ({ id, kind, anchors, text: '', color: DEFAULT_NOTE_COLOR, background: '#30343c', size: 12, offset: [120, -110] });
frame.notes = [
  note('rectangle', 'rectangle', [anchor([-28, -25, 0])]),
  note('circle', 'circle', [anchor([28, -25, 0])]),
  note('arrow', 'arrow', [anchor([-40, -25, -18]), anchor([40, -25, 18])]),
];
const noop = (): void => {};
const view = new Viewport(host, { select: () => { host.dataset.selection = 'part'; }, drop: noop, pose: noop, anchors: noop, note: id => { host.dataset.selection = id; }, noteMove: noop, labelMove: noop, renameName: noop, focusName: noop, copyName: noop, status: noop, align: noop, clearSelection: () => { host.dataset.selection = 'empty'; }, axis: noop });
await view.load(project);
await view.prepareCapture();
const outlines = (): SVGPathElement[] => [...host.querySelectorAll<SVGPathElement>('.annotation-outlines path')];
const measure = (id: string) => {
  const path = outlines().find(element => element.dataset.noteId === id)!;
  const bounds = path.getBBox();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, stroke: path.getAttribute('stroke'), lineWidth: Number(path.getAttribute('stroke-width')) };
};
function setCamera(eye: Vec3, target: Vec3 = [0, 0, 0]): void {
  view.setCamera({ eye, target, up: [0, 0, 1], margin: 1.25 });
}
function state(eye: Vec3, target: Vec3 = [0, 0, 0]) {
  view.show(project, step, frame, 'current'); setCamera(eye, target); view.capture();
  const measurements = ['rectangle', 'circle'].map(id => {
    const mark = frame.notes.find(note => note.id === id)!;
    const point = view.meshes.get(part.id)!.localToWorld(new Vector3(...mark.anchors[0].point)).project(view.camera);
    const expected = { x: (point.x + 1) * 450, y: (1 - point.y) * 300 };
    return { id, ...measure(id), expected };
  });
  return { eye, measurements };
}
const angles = [[0, -300, 40], [300, 0, 35], [160, 220, 180], [-130, -100, 300]] satisfies Vec3[];
const orbit = angles.map(eye => state(eye));
frame.poses[part.id] = { position: [20, 15, 30], quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .8).toArray() };
const moved = state([0, -300, 60]);
frame.poses[part.id] = structuredClone(part.home);
const beforeZoom = state([0, -300, 0]);
const afterZoom = state([0, -600, 0]);
frame.hidden = [part.id]; view.show(project, step, frame, 'current'); view.capture();
const hiddenCount = outlines().length;
frame.hidden = [];
setCamera([0, -300, 0]); view.show(project, step, frame, 'current');
view.restoreSection({ amount: .5, normal: [1, 0, 0] }); view.capture();
const clippedIds = outlines().map(element => element.dataset.noteId);
view.setSection(0); state([0, -300, 0]);
frame.notes[0].hidden = true; view.show(project, step, frame, 'current'); view.capture();
const hiddenNoteIds = outlines().map(element => element.dataset.noteId);
frame.notes[0].hidden = false;
setCamera([0, -300, 0], [0, -500, 0]); view.show(project, step, frame, 'current'); view.capture();
const behindCameraCount = outlines().length;
state([0, -300, 0]);

const capture = view.capture(), ratio = view.renderer.getPixelRatio();
const svg = host.querySelector<SVGSVGElement>('.annotation-outlines')!.cloneNode(true) as SVGSVGElement;
svg.setAttribute('width', '900'); svg.setAttribute('height', '600');
const imageUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
const image = new Image(); image.src = imageUrl; await image.decode();
const reference = document.createElement('canvas'); reference.width = capture.width; reference.height = capture.height;
const context = reference.getContext('2d')!; context.scale(ratio, ratio); context.drawImage(image, 0, 0);
const expected = context.getImageData(0, 0, reference.width, reference.height).data;
const actual = capture.getContext('2d')!.getImageData(0, 0, capture.width, capture.height).data;
let samples = 0, matching = 0, partialCoverage = 0;
for (let index = 0; index < expected.length; index += 4) {
  const alpha = expected[index + 3];
  if (alpha > 0 && alpha < 255) partialCoverage++;
  if (alpha < 250) continue;
  samples++;
  if (Math.abs(actual[index] - 35) <= 3 && Math.abs(actual[index + 1] - 169) <= 3 && Math.abs(actual[index + 2] - 46) <= 3) matching++;
}

project.settings.showLabels = true;
project.settings.labelMode = 'part';
project.settings.labelOffsets[part.id] = [180, -160];
view.show(project, step, frame, 'current'); view.capture();
const leader = host.querySelector<SVGLineElement>('svg.canvas-leaders:not(.annotation-outlines) line')!;
const dot = host.querySelector<SVGCircleElement>('svg.canvas-leaders:not(.annotation-outlines) circle')!;
const leaderStyle = { color: leader.getAttribute('stroke'), lineWidth: Number(leader.getAttribute('stroke-width')), dotRadius: Number(dot.getAttribute('r')), text: getComputedStyle(host.querySelector('.part-label')!).color };
project.settings.showLabels = false; view.show(project, step, frame, 'current'); view.capture();
const rectangle = measure('rectangle'), circle = measure('circle');
const head = outlines().find(element => element.dataset.noteId === 'arrow' && element.getAttribute('fill') !== 'none')!;
const headBounds = head.getBBox();
const clicks = {
  rectangle: { x: rectangle.x, y: rectangle.y + rectangle.height / 4 },
  circle: { x: circle.x + circle.width, y: circle.y + circle.height / 2 },
  hollow: { x: circle.x + circle.width / 2, y: circle.y + circle.height / 2 },
  arrowhead: { x: headBounds.x + headBounds.width / 2, y: headBounds.y + headBounds.height / 2 },
};
const report = { ratio, orbit, moved, beforeZoom, afterZoom, hiddenCount, clippedIds, hiddenNoteIds, behindCameraCount, samples, matching, partialCoverage, leaderStyle, clicks };
function zoomOutAnnotations() {
  frame.notes.forEach(note => { note.size = 5; note.hidden = note.kind === 'arrow'; });
  state([0, -1600, 0]);
  return ['rectangle', 'circle'].map(id => {
    const bounds = measure(id);
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, radius: bounds.width / 2 };
  });
}
declare global { interface Window { annotationRenderingReport: typeof report; zoomOutAnnotations: typeof zoomOutAnnotations } }
window.annotationRenderingReport = report;
window.zoomOutAnnotations = zoomOutAnnotations;
document.querySelector('output')!.textContent = JSON.stringify(report);
URL.revokeObjectURL(imageUrl); URL.revokeObjectURL(file); geometry.dispose();
document.documentElement.dataset.complete = 'true';
