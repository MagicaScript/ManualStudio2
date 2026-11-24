import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { SectionView, SectionRenderPass } from './section-view.ts';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Navigator } from './navigator.ts';
import { ConstructionAxes } from './construction-axes.ts';
import { orbitDirection, viewDirections } from '../shared/navigation.ts';
import { loadGeometries, surfaceAnchor, type PickSettings } from './geometry.ts';
import { applySurfacePaint, type SurfacePaint } from './surface-paint.ts';
import type { Anchor, AssemblyStep, Camera, DisplayMode, Keyframe, Note, NoteKind, Part, Pose, Project, Vec3 } from '../shared/types.ts';
import { assembledPartIds, copy, DEFAULT_LABEL_OFFSET, explodedPoses, frameLabels, homePose, interpolatedFrameCamera, interpolatedFramePose, interpolateOffset, makeStep, type FrameInterpolation } from '../shared/document.ts';
import { browserRoots, modelVisibility } from '../shared/model-tree.ts';
import { playbackFrame, playbackInterpolation, type PlaybackSegment } from '../shared/playback.ts';
import { curveOffset, curveVector } from '../shared/motion-curve.ts';
import { arrangeLabelBoxes, measureLabelBox, type LabelLayoutBox } from '../shared/text-layout.ts';
import { AnnotationOverlay } from './annotation-overlay.ts';
import { icon } from './icons.ts';
import { planLabelMotion, positionAnimatedLabel } from './label-motion.ts';
import { ANNOTATION_LINE_WIDTH, LEADER_DOT_RADIUS, PART_LABEL_LINE_COLOR, PART_LABEL_DOT_COLOR } from '../shared/render-style.ts';
import { videoHeight, videoLayoutSize, videoWidth } from '../shared/video-format.ts';

export type ViewTool = 'select' | 'move' | 'rotate' | 'measure' | 'align' | NoteKind;
export interface SectionState { amount: number; normal: Vec3 }
export type NameTarget = { kind: 'part'; id: string } | { kind: 'object'; id: string } | { kind: 'axis'; id: string } | { kind: 'group'; id: string; stepId: string };
interface Callbacks {
  select(id: string, multiple: boolean, individual: boolean): void;
  contextMenu?(id: string, event: PointerEvent): void;
  dragHover?(target: Element | null): void;
  drop(ids: string[], x: number, y: number): void;
  pose(poses: Record<string, Pose>): void;
  anchors(anchors: Anchor[], kind: NoteKind): void;
  note(id: string): void;
  noteMove(id: string, offset: [number, number]): void;
  labelMove(id: string, offset: [number, number]): void;
  renameName(target: NameTarget, element: HTMLElement): void;
  focusName(target: NameTarget): void;
  copyName(name: string): void;
  status(text: string): void;
  align(source: Anchor, target: Anchor, faces: boolean): void;
  clearSelection(): void;
  axis(id: string): void;
}
interface LabelDefinition {
  id: string; partId: string; point: Vec3; offset: readonly [number, number]; text: string; color: string; background: string;
  fontSize: number; kind?: NoteKind; target?: NameTarget; groupParts?: string[];
}
interface Label extends LabelDefinition { element: HTMLButtonElement; offset: [number, number]; isPart: boolean; x: number; y: number; world: THREE.Vector3; icon?: HTMLImageElement }
interface MeasuredLabel extends LabelDefinition { width: number; height: number }
interface MotionPosition extends LabelLayoutBox { id: string; world: THREE.Vector3 }
interface AnnotationPin { mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>; anchor: Anchor; labelId?: string }
interface AnnotationViewport { width: number; height: number; fullWidth: number; insetX: number; scale: number }
const videoAnnotationScale = videoHeight / videoLayoutSize.height;
const videoAnnotationWidth = videoWidth / videoAnnotationScale;
const videoAnnotations: AnnotationViewport = {
  ...videoLayoutSize, fullWidth: videoAnnotationWidth, insetX: (videoAnnotationWidth - videoLayoutSize.width) / 2, scale: videoAnnotationScale,
};
function projectLabelAnchor(projected: THREE.Vector3, { fullWidth, height, insetX }: AnnotationViewport) {
  return { anchorX: (projected.x + 1) * fullWidth / 2 - insetX, anchorY: (1 - projected.y) * height / 2 };
}
interface PlaybackLayout {
  project: Project; segment: PlaybackSegment; projection: string; viewport: AnnotationViewport; cameraFallback: Camera;
  labels?: {
    from: Map<string, MeasuredLabel>; to: Map<string, MeasuredLabel>; before?: Map<string, LabelDefinition>; after?: Map<string, LabelDefinition>;
    tracks?: ReturnType<typeof planLabelMotion>;
  };
}
interface TransparentItem { object: THREE.Object3D; groupOrder: number; renderOrder: number; z: number; id: number }
export class Viewport {
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, .1, 100000);
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  readonly meshes = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>();
  readonly composer: EffectComposer;
  readonly outline: OutlinePass;
  readonly geometries = new Map<string, THREE.BufferGeometry>();
  pickSettings: PickSettings = { target: 'point', region: 'face', radius: 5, width: 10, axis: 'auto', angle: 25 };
  tool: ViewTool = 'select';
  selectionMode: 'object' | 'part' = 'part';
  private readonly raycaster = new THREE.Raycaster();
  private readonly pivot = new THREE.Group();
  private readonly annotationRoot = new THREE.Group();
  private readonly annotationPins: AnnotationPin[] = [];
  private paintCleanups: (() => void)[] = [];
  private readonly axes = new THREE.AxesHelper(70);
  private readonly lightRig = new THREE.Group();
  private readonly constructionAxes = new ConstructionAxes();
  private readonly clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private readonly sectionView = new SectionView(this.clip);
  private sectionAmount = 0;
  private assemblyRadius = 1;
  private explosionRatio = 1;
  private sectionActive = false;
  private transparentDepth = new Map<number, number>();
  private readonly labelsHost = document.createElement('div');
  private readonly leaderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private labels: Label[] = [];
  private readonly labelContext = document.createElement('canvas').getContext('2d')!;
  private playback?: { layout: PlaybackLayout; progress: number };
  private playbackLayout?: PlaybackLayout;
  private playbackBoxes?: Map<string, MotionPosition>;
  private videoCapture = false;
  private videoLabelMetrics?: WeakMap<HTMLButtonElement, ReturnType<Viewport['measureLabel']>>;
  private connectionIcons = new Map<NoteKind, HTMLImageElement>();
  private draggingLabel?: Label;
  private readonly annotationOverlay = new AnnotationOverlay();
  private noteTargets = new Map<THREE.Object3D, string>();
  private selected: string[] = [];
  private project?: Project;
  private step?: AssemblyStep;
  private frame?: Keyframe;
  private cameraMargin = 1.25;
  private mode: DisplayMode = 'all';
  private drag?: { start: THREE.Vector2; ids: string[]; pointerId: number; moved: boolean };
  private contextPress?: THREE.Vector2;
  private brush: Anchor[] = [];
  private pendingArrow?: Anchor;
  private alignmentStart?: Anchor;
  private measurePoints: THREE.Vector3[] = [];
  private originals = new Map<string, THREE.Matrix4>();
  private pivotStart = new THREE.Matrix4();
  private dirty = true;
  private labelsSignature = '';
  private raf = 0;
  private observer: ResizeObserver;
  private ghost = document.createElement('div');
  private canvasPointer = new THREE.Vector2();
  private thumbnailQueue: { part: Part; canvas: HTMLCanvasElement }[] = [];
  private thumbnailCache = new Map<string, HTMLCanvasElement>();
  private thumbScene = new THREE.Scene();
  private thumbCamera = new THREE.PerspectiveCamera(32, 1, .01, 100000);
  private thumbBusy = false;
  private displayHidden = new Set<string>();
  private isolated = new Set<string>();
  private loadSequence = 0;
  private navigator?: Navigator;
  private blankPointer = false;
  constructor(readonly host: HTMLElement, private callbacks: Callbacks) {
    for (const kind of ['clip', 'glue', 'screw'] as const) {
      const image = new Image();
      image.onload = () => { this.dirty = true; };
      image.src = `data:image/svg+xml,${encodeURIComponent(icon(kind, '#f2f2f2'))}`;
      this.connectionIcons.set(kind, image);
    }
    this.scene.background = new THREE.Color('#53545b'); this.camera.up.set(0, 0, 1); this.camera.position.set(600, -900, 500);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = .95;
    this.renderer.setTransparentSort((a: TransparentItem, b: TransparentItem) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || (this.transparentDepth.get(a.object.id) ?? -a.z) - (this.transparentDepth.get(b.object.id) ?? -b.z) || a.id - b.id);
    this.renderer.domElement.setAttribute('aria-label', '3D assembly workspace'); host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .14;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    const navigatorHost = document.querySelector<HTMLElement>('.view-cube'); if (navigatorHost) this.navigator = new Navigator(navigatorHost, this.camera, direction => this.setDirection(direction), (dx, dy) => this.setDirection(orbitDirection(this.camera.position.clone().sub(this.controls.target).toArray(), dx, dy)));
    for (const [x, y, z, intensity] of [[-.4575, .4575, .7625, 2.6], [.6985, .1397, .6985, .85], [.1397, .6985, .6985, .85]]) {
      const light = new THREE.DirectionalLight(0xffffff, intensity); light.position.set(x, y, z); this.lightRig.add(light, light.target);
    }
    this.scene.add(this.lightRig, new THREE.AmbientLight(0xffffff, .8), this.pivot, this.annotationRoot, this.axes, this.constructionAxes.root, this.sectionView.root); this.axes.visible = false;
    this.transform = new TransformControls(this.camera, this.renderer.domElement); this.transform.setSize(.8); this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', event => { this.controls.enabled = !event.value; this.dirty = true; });
    this.transform.addEventListener('mouseDown', () => { this.pivot.updateMatrixWorld(true); this.pivotStart.copy(this.pivot.matrixWorld); this.originals.clear(); this.selected.forEach(id => { const mesh = this.meshes.get(id); if (mesh) this.originals.set(id, mesh.matrixWorld.clone()); }); });
    this.transform.addEventListener('objectChange', () => {
      this.pivot.updateMatrixWorld(true); const delta = this.pivot.matrixWorld.clone().multiply(this.pivotStart.clone().invert());
      this.originals.forEach((matrix, id) => { const mesh = this.meshes.get(id)!; delta.clone().multiply(matrix).decompose(mesh.position, mesh.quaternion, mesh.scale); mesh.updateMatrixWorld(true); }); this.dirty = true;
    });
    this.transform.addEventListener('mouseUp', () => { if (this.originals.size) this.callbacks.pose(this.poses(this.selected)); this.originals.clear(); });
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, stencilBuffer: true, samples: Math.min(4, this.renderer.capabilities.maxSamples) });
    this.composer = new EffectComposer(this.renderer, renderTarget); this.composer.addPass(new SectionRenderPass(this.scene, this.camera, this.sectionView, () => this.meshes.values()));
    this.outline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera); this.outline.visibleEdgeColor.set('#fff94a'); this.outline.hiddenEdgeColor.set('#e4ce35'); this.outline.edgeStrength = 5; this.outline.edgeThickness = 1.2; this.composer.addPass(this.outline); this.composer.addPass(new OutputPass());
    this.labelsHost.className = 'canvas-labels'; this.leaderSvg.classList.add('canvas-leaders'); host.append(this.annotationOverlay.element, this.leaderSvg, this.labelsHost);
    this.ghost.className = 'part-drag-ghost'; this.ghost.hidden = true; document.body.append(this.ghost);
    this.renderer.domElement.addEventListener('pointerdown', event => this.pointerDown(event), true);
    this.renderer.domElement.addEventListener('pointermove', event => this.pointerMove(event));
    this.renderer.domElement.addEventListener('pointerup', event => this.pointerUp(event));
    this.renderer.domElement.addEventListener('pointercancel', () => this.cancelPointer());
    this.renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
    this.renderer.domElement.addEventListener('dblclick', event => { const hit = this.hit(event); this.fit(hit ? [String(hit.object.userData.partId)] : undefined); });
    this.thumbScene.background = new THREE.Color('#35363a'); this.thumbScene.add(new THREE.HemisphereLight(0xffffff, 0x50505a, 2.4)); const thumbLight = new THREE.DirectionalLight(0xffffff, 2.5); thumbLight.position.set(2, -3, 4); this.thumbScene.add(thumbLight); this.thumbCamera.up.set(0, 0, 1);
    this.observer = new ResizeObserver(() => { if (!this.videoCapture) this.resize(); }); this.observer.observe(host); this.resize(); this.animate();
  }
  async load(project: Project, isCurrent?: () => boolean): Promise<void> {
    this.paintCleanups.forEach(cleanup => cleanup()); this.paintCleanups = [];
    this.sectionAmount = 0; this.sectionActive = this.sectionView.active = false;
    const sequence = ++this.loadSequence;
    const geometries = await loadGeometries(project.model.parts);
    if (sequence !== this.loadSequence || isCurrent?.() === false) { geometries.forEach(geometry => geometry.dispose()); return; }
    if (this.drag && this.renderer.domElement.hasPointerCapture(this.drag.pointerId)) this.renderer.domElement.releasePointerCapture(this.drag.pointerId);
    this.cancelPointer(); this.displayHidden.clear(); this.isolated.clear(); this.selected = []; this.outline.selectedObjects = [];
    this.brush = []; this.measurePoints = []; this.originals.clear(); this.draggingLabel = undefined; this.blankPointer = false;
    this.step = undefined; this.frame = undefined; this.playback = undefined; this.playbackLayout = undefined; this.mode = 'all'; this.explosionRatio = 1; this.setTool('select'); this.disposeAnnotationObjects();
    this.transform.detach(); this.meshes.forEach(mesh => { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }); this.meshes.clear(); this.geometries.clear(); this.thumbnailCache.clear(); this.thumbnailQueue = [];
    for (const part of project.model.parts) {
      const geometry = geometries.get(part.id)!; this.geometries.set(part.id, geometry);
      const material = new THREE.MeshStandardMaterial({ color: part.color, roughness: .68, metalness: .04, side: THREE.DoubleSide, alphaToCoverage: true });
      const mesh = new THREE.Mesh(geometry, material); mesh.userData.partId = part.id; mesh.name = part.name; mesh.position.fromArray(part.home.position); this.meshes.set(part.id, mesh); this.scene.add(mesh);
    }
    this.constructionAxes.load(project); this.sectionView.load(this.meshes.values());
    const bounds = new THREE.Box3(); this.meshes.forEach(mesh => { mesh.updateMatrixWorld(true); bounds.expandByObject(mesh); }); this.assemblyRadius = bounds.getSize(new THREE.Vector3()).length() / 2;
    this.project = project; this.labelsSignature = ''; this.dirty = true;
  }
  show(project: Project, step?: AssemblyStep, frame?: Keyframe, mode: DisplayMode = 'all', explosion = 1, unassembledOnly = false): void {
    this.playback = undefined;
    if (this.step?.id !== step?.id || this.frame?.id !== frame?.id) this.measurePoints = [];
    this.project = project; this.step = step; this.frame = frame; this.mode = mode;
    const visibility = modelVisibility(project);
    this.explosionRatio = explosion;
    const selectedIds = new Set(step?.partIds ?? []); const overview = !step; const overviewStep = overview && explosion > 1 ? makeStep(project, 'Overall preview', project.model.parts.filter(p => p.sourceStatus === 'active').map(p => p.id)) : undefined;
    const frameXray = new Set(frame?.xrayPartIds);
    const expanded = overviewStep ? explodedPoses(project, overviewStep, explosion - 1, false) : undefined;
    const assembled = overview && unassembledOnly ? assembledPartIds(project) : undefined;
    const finalStep = project.steps.find(s => s.final); const final = finalStep?.frames.at(-1);
    const earlierRemoved = new Set(step ? project.steps.slice(0, project.steps.indexOf(step)).flatMap(s => s.removePartIds) : []);
    for (const part of project.model.parts) {
      const mesh = this.meshes.get(part.id); if (!mesh) continue;
      const included = selectedIds.has(part.id); const removed = frame?.hidden.includes(part.id) ?? false;
      mesh.visible = (visibility.parts.get(part.id) ?? true) && !removed && !this.displayHidden.has(part.id) && (!this.isolated.size || this.isolated.has(part.id)) && (included || part.sourceStatus === 'active' && !earlierRemoved.has(part.id) && (overview || mode !== 'current'))
        && !(overview && final?.hidden.includes(part.id)) && !assembled?.has(part.id);
      const pose = expanded?.[part.id] ?? (included ? frame?.poses[part.id] : undefined) ?? (overview ? final?.poses[part.id] : undefined) ?? homePose(part);
      mesh.position.fromArray(pose.position); mesh.quaternion.fromArray(pose.quaternion); mesh.updateMatrixWorld(true);
      const ghost = included ? frameXray.has(part.id) : !overview && mode === 'xray'; mesh.material.transparent = ghost; mesh.material.opacity = ghost ? .15 : 1; mesh.material.depthWrite = true;
      if (mesh.material.alphaToCoverage === ghost) { mesh.material.alphaToCoverage = !ghost; mesh.material.needsUpdate = true; }
      const side = ghost ? THREE.FrontSide : THREE.DoubleSide; if (mesh.material.side !== side) { mesh.material.side = side; mesh.material.needsUpdate = true; }
      mesh.material.color.set(this.selected.includes(part.id) ? '#e7dd69' : part.color); mesh.material.emissive.set(this.selected.includes(part.id) ? '#403809' : '#000000');
      mesh.renderOrder = ghost ? 1 : 0;
    }
    this.axes.visible = project.settings.showAxes; this.refreshAnnotations(); this.attachTransform(); this.updateSectionPlane(); this.dirty = true;
  }
  showPlayback(project: Project, segment: PlaybackSegment, progress: number, mode: DisplayMode, explosion = 1): void {
    const layout = this.getPlaybackLayout(project, segment);
    this.show(project, segment.step, playbackFrame(segment, progress, project.settings), mode, explosion);
    this.playback = { layout, progress };
    this.setPlaybackCamera(layout, progress);
  }
  private getPlaybackLayout(project: Project, segment: PlaybackSegment): PlaybackLayout {
    const viewport = this.annotationViewport, { from, to, step, before, after } = segment;
    const projection = [0, 5, 8, 9].map(index => this.camera.projectionMatrix.elements[index]).join(',');
    let layout = this.playbackLayout;
    if (!layout || layout.project !== project || layout.segment.step !== step || layout.segment.from !== from || layout.segment.to !== to ||
      layout.viewport.width !== viewport.width || layout.viewport.height !== viewport.height || layout.viewport.scale !== viewport.scale || layout.projection !== projection) {
      const cameraFallback = from.camera && to.camera && (!before || before.camera) && (!after || after.camera)
        ? from.camera : step.frames.find(frame => frame.camera)?.camera ?? this.fitPlaybackCamera(project, step);
      layout = { project, segment, viewport, projection, cameraFallback };
      this.playbackLayout = layout;
    }
    return layout;
  }
  private setPlaybackCamera(layout: PlaybackLayout, progress: number): void {
    const { from, to } = layout.segment;
    const camera = interpolatedFrameCamera(from, to, playbackInterpolation(layout.segment, progress), layout.cameraFallback) ?? layout.cameraFallback;
    const damping = this.controls.enableDamping; this.controls.enableDamping = false;
    this.controls.update(); this.setCamera(camera); this.controls.enableDamping = damping;
  }
  private fitPlaybackCamera(project: Project, step: AssemblyStep): Camera {
    const bounds = new THREE.Box3(), matrix = new THREE.Matrix4(), origin = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
    const box = new THREE.Box3();
    for (const part of project.model.parts) {
      if (!step.partIds.includes(part.id)) continue;
      const geometry = this.meshes.get(part.id)?.geometry.boundingBox;
      if (!geometry) continue;
      for (const frame of step.frames) {
        const pose = frame.poses[part.id] ?? homePose(part);
        matrix.compose(origin.fromArray(pose.position), rotation.fromArray(pose.quaternion), scale);
        bounds.union(box.copy(geometry).applyMatrix4(matrix));
      }
    }
    const sphere = bounds.getBoundingSphere(new THREE.Sphere()), margin = 1.2;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2), limitingFov = Math.atan(Math.tan(halfFov) * Math.min(1, this.camera.aspect));
    const eye = new THREE.Vector3(...viewDirections.iso).normalize().multiplyScalar(Math.max(1, sphere.radius * margin / Math.sin(limitingFov))).add(sphere.center);
    return { eye: eye.toArray(), target: sphere.center.toArray(), up: [0, 0, 1], margin };
  }
  select(ids: string[]): void {
    this.constructionAxes.select();
    this.selected = ids.filter(id => this.meshes.has(id));
    if (this.project) this.project.model.parts.forEach(part => { const mesh = this.meshes.get(part.id)!; mesh.material.color.set(ids.includes(part.id) ? '#e7dd69' : part.color); mesh.material.emissive.set(ids.includes(part.id) ? '#403809' : '#000000'); });
    this.outline.selectedObjects = this.selected.map(id => this.meshes.get(id)!).filter(mesh => mesh.visible); this.attachTransform(); this.dirty = true;
  }
  setTool(tool: ViewTool): void { this.tool = tool; this.pendingArrow = undefined; this.alignmentStart = undefined; this.measurePoints = []; this.controls.enabled = true; this.renderer.domElement.style.cursor = ['select', 'move', 'rotate'].includes(tool) ? 'default' : 'crosshair'; this.attachTransform(); this.dirty = true; }
  selectAxis(id?: string, focus = false): void {
    this.constructionAxes.select(id);
    const center = id && focus ? this.constructionAxes.center(id) : undefined;
    if (center) { const delta = center.clone().sub(this.controls.target); this.camera.position.add(delta); this.controls.target.copy(center); this.controls.update(); }
    this.dirty = true;
  }
  setSnap(value: boolean): void { this.transform.setRotationSnap(value ? Math.PI / 12 : null); this.transform.setTranslationSnap(value ? 1 : null); }
  get snapEnabled(): boolean { return this.transform.translationSnap !== null; }
  setSpace(space: 'local' | 'world'): void { this.transform.setSpace(space); }
  private attachTransform(): void {
    this.transform.detach(); if (!['move', 'rotate'].includes(this.tool) || !this.selected.length) return;
    const ids = this.selected.filter(id => !this.step || this.step.partIds.includes(id)); if (ids.length !== this.selected.length) return;
    this.pivot.position.set(0, 0, 0); ids.forEach(id => this.pivot.position.add(this.meshes.get(id)!.position)); this.pivot.position.divideScalar(ids.length); this.pivot.quaternion.identity(); this.pivot.updateMatrixWorld(true);
    this.transform.setMode(this.tool === 'move' ? 'translate' : 'rotate'); this.transform.attach(this.pivot);
  }
  poses(ids = this.step?.partIds ?? []): Record<string, Pose> { return Object.fromEntries(ids.map(id => { const mesh = this.meshes.get(id)!; return [id, { position: mesh.position.toArray(), quaternion: mesh.quaternion.toArray() }]; })); }
  cameraState(): Camera { return { eye: this.camera.position.toArray(), target: this.controls.target.toArray(), up: this.camera.up.toArray(), margin: this.cameraMargin }; }
  setCamera(camera?: Camera): void { if (!camera) return; this.cameraMargin = camera.margin; this.camera.position.fromArray(camera.eye); this.controls.target.fromArray(camera.target); this.camera.up.fromArray(camera.up); this.controls.update(); this.dirty = true; }
  fit(ids?: string[], margin = 1.25): void {
    this.cameraMargin = margin;
    const frame = this.updateProjectionFrame();
    const visible = (ids ? ids.map(id => this.meshes.get(id)) : [...this.meshes.values()]).filter((mesh): mesh is THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> => !!mesh?.visible);
    const bounds = new THREE.Box3(); visible.forEach(mesh => bounds.expandByObject(mesh)); if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    let direction = this.camera.position.clone().sub(this.controls.target).normalize(); if (!direction.lengthSq()) direction = new THREE.Vector3(1, -1, .6).normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize(); const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)); const tanHorizontal = tanVertical * this.camera.aspect;
    const horizontalRoom = Math.max(.2, (frame.right - frame.left) / this.host.clientWidth); const verticalRoom = .78;
    let distance = 1;
    for (const mesh of visible) {
      const box = mesh.geometry.boundingBox!;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const point = new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld).sub(center); const depth = point.dot(direction);
        distance = Math.max(distance, Math.abs(point.dot(right)) * margin / (tanHorizontal * horizontalRoom) + depth, Math.abs(point.dot(up)) * margin / (tanVertical * verticalRoom) + depth);
      }
    }
    this.controls.target.copy(center); this.camera.position.copy(center).addScaledVector(direction, distance); this.camera.near = Math.max(.01, distance / 20000); this.camera.far = Math.max(10000, distance * 30); this.camera.updateProjectionMatrix(); this.controls.update(); this.dirty = true;
  }
  view(name: string): void { this.setDirection(viewDirections[name] ?? viewDirections.iso); }
  setDirection(direction: Vec3): void {
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    const distance = this.camera.position.distanceTo(this.controls.target); const vector = new THREE.Vector3(...direction).normalize(); if (vector.x === 0 && vector.y === 0) vector.y = -1e-6;
    this.camera.up.set(0, 0, 1); this.camera.position.copy(this.controls.target).addScaledVector(vector.normalize(), distance); this.camera.lookAt(this.controls.target); this.controls.update(); this.controls.enableDamping = damping; this.dirty = true;
  }
  setSection(amount: number, resetDirection = false): void {
    if (amount === this.sectionAmount && !resetDirection) return;
    if (!this.sectionActive || resetDirection) this.camera.getWorldDirection(this.clip.normal);
    this.applySection(amount);
  }
  sectionState(): SectionState { return { amount: this.sectionAmount, normal: this.clip.normal.toArray() }; }
  restoreSection(state: SectionState): void { this.clip.normal.fromArray(state.normal); this.applySection(state.amount); }
  private applySection(amount: number): void {
    this.sectionAmount = amount; this.sectionActive = this.sectionView.active = amount > 0; this.updateSectionPlane(); this.meshes.forEach(mesh => { mesh.material.clippingPlanes = this.sectionActive ? [this.clip] : []; });
    this.annotationRoot.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => { material.clippingPlanes = this.sectionActive ? [this.clip] : []; }); } }); this.dirty = true;
  }
  private updateSectionPlane(): void {
    if (!this.sectionActive) return;
    const bounds = new THREE.Box3(); this.meshes.forEach(mesh => { if (mesh.visible) bounds.expandByObject(mesh); });
    this.clip.constant = -this.clip.normal.dot(bounds.getCenter(new THREE.Vector3())) + this.assemblyRadius * this.explosionRatio * (1 - 2 * this.sectionAmount);
  }
  setVisibility(ids: string[], visible: boolean): void { ids.forEach(id => visible ? this.displayHidden.delete(id) : this.displayHidden.add(id)); this.playbackLayout = undefined; }
  isolate(ids: string[]): void { this.isolated = new Set(ids); this.playbackLayout = undefined; }
  private hits(event: PointerEvent | MouseEvent): THREE.Intersection[] {
    const rect = this.renderer.domElement.getBoundingClientRect(); this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hits = this.raycaster.intersectObjects([...this.meshes.values()].filter(mesh => mesh.visible), false);
    return hits.filter(hit => !this.meshes.get(String(hit.object.userData.partId))!.material.clippingPlanes?.length || this.clip.distanceToPoint(hit.point) >= 0);
  }
  private hit(event: PointerEvent | MouseEvent): THREE.Intersection | undefined {
    const hits = this.hits(event); if (!hits.length) return;
    if (event.altKey) { const ids = [...new Set(hits.map(h => String(h.object.userData.partId)))]; const current = ids.indexOf(this.selected[0]); return hits.find(h => String(h.object.userData.partId) === ids[(current + 1) % ids.length]); }
    return hits[0];
  }
  private anchor(event: PointerEvent, withRegion = false): Anchor | undefined { const hit = this.hit(event); if (!hit) return; const id = String(hit.object.userData.partId); return surfaceAnchor(hit, id, this.meshes.get(id)!, this.pickSettings, withRegion); }
  private hitNote(event: PointerEvent): string | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const overlayNote = this.annotationOverlay.hit(event.clientX - rect.left, event.clientY - rect.top);
    if (overlayNote) return overlayNote;
    if (!this.noteTargets.size) return;
    this.raycaster.setFromCamera(new THREE.Vector2(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height), this.camera);
    const viewDirection = this.camera.getWorldDirection(new THREE.Vector3());
    const center = new THREE.Vector3();
    const pixelFactor = 12 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / rect.height;
    let closest: THREE.Intersection | undefined;
    for (const object of this.noteTargets.keys()) {
      if (!object.visible || !object.parent?.visible) continue;
      object.updateWorldMatrix(true, false);
      const depth = object.getWorldPosition(center).sub(this.camera.position).dot(viewDirection);
      this.raycaster.params.Line.threshold = Math.max(.001, pixelFactor * depth);
      const hit = this.raycaster.intersectObject(object, false).find(candidate => !this.sectionActive || this.clip.distanceToPoint(candidate.point) >= 0);
      if (hit && (!closest || hit.distance < closest.distance)) closest = hit;
    }
    return closest && this.noteTargets.get(closest.object);
  }
  private pointerDown(event: PointerEvent): void {
    if (event.button === 2) {
      this.contextPress = this.tool === 'select' ? new THREE.Vector2(event.clientX, event.clientY) : undefined;
      return;
    }
    if (event.button !== 0 || this.transform.axis) return; this.canvasPointer.set(event.clientX, event.clientY); this.blankPointer = false;
    if (this.tool === 'select') {
      const noteId = !event.altKey && this.hitNote(event);
      if (noteId) {
        this.controls.enabled = false;
        this.renderer.domElement.setPointerCapture(event.pointerId);
        this.callbacks.note(noteId);
        return;
      }
      const hit = this.hit(event); if (!hit) {
        this.raycaster.params.Line.threshold = this.camera.position.distanceTo(this.controls.target) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 6 / Math.max(this.host.clientHeight, 1);
        const axisId = this.constructionAxes.pick(this.raycaster); if (axisId) { this.callbacks.axis(axisId); return; }
        this.blankPointer = true; return;
      }
      this.controls.enabled = false; this.callbacks.select(String(hit.object.userData.partId), event.ctrlKey || event.shiftKey, event.altKey);
      this.drag = { start: new THREE.Vector2(event.clientX, event.clientY), ids: [...this.selected], pointerId: event.pointerId, moved: false }; this.renderer.domElement.setPointerCapture(event.pointerId); return;
    }
    if ((this.tool === 'move' || this.tool === 'rotate') && !this.hit(event)) { this.blankPointer = true; return; }
    if (!['move', 'rotate'].includes(this.tool)) {
      this.controls.enabled = false;
      if (this.tool === 'pencil' || this.tool === 'glue' && this.pickSettings.region === 'brush') { this.brush = []; this.sampleBrush(event); this.renderer.domElement.setPointerCapture(event.pointerId); }
    }
  }
  private sampleBrush(event: PointerEvent): void { const anchor = this.anchor(event, this.tool === 'glue'); if (!anchor) return; const last = this.brush.at(-1); if (!last || last.partId !== anchor.partId || new THREE.Vector3(...last.point).distanceTo(new THREE.Vector3(...anchor.point)) > Math.max(.3, this.pickSettings.radius / 3)) this.brush.push(anchor); }
  private pointerMove(event: PointerEvent): void {
    if (this.contextPress && this.contextPress.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) this.contextPress = undefined;
    if (this.drag) {
      if (this.drag.start.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 6) this.drag.moved = true;
      if (this.drag.moved) {
        this.ghost.hidden = false;
        this.ghost.textContent = `${this.drag.ids.length} part${this.drag.ids.length === 1 ? '' : 's'} → step`;
        this.ghost.style.transform = `translate(${event.clientX + 16}px,${event.clientY + 14}px)`;
        this.callbacks.dragHover?.(document.elementFromPoint(event.clientX, event.clientY));
      }
      return;
    }
    if (event.buttons === 1 && (this.tool === 'pencil' || this.tool === 'glue' && this.pickSettings.region === 'brush')) this.sampleBrush(event);
  }
  private pointerUp(event: PointerEvent): void {
    if (event.button === 2) {
      const start = this.contextPress;
      this.contextPress = undefined;
      if (!start || this.tool !== 'select' || start.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5 || document.elementFromPoint(event.clientX, event.clientY) !== this.renderer.domElement) return;
      const hit = this.hit(event);
      if (hit) this.callbacks.contextMenu?.(String(hit.object.userData.partId), event);
      return;
    }
    if (event.button !== 0) return;
    if (this.drag) { const drag = this.drag; this.cancelPointer(); if (drag.moved) this.callbacks.drop(drag.ids, event.clientX, event.clientY); return; }
    this.controls.enabled = true;
    if (this.blankPointer && this.canvasPointer.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) < 5) { this.blankPointer = false; this.callbacks.clearSelection(); return; }
    if (this.tool === 'pencil' || this.tool === 'glue' && this.pickSettings.region === 'brush') { if (this.brush.length) this.callbacks.anchors(this.brush, this.tool); this.brush = []; return; }
    if (this.canvasPointer.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 7 || ['select', 'move', 'rotate'].includes(this.tool)) return;
    if (this.tool === 'measure') { const hit = this.hit(event); if (!hit) return; this.measurePoints.push(hit.point.clone()); if (this.measurePoints.length === 2) { this.callbacks.status(`Distance: ${this.measurePoints[0].distanceTo(this.measurePoints[1]).toFixed(3)} mm`); this.measurePoints = []; } else this.callbacks.status('Choose the second surface point.'); return; }
    const anchor = this.anchor(event, this.tool === 'glue'); if (!anchor) { this.callbacks.status('Choose a point on a 3D part.'); return; }
    if (this.tool === 'align') { if (!this.alignmentStart) { this.alignmentStart = anchor; this.callbacks.select(anchor.partId, false, false); this.callbacks.status('Choose the matching target point or face.'); } else { this.callbacks.align(this.alignmentStart, anchor, this.pickSettings.target !== 'point'); this.alignmentStart = undefined; } return; }
    if (this.tool === 'arrow') { if (!this.pendingArrow) { this.pendingArrow = anchor; this.callbacks.status('Choose the arrow end point on a 3D part.'); return; } this.callbacks.anchors([this.pendingArrow, anchor], 'arrow'); this.pendingArrow = undefined; return; }
    this.callbacks.anchors([anchor], this.tool as NoteKind);
  }
  private cancelPointer(): void {
    this.drag = undefined;
    this.contextPress = undefined;
    this.ghost.hidden = true;
    this.controls.enabled = true;
    this.callbacks.dragHover?.(null);
  }
  private disposeAnnotationObjects(): void { this.annotationRoot.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => material.dispose()); } }); this.annotationRoot.clear(); this.annotationPins.length = 0; this.labelsHost.replaceChildren(); this.labels = []; this.annotationOverlay.clear(); this.noteTargets.clear(); }
  private describeLabels(project: Project, step?: AssemblyStep, frame?: Keyframe): LabelDefinition[] {
    const settings = frameLabels(project, frame), fontSize = settings.labelFontSize;
    const labels: LabelDefinition[] = [];
    for (const note of frame?.notes ?? []) {
      const first = note.anchors[0];
      if (!first || note.hidden || !(note.text || ['clip', 'glue', 'screw', 'remove', 'text'].includes(note.kind))) continue;
      labels.push({ id: note.id, partId: first.partId, point: first.point, text: note.text || note.kind, offset: note.offset, color: note.color, background: note.background, kind: note.kind, fontSize });
    }
    if (!settings.showLabels || !step) return labels;
    const objects = new Map<string, { id: string; name: string }>();
    const collectObjects = (nodes: ReturnType<typeof browserRoots>): void => { for (const node of nodes) { if (node.kind === 'object') { if (node.occurrenceToken) objects.set(node.occurrenceToken, node); if (node.componentPath) objects.set(node.componentPath, node); } if (node.children) collectObjects(node.children); } };
    if (settings.labelMode === 'object') collectObjects(browserRoots(project.model));
    const seenObjects = new Set<string>(), labeledGroups = new Set<string>();
    for (const part of project.model.parts) {
      if (!step.partIds.includes(part.id) || settings.hiddenLabels.includes(part.id)) continue;
      const group = settings.labelMode === 'auto' ? step.groups.find(item => item.partIds.includes(part.id)) : undefined;
      const common = { partId: part.id, point: [0, 0, 0] as Vec3, color: PART_LABEL_LINE_COLOR, background: '#333438', fontSize };
      if (group) {
        if (labeledGroups.has(group.id)) continue; labeledGroups.add(group.id);
        labels.push({ ...common, id: group.id, groupParts: group.partIds, text: group.name, offset: settings.labelOffsets[group.id] ?? DEFAULT_LABEL_OFFSET, target: { kind: 'group', id: group.id, stepId: step.id } });
        continue;
      }
      if (settings.labelMode === 'object' && seenObjects.has(part.objectId)) continue; seenObjects.add(part.objectId);
      const object = settings.labelMode === 'object' ? objects.get(part.occurrenceToken ?? '') ?? objects.get(part.objectName) : undefined;
      const target: NameTarget = object ? { kind: 'object', id: object.id } : { kind: 'part', id: part.id };
      labels.push({ ...common, id: part.id, text: object?.name ?? (settings.labelMode === 'object' ? part.objectName : part.name), offset: settings.labelOffsets[part.id] ?? DEFAULT_LABEL_OFFSET, target });
    }
    return labels;
  }
  private refreshAnnotations(): void {
    if (!this.project) return;
    const notes = this.frame?.notes ?? [], definitions = this.describeLabels(this.project, this.step, this.frame);
    const signature = JSON.stringify([notes.map(({ offset, ...note }) => note), definitions.map(({ offset, ...label }) => label)]);
    if (signature === this.labelsSignature) {
      definitions.forEach((definition, index) => { if (this.labels[index] !== this.draggingLabel) this.labels[index].offset = [...definition.offset]; });
      return;
    }
    this.labelsSignature = signature; this.disposeAnnotationObjects(); this.draggingLabel = undefined;
    this.paintCleanups.forEach(cleanup => cleanup()); this.paintCleanups = [];
    const surfacePaint = new Map<string, SurfacePaint[]>();
    for (const note of notes) {
      if (note.hidden) continue;
      const hasPin = ['text', 'clip', 'screw', 'remove'].includes(note.kind);
      for (const [index, anchor] of note.anchors.entries()) {
        if (!this.meshes.has(anchor.partId)) continue;
        if (anchor.region) { const areas = surfacePaint.get(anchor.partId) ?? []; areas.push({ region: anchor.region, color: note.color }); surfacePaint.set(anchor.partId, areas); }
        if (hasPin) {
          const material = new THREE.MeshBasicMaterial({ color: note.color, depthTest: false, clippingPlanes: this.sectionActive ? [this.clip] : [] });
          const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 32), material);
          mesh.renderOrder = 5;
          this.annotationRoot.add(mesh);
          this.annotationPins.push({ mesh, anchor, labelId: index === 0 ? note.id : undefined });
        }
      }
      if (note.kind === 'pencil') {
        const strokes = new Map<string, THREE.Vector3[]>();
        for (const anchor of note.anchors) {
          if (!strokes.has(anchor.partId)) strokes.set(anchor.partId, []);
          strokes.get(anchor.partId)!.push(new THREE.Vector3(...anchor.point));
        }
        for (const [partId, points] of strokes) {
          const mark = points.length === 1
            ? new THREE.Mesh(new THREE.SphereGeometry(.65, 8, 6).translate(...points[0].toArray()), new THREE.MeshBasicMaterial({ color: note.color, depthTest: false }))
            : new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: note.color, depthTest: false }));
          mark.userData.partId = partId; mark.renderOrder = 5;
          this.annotationRoot.add(mark); this.noteTargets.set(mark, note.id);
        }
      }
    }
    surfacePaint.forEach((areas, id) => { const mesh = this.meshes.get(id); if (mesh) this.paintCleanups.push(applySurfacePaint(mesh, areas)); });
    definitions.forEach(definition => this.addLabel(definition));
  }
  private labelElement({ id, text, background, fontSize, kind, target }: LabelDefinition): HTMLButtonElement {
    const element = document.createElement('button'); element.type = 'button'; element.className = target ? 'part-label' : 'surface-note'; element.textContent = text; element.dataset.noteId = id; element.style.color = target ? '#eeeeee' : '#f2f2f2'; element.style.background = background;
    element.style.fontSize = `${fontSize}px`;
    const icon = kind ? this.connectionIcons.get(kind) : undefined;
    if (icon) { const display = new Image(); display.src = icon.src; display.alt = ''; display.draggable = false; Object.assign(display.style, { position: 'absolute', left: '7px', top: '4px', width: `${fontSize}px`, height: `${fontSize}px` }); element.style.paddingLeft = `${fontSize + 14}px`; element.prepend(display); }
    if (target) { element.dataset.nameKind = target.kind; element.dataset.nameId = target.id; }
    return element;
  }
  private addLabel(definition: LabelDefinition): void {
    const { id, partId, target: nameTarget, kind } = definition, isPart = !!nameTarget;
    const element = this.labelElement(definition); this.labelsHost.append(element);
    const label: Label = { ...definition, element, offset: [...definition.offset], isPart, x: 0, y: 0, world: new THREE.Vector3(), icon: kind ? this.connectionIcons.get(kind) : undefined }; this.labels.push(label);
    let start: [number, number] | undefined; let original: [number, number] = [0, 0], authoredOffset: [number, number] = [...label.offset]; let moved = false;
    element.onpointerdown = event => { event.stopPropagation(); if (event.button !== 0) { if (event.button === 1) event.preventDefault(); return; } const projected = label.world.clone().project(this.camera); start = [event.clientX, event.clientY]; authoredOffset = [...label.offset]; original = [label.x - (projected.x + 1) * this.host.clientWidth / 2, label.y - (1 - projected.y) * this.host.clientHeight / 2]; moved = false; element.setPointerCapture(event.pointerId); };
    element.onpointermove = event => { if (!start) return; const dx = event.clientX - start[0], dy = event.clientY - start[1]; if (Math.hypot(dx, dy) > 3) moved = true; if (!moved) return; this.draggingLabel = label; label.offset = [original[0] + dx, original[1] + dy]; this.dirty = true; };
    element.onpointerup = event => { if (event.button !== 0 || !start) return; event.stopPropagation(); if (moved) { if (isPart) this.callbacks.labelMove(id, label.offset); else this.callbacks.noteMove(id, label.offset); } else if (!isPart) this.callbacks.note(id); else this.callbacks.select(partId, false, true); start = undefined; this.draggingLabel = undefined; this.dirty = true; };
    element.onpointercancel = () => { label.offset = [...authoredOffset]; start = undefined; this.draggingLabel = undefined; this.dirty = true; };
    element.ondblclick = event => { if (nameTarget) { event.preventDefault(); event.stopPropagation(); this.callbacks.renameName(nameTarget, element); } };
    element.onauxclick = event => { if (event.button === 1 && nameTarget) { event.preventDefault(); event.stopPropagation(); this.callbacks.focusName(nameTarget); } };
    element.oncontextmenu = event => { if (isPart) { event.preventDefault(); event.stopPropagation(); this.callbacks.copyName(label.text); } };
  }
  private measureLabel(element: HTMLElement, text: string, width: number) {
    const context = this.labelContext, computed = getComputedStyle(element);
    const font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`; context.font = font;
    const fontSize = parseFloat(computed.fontSize), lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.2;
    const insets = { left: parseFloat(computed.paddingLeft) + parseFloat(computed.borderLeftWidth), right: parseFloat(computed.paddingRight) + parseFloat(computed.borderRightWidth), top: parseFloat(computed.paddingTop) + parseFloat(computed.borderTopWidth), bottom: parseFloat(computed.paddingBottom) + parseFloat(computed.borderBottomWidth) };
    const box = measureLabelBox(text, Math.min(420, width - 24), lineHeight, insets, value => context.measureText(value).width);
    const metrics = context.measureText('Mg');
    const { backgroundColor, borderColor, borderRadius, borderWidth, color } = computed;
    const style = { backgroundColor, borderColor, borderRadius, borderWidth, color };
    return { ...box, style, font, fontSize, lineHeight, insets, ascent: metrics.fontBoundingBoxAscent || fontSize * .8, descent: metrics.fontBoundingBoxDescent || fontSize * .2 };
  }
  private labelPoint(label: LabelDefinition, matrixFor: (partId: string) => THREE.Matrix4): THREE.Vector3 {
    if (!label.groupParts) return new THREE.Vector3(...label.point).applyMatrix4(matrixFor(label.partId));
    const center = new THREE.Vector3(), point = new THREE.Vector3();
    for (const id of label.groupParts) center.add(point.setFromMatrixPosition(matrixFor(id)));
    return center.divideScalar(label.groupParts.length);
  }
  private projectedLabels(layout: PlaybackLayout, blend: FrameInterpolation, camera: THREE.PerspectiveCamera, matrixFor: (partId: string) => THREE.Matrix4, visible: (partId: string) => boolean): MotionPosition[] {
    if (!layout.labels) return [];
    const { from, to, before, after } = layout.labels, { fraction, curve } = blend;
    const firstHalf = fraction < .5, current = firstHalf ? from : to, other = firstHalf ? to : from;
    const worldPoint = (definition?: LabelDefinition) => definition && this.labelPoint(definition, matrixFor).toArray();
    const positions: MotionPosition[] = [];
    for (const label of current.values()) {
      if (!visible(label.partId)) continue;
      const pair = other.get(label.id), world = this.labelPoint(label, matrixFor);
      let offset = label.offset;
      if (pair && visible(pair.partId)) {
        if (curve) {
          const previous = before?.get(label.id), next = after?.get(label.id);
          const [start, end] = firstHalf ? [label, pair] : [pair, label];
          const otherPoint = this.labelPoint(pair, matrixFor).toArray(), point = world.toArray();
          world.fromArray(curveVector(curve, firstHalf ? point : otherPoint, firstHalf ? otherPoint : point, worldPoint(previous), worldPoint(next)));
          offset = curveOffset(curve, start.offset, end.offset, previous?.offset, next?.offset);
        } else {
          const progress = firstHalf ? fraction : 1 - fraction;
          world.lerp(this.labelPoint(pair, matrixFor), progress);
          offset = interpolateOffset(label.offset, pair.offset, progress);
        }
      }
      if (world.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) continue;
      const { anchorX, anchorY } = projectLabelAnchor(world.clone().project(camera), layout.viewport);
      positions.push({ id: label.id, world, width: label.width, height: label.height, anchorX, anchorY, x: anchorX + offset[0], y: anchorY + offset[1] });
    }
    return positions;
  }
  private preparePlaybackLabels(layout: PlaybackLayout): void {
    const { project, segment, viewport: { width, height }, cameraFallback } = layout, { step, from, to, duration, before, after } = segment;
    const measure = (frame: Keyframe): Map<string, MeasuredLabel> => new Map(this.describeLabels(project, step, frame).map(label => {
      const element = this.labelElement(label); element.style.visibility = 'hidden'; this.labelsHost.append(element);
      const { width: labelWidth, height: labelHeight } = this.measureLabel(element, label.text, width); element.remove();
      return [label.id, { ...label, width: labelWidth, height: labelHeight }];
    }));
    const neighbor = (frame: Keyframe | undefined) => frame && new Map(this.describeLabels(project, step, frame)
      .filter(label => !frame.hidden.includes(label.partId)).map(label => [label.id, label]));
    const first = measure(from);
    const labels = { from: first, to: from === to ? first : measure(to), before: neighbor(before), after: neighbor(after) };
    layout.labels = labels;
    if (from === to || (!labels.from.size && !labels.to.size)) return;
    const visibility = modelVisibility(project).parts, parts = new Map(project.model.parts.map(part => [part.id, part]));
    const camera = this.camera.clone(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
    const hiddenAtStart = new Set(from.hidden), hiddenAtEnd = new Set(to.hidden);
    layout.labels.tracks = planLabelMotion(duration, width, height, progress => {
      const blend = playbackInterpolation(segment, progress);
      const state = interpolatedFrameCamera(from, to, blend, cameraFallback) ?? cameraFallback;
      camera.position.fromArray(state.eye); camera.up.fromArray(state.up); camera.lookAt(position.fromArray(state.target)); camera.updateMatrixWorld();
      const matrices = new Map<string, THREE.Matrix4>(), hidden = blend.fraction < .999 ? hiddenAtStart : hiddenAtEnd;
      const matrixFor = (id: string): THREE.Matrix4 => {
        const cached = matrices.get(id); if (cached) return cached;
        const part = parts.get(id)!;
        const pose = interpolatedFramePose(from, to, id, blend) ?? homePose(part);
        const matrix = new THREE.Matrix4().compose(position.fromArray(pose.position), rotation.fromArray(pose.quaternion), scale);
        matrices.set(id, matrix); return matrix;
      };
      return this.projectedLabels(layout, blend, camera, matrixFor, id => (visibility.get(id) ?? true) && !hidden.has(id) && !this.displayHidden.has(id) && (!this.isolated.size || this.isolated.has(id)));
    });
  }
  private animatedLabelBoxes(layout: PlaybackLayout, progress: number): Map<string, MotionPosition> {
    if (!layout.labels) this.preparePlaybackLabels(layout);
    const preferred = this.projectedLabels(layout, playbackInterpolation(layout.segment, progress), this.camera, id => this.meshes.get(id)!.matrixWorld, id => !!this.meshes.get(id)?.visible);
    const tracks = layout.labels?.tracks, { width, height } = layout.viewport;
    const boxes = tracks ? preferred.map(box => positionAnimatedLabel(box, tracks.get(box.id), progress, width, height))
      : arrangeLabelBoxes(preferred, width, height);
    return new Map(boxes.map(box => [box.id, box]));
  }
  private updateAnnotationPins(): void {
    if (!this.annotationPins.length) return;
    const projectedHeight = this.renderSize.height * this.camera.projectionMatrix.elements[5];
    const cameraPoint = new THREE.Vector3();
    for (const { mesh, anchor, labelId } of this.annotationPins) {
      const { point, visible } = this.worldAnchor(anchor);
      const animated = labelId === undefined ? undefined : this.playbackBoxes?.get(labelId);
      mesh.position.copy(animated?.world ?? point);
      const depth = -cameraPoint.copy(mesh.position).applyMatrix4(this.camera.matrixWorldInverse).z;
      mesh.visible = visible && depth > 0 && projectedHeight > 0;
      if (!mesh.visible) continue;
      // Keep the pin in the 3D render pass for section clipping while sizing it in viewport pixels.
      mesh.quaternion.copy(this.camera.quaternion);
      mesh.scale.setScalar(2 * LEADER_DOT_RADIUS * depth / projectedHeight);
    }
  }
  private updateAnnotations(): void {
    const viewport = this.annotationViewport, { width, height, fullWidth, insetX } = viewport;
    for (const child of this.annotationRoot.children) { const id: unknown = child.userData.partId; if (typeof id !== 'string') continue; const mesh = this.meshes.get(id); if (!mesh) continue; child.position.copy(mesh.position); child.quaternion.copy(mesh.quaternion); child.visible = mesh.visible; }
    this.leaderSvg.setAttribute('viewBox', `${-insetX} 0 ${fullWidth} ${height}`); this.leaderSvg.replaceChildren();
    this.annotationOverlay.update(this.frame?.notes ?? [], this.camera, fullWidth, height, anchor => {
      const result = this.worldAnchor(anchor);
      return { point: result.point, visible: result.visible && (!this.sectionActive || this.clip.distanceToPoint(result.point) >= 0) };
    });
    const playback = this.draggingLabel ? undefined : this.playback;
    this.playbackBoxes = playback ? this.animatedLabelBoxes(playback.layout, playback.progress) : undefined;
    this.updateAnnotationPins();
    const positions: { label: Label; x: number; y: number; width: number; height: number; anchorX: number; anchorY: number }[] = [];
    for (const label of this.labels) {
      const mesh = this.meshes.get(label.partId); if (!mesh) continue;
      const animated = this.playbackBoxes?.get(label.id);
      label.world.copy(animated?.world ?? this.labelPoint(label, id => this.meshes.get(id)!.matrixWorld)); const projected = label.world.clone().project(this.camera);
      const visible = mesh.visible && projected.z >= -1 && projected.z <= 1 && (!this.sectionActive || this.clip.distanceToPoint(label.world) >= 0); label.element.hidden = !visible; if (!visible) continue;
      if (animated) {
        Object.assign(label.element.style, { width: `${animated.width}px`, maxWidth: 'none', height: `${animated.height}px` });
        positions.push({ ...animated, label }); continue;
      }
      Object.assign(label.element.style, { width: '', maxWidth: '', height: '' });
      const { anchorX, anchorY } = projectLabelAnchor(projected, viewport);
      const keepPosition = this.draggingLabel && this.draggingLabel !== label;
      positions.push({ label, x: keepPosition ? label.x : anchorX + label.offset[0], y: keepPosition ? label.y : anchorY + label.offset[1], width: label.element.offsetWidth, height: label.element.offsetHeight, anchorX, anchorY });
    }
    let arranged = positions;
    if (!this.draggingLabel && !playback) {
      const host = this.host.getBoundingClientRect();
      const obstacles = [...document.querySelectorAll<HTMLElement>('.left-panel,.right-stack,.viewport-tools,.bottom-controls,.playbar')].filter(element => !element.hidden && element.offsetWidth && element.offsetHeight).map(element => { const rect = element.getBoundingClientRect(); return { x: rect.left - host.left, y: rect.top - host.top, width: rect.width, height: rect.height }; });
      arranged = arrangeLabelBoxes(positions.sort((a, b) => Number(a.label.isPart) - Number(b.label.isPart)), width, height, obstacles);
    }
    for (const box of arranged) {
      const { label } = box; label.x = box.x; label.y = box.y; label.element.style.transform = `translate(${box.x}px,${box.y}px)`;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('x1', String(box.anchorX)); line.setAttribute('y1', String(box.anchorY)); line.setAttribute('x2', String(Math.max(box.x, Math.min(box.x + box.width, box.anchorX)))); line.setAttribute('y2', String(Math.max(box.y, Math.min(box.y + box.height, box.anchorY)))); line.setAttribute('stroke', label.color); line.setAttribute('stroke-width', String(ANNOTATION_LINE_WIDTH)); this.leaderSvg.append(line);
      if (label.isPart) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(box.anchorX)); dot.setAttribute('cy', String(box.anchorY)); dot.setAttribute('r', String(LEADER_DOT_RADIUS)); dot.setAttribute('fill', PART_LABEL_DOT_COLOR); this.leaderSvg.append(dot);
      }
    }
  }
  worldAnchor(anchor: Anchor): { point: THREE.Vector3; visible: boolean } { const mesh = this.meshes.get(anchor.partId); return { point: new THREE.Vector3(...anchor.point).applyMatrix4(mesh?.matrixWorld ?? new THREE.Matrix4()), visible: !!mesh?.visible }; }
  autoLabels(): Record<string, [number, number]> {
    this.updateAnnotations(); const result: Record<string, [number, number]> = {}; const host = this.host.getBoundingClientRect();
    const occupied = [...document.querySelectorAll<HTMLElement>('.left-panel,.right-stack,.viewport-tools,.bottom-controls,.playbar')].filter(el => !el.hidden).map(el => { const r = el.getBoundingClientRect(); return { x: r.left - host.left - 7, y: r.top - host.top - 7, w: r.width + 14, h: r.height + 14 }; });
    const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const label of this.labels.filter(l => l.isPart && !l.element.hidden).sort((a, b) => a.y - b.y)) {
      const projected = label.world.clone().project(this.camera); const px = (projected.x + 1) * host.width / 2, py = (1 - projected.y) * host.height / 2; const w = label.element.offsetWidth + 10, h = label.element.offsetHeight + 8;
      let candidate = { x: px + 25, y: py - 35, w, h }; let found = false;
      for (let radius = 35; radius < 700 && !found; radius += 25) for (let slot = 0; slot < 16; slot++) { const angle = slot * Math.PI / 8; const box = { x: px + Math.cos(angle) * radius - w / 2, y: py + Math.sin(angle) * radius - h / 2, w, h }; if (box.x < 5 || box.y < 5 || box.x + w > host.width - 5 || box.y + h > host.height - 5 || occupied.some(other => overlaps(box, other))) continue; candidate = box; found = true; break; }
      result[label.id] = [candidate.x - px, candidate.y - py]; occupied.push(candidate);
    } return result;
  }
  thumbnail(part: Part, canvas: HTMLCanvasElement): void {
    canvas.width = 84; canvas.height = 64; const cached = this.thumbnailCache.get(part.id); if (cached) { canvas.getContext('2d')?.drawImage(cached, 0, 0); return; }
    this.thumbnailQueue.push({ part, canvas }); this.dirty = true;
  }
  private nextThumbnail(): void {
    if (this.thumbBusy || !this.thumbnailQueue.length) return; const item = this.thumbnailQueue.shift()!; if (!item.canvas.isConnected) return;
    this.thumbBusy = true; const mesh = this.meshes.get(item.part.id); if (!mesh) { this.thumbBusy = false; return; }
    const preview = new THREE.Mesh(mesh.geometry, new THREE.MeshStandardMaterial({ color: item.part.color, roughness: .7, side: THREE.DoubleSide })); this.thumbScene.add(preview);
    const bounds = mesh.geometry.boundingBox!; const center = bounds.getCenter(new THREE.Vector3()); const size = Math.max(bounds.getSize(new THREE.Vector3()).length(), .1); this.thumbCamera.aspect = 84 / 64; this.thumbCamera.position.copy(center).addScaledVector(new THREE.Vector3(1, -1.5, .9).normalize(), size * 2); this.thumbCamera.near = size / 1000; this.thumbCamera.far = size * 10; this.thumbCamera.lookAt(center); this.thumbCamera.updateProjectionMatrix();
    const renderer = this.renderer; const width = this.host.clientWidth, height = this.host.clientHeight; const ratio = renderer.getPixelRatio();
    renderer.setViewport(0, 0, 84, 64); renderer.setScissor(0, 0, 84, 64); renderer.setScissorTest(true); renderer.render(this.thumbScene, this.thumbCamera);
    const canvas = document.createElement('canvas'); canvas.width = 84; canvas.height = 64; canvas.getContext('2d')?.drawImage(renderer.domElement, 0, renderer.domElement.height - 64 * ratio, 84 * ratio, 64 * ratio, 0, 0, 84, 64); item.canvas.getContext('2d')?.drawImage(canvas, 0, 0); this.thumbnailCache.set(item.part.id, canvas);
    this.thumbScene.remove(preview); preview.material.dispose(); renderer.setScissorTest(false); renderer.setViewport(0, 0, width, height); this.thumbBusy = false; this.dirty = true;
  }
  async prepareCapture(): Promise<void> { await document.fonts.ready; await Promise.all([...this.connectionIcons.values()].map(image => image.decode())); }
  private get renderSize(): { width: number; height: number } {
    return this.videoCapture ? { width: videoWidth, height: videoHeight } : { width: this.host.clientWidth, height: this.host.clientHeight };
  }
  private get annotationViewport(): AnnotationViewport {
    if (this.videoCapture) return videoAnnotations;
    const { width, height } = this.renderSize;
    return { width, height, fullWidth: width, insetX: 0, scale: 1 };
  }
  async withVideoSize<T>(draw: () => Promise<T>): Promise<T> {
    const ratio = this.renderer.getPixelRatio();
    this.videoCapture = true;
    this.videoLabelMetrics = new WeakMap();
    try {
      this.renderer.setPixelRatio(1); this.composer.setPixelRatio(1); this.resize();
      return await draw();
    } finally {
      this.videoCapture = false;
      this.videoLabelMetrics = undefined;
      this.renderer.setPixelRatio(ratio); this.composer.setPixelRatio(ratio); this.resize();
    }
  }
  labelLayout() {
    this.scene.updateMatrixWorld(true); this.updateDepthRange(); this.updateAnnotations();
    const { insetX, scale } = this.annotationViewport;
    const labels = this.labels.flatMap(label => {
      const box = this.playbackBoxes?.get(label.id);
      if (!box || label.element.hidden) return [];
      const { x, y, width, height, anchorX, anchorY } = box;
      return [{ id: label.id, text: label.text, kind: label.target?.kind ?? 'note', partId: label.partId,
        x: (x + insetX) * scale, y: y * scale, width: width * scale, height: height * scale,
        anchorX: (anchorX + insetX) * scale, anchorY: anchorY * scale }];
    });
    return { ...this.renderSize, labels };
  }
  capture(): HTMLCanvasElement {
    const canvas = document.createElement('canvas'); canvas.width = this.renderer.domElement.width; canvas.height = this.renderer.domElement.height;
    this.drawCapture(canvas.getContext('2d')!);
    return canvas;
  }
  drawCapture(context: CanvasRenderingContext2D): void {
    this.scene.updateMatrixWorld(true); this.updateDepthRange(); this.updateAnnotations(); this.renderScene();
    const viewport = this.annotationViewport, { width, height, insetX, scale } = viewport;
    const pixelScale = this.renderer.getPixelRatio() * scale;
    context.save(); context.resetTransform(); context.drawImage(this.renderer.domElement, 0, 0); context.scale(pixelScale, pixelScale);
    this.annotationOverlay.draw(context);
    context.translate(insetX, 0);
    const measured = this.labels.filter(label => !label.element.hidden).sort((a, b) => Number(a.isPart) - Number(b.isPart)).map(label => {
      let box = this.videoLabelMetrics?.get(label.element);
      if (!box) {
        box = this.measureLabel(label.element, label.text, width);
        this.videoLabelMetrics?.set(label.element, box);
      }
      const animated = this.playbackBoxes?.get(label.id);
      if (animated) return { ...box, ...animated, label };
      const { anchorX, anchorY } = projectLabelAnchor(label.world.clone().project(this.camera), viewport);
      return { ...box, label, x: anchorX + label.offset[0], y: anchorY + label.offset[1], anchorX, anchorY };
    });
    const layouts = this.playbackBoxes ? measured : arrangeLabelBoxes(measured, width, height);
    for (const box of layouts) {
      context.lineWidth = ANNOTATION_LINE_WIDTH; context.strokeStyle = box.label.color; context.beginPath(); context.moveTo(box.anchorX, box.anchorY);
      context.lineTo(Math.max(box.x, Math.min(box.x + box.width, box.anchorX)), Math.max(box.y, Math.min(box.y + box.height, box.anchorY))); context.stroke();
      if (box.label.isPart) { context.beginPath(); context.arc(box.anchorX, box.anchorY, LEADER_DOT_RADIUS, 0, Math.PI * 2); context.fillStyle = PART_LABEL_DOT_COLOR; context.fill(); }
    }
    for (const box of layouts) {
      const { style, label } = box; context.save(); context.beginPath(); context.roundRect(box.x, box.y, box.width, box.height, Math.min(parseFloat(style.borderRadius) || 0, box.height / 2));
      context.fillStyle = style.backgroundColor; context.fill(); context.strokeStyle = style.borderColor; context.lineWidth = parseFloat(style.borderWidth) || 1; context.stroke();
      if (label.icon?.complete && label.icon.naturalWidth) context.drawImage(label.icon, box.x + 7, box.y + 4, box.fontSize, box.fontSize);
      context.fillStyle = style.color; context.font = box.font; context.textBaseline = 'alphabetic';
      box.lines.forEach((line, index) => context.fillText(line, box.x + box.insets.left, box.y + box.insets.top + (box.lineHeight - box.ascent - box.descent) / 2 + box.ascent + index * box.lineHeight)); context.restore();
    }
    context.restore();
  }
  private updateProjectionFrame(): { left: number; right: number } {
    if (this.videoCapture) { this.camera.clearViewOffset(); return { left: 0, right: videoWidth }; }
    const viewport = this.host.getBoundingClientRect(); let left = 0, right = viewport.width;
    const leftPanel = document.querySelector<HTMLElement>('.left-panel'), rightPanel = document.querySelector<HTMLElement>('.right-stack');
    if (leftPanel && !leftPanel.hidden && leftPanel.offsetWidth) left = Math.max(0, leftPanel.getBoundingClientRect().right - viewport.left + 12);
    if (rightPanel && !rightPanel.hidden && rightPanel.offsetWidth) right = Math.min(viewport.width, rightPanel.getBoundingClientRect().left - viewport.left - 12);
    if (right <= left) { left = 0; right = viewport.width; }
    this.camera.setViewOffset(viewport.width, viewport.height, (viewport.width - left - right) / 2, 0, viewport.width, viewport.height);
    return { left, right };
  }
  private resize(): void {
    const { width, height } = this.renderSize; if (!width || !height) return;
    this.renderer.setSize(width, height, !this.videoCapture); this.composer.setSize(width, height); this.outline.setSize(width, height); this.camera.aspect = width / height; this.updateProjectionFrame();
    if (this.playback) {
      const { layout, progress } = this.playback;
      this.playback.layout = this.getPlaybackLayout(layout.project, layout.segment);
      this.setPlaybackCamera(this.playback.layout, progress);
    }
    this.dirty = true;
  }
  private updateDepthRange(): void {
    const camera = this.camera;
    camera.updateMatrixWorld(true); this.transparentDepth.clear();
    this.lightRig.quaternion.copy(this.camera.quaternion); this.lightRig.updateMatrixWorld(true);
    if (this.project) this.constructionAxes.update(this.project, this.meshes, camera, this.renderSize.height);
    const projection = camera.projectionMatrix.elements;
    const sideSlopes = [(1 + projection[8]) / projection[0], (1 - projection[8]) / projection[0],
      (1 + projection[9]) / projection[5], (1 - projection[9]) / projection[5]];
    const bounds = new THREE.Box3(), view = new THREE.Box3(), world = new THREE.Box3(), modelView = new THREE.Matrix4();
    let closest = Infinity, farthest = 0;
    const includeDepth = (object: THREE.Mesh | THREE.Line) => {
      const geometry = object.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const local = geometry.boundingBox!;
      view.copy(local).applyMatrix4(modelView.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld));
      // Clip the camera-space box to the side planes only. The previous near plane must not hide newly visible geometry.
      let first = Math.max(0, -view.max.z), last = -view.min.z;
      const sides = [view.min.x, -view.max.x, view.min.y, -view.max.y];
      for (let i = 0; i < sides.length && first <= last; i++) {
        const slope = sideSlopes[i];
        if (slope > 0) first = Math.max(first, sides[i] / slope);
        else if (slope < 0) last = Math.min(last, sides[i] / slope);
        else if (sides[i] > 0) return;
      }
      if (first <= last) { closest = Math.min(closest, first); farthest = Math.max(farthest, last); }
    };
    for (const mesh of this.meshes.values()) {
      if (!mesh.visible) continue;
      includeDepth(mesh);
      bounds.union(world.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld));
      if (mesh.material.transparent) this.transparentDepth.set(mesh.id, view.max.z);
    }
    if (bounds.isEmpty()) return;
    if (this.sectionActive) this.sectionView.update(bounds);
    this.constructionAxes.root.traverseVisible(object => { if (object instanceof THREE.Line) includeDepth(object); });
    if (this.axes.visible) includeDepth(this.axes);
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    const distance = camera.position.distanceTo(bounds.getCenter(new THREE.Vector3()));
    const near = Math.max(.05, Number.isFinite(closest) ? closest * .9 : distance - radius * 1.12);
    const far = Math.max(near + 1, distance + radius * 1.2, farthest * 1.05);
    if (Math.abs(camera.near - near) > .001 || Math.abs(camera.far - far) > .001) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
  }
  private renderScene(): void {
    this.composer.render();
    const ghosts = [...this.meshes.values()].filter(mesh => mesh.visible && mesh.material.transparent);
    if (!ghosts.length) return;
    const visible = new Map(this.scene.children.map(object => [object, object.visible]));
    const background = this.scene.background, autoClear = this.renderer.autoClear;
    const colorWrites = new Map([...this.meshes.values()].map(mesh => [mesh.material, mesh.material.colorWrite]));
    try {
      // Bambu blends its 0.15-alpha parts after shading in display color space.
      this.renderer.setRenderTarget(null); this.renderer.autoClear = false; this.scene.background = null; this.renderer.clearDepth();
      this.scene.children.forEach(object => { if (!(object instanceof THREE.Light) && object !== this.lightRig && !object.userData.partId) object.visible = false; });
      ghosts.forEach(mesh => { mesh.visible = false; }); this.meshes.forEach(mesh => { mesh.material.colorWrite = false; });
      this.renderer.render(this.scene, this.camera);
      colorWrites.forEach((value, material) => { material.colorWrite = value; });
      this.meshes.forEach(mesh => { mesh.visible = ghosts.includes(mesh); });
      this.renderer.render(this.scene, this.camera);
    } finally {
      visible.forEach((value, object) => { object.visible = value; }); colorWrites.forEach((value, material) => { material.colorWrite = value; });
      this.scene.background = background; this.renderer.autoClear = autoClear;
    }
  }
  private animate = (): void => { this.raf = requestAnimationFrame(this.animate); if (this.videoCapture) return; this.controls.update(); this.nextThumbnail(); if (!this.dirty) return; this.dirty = false; this.scene.updateMatrixWorld(true); this.updateDepthRange(); this.updateAnnotations(); this.renderScene(); this.navigator?.render(); };
  dispose(): void { cancelAnimationFrame(this.raf); this.observer.disconnect(); this.controls.dispose(); this.transform.dispose(); this.navigator?.dispose(); this.constructionAxes.dispose(); this.sectionView.dispose(); this.disposeAnnotationObjects(); this.paintCleanups.forEach(cleanup => cleanup()); this.paintCleanups = []; this.meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); }); this.composer.dispose(); this.renderer.dispose(); this.ghost.remove(); }
}
