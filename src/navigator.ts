import * as THREE from 'three';
import type { Vec3 } from '../shared/types.ts';
import { navigatorDirection, viewDirections } from '../shared/navigation.ts';

const faces: { name: string; normal: Vec3; up: Vec3 }[] = [
  { name: 'Right', normal: [1, 0, 0], up: [0, 0, 1] }, { name: 'Left', normal: [-1, 0, 0], up: [0, 0, 1] },
  { name: 'Back', normal: [0, 1, 0], up: [0, 0, 1] }, { name: 'Front', normal: [0, -1, 0], up: [0, 0, 1] },
  { name: 'Top', normal: [0, 0, 1], up: [0, 1, 0] }, { name: 'Bottom', normal: [0, 0, -1], up: [0, -1, 0] },
];
const size = 128;
export class Navigator {
  private canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20);
  private raycaster = new THREE.Raycaster();
  private box = new THREE.Box3(new THREE.Vector3(-.5, -.5, -.5), new THREE.Vector3(.5, .5, .5));
  private hover?: Vec3;
  private pointer?: { id: number; x: number; y: number; startX: number; startY: number; dragged: boolean };
  private inverse = new THREE.Quaternion();
  private pixelRatio = Math.min(devicePixelRatio, 2);
  constructor(host: HTMLElement, private sourceCamera: THREE.Camera, private choose: (direction: Vec3) => void, private orbit: (dx: number, dy: number) => void) {
    host.className = 'view-navigator'; host.replaceChildren(this.canvas);
    this.canvas.width = size * this.pixelRatio; this.canvas.height = size * this.pixelRatio;
    this.context = this.canvas.getContext('2d')!;
    this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-label', '3D navigator: 26 face, edge and corner directions. Drag to orbit.');
    this.canvas.title = 'Click a face, edge or corner for a preset view. Drag to orbit with Z up.';
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.pick(event)) return;
      event.preventDefault(); this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragged: false };
    });
    this.canvas.addEventListener('pointermove', event => {
      const pointer = this.pointer;
      if (pointer) {
        pointer.dragged ||= Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 3;
        if (pointer.dragged) { this.hover = undefined; this.canvas.style.cursor = 'grabbing'; this.orbit(event.clientX - pointer.x, event.clientY - pointer.y); }
        pointer.x = event.clientX; pointer.y = event.clientY;
      } else { this.hover = this.pick(event); this.canvas.style.cursor = this.hover ? 'pointer' : 'default'; }
      this.render();
    });
    this.canvas.addEventListener('pointerup', event => {
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      this.pointer = undefined; this.canvas.releasePointerCapture(event.pointerId);
      if (!pointer.dragged) { const direction = this.pick(event); if (direction) this.choose(direction); }
      this.hover = this.pick(event); this.canvas.style.cursor = this.hover ? 'pointer' : 'default'; this.render();
    });
    this.canvas.addEventListener('pointercancel', () => { this.pointer = undefined; this.hover = undefined; this.render(); });
    this.canvas.addEventListener('pointerleave', () => { if (!this.pointer) this.hover = undefined; this.render(); });
    this.canvas.addEventListener('dblclick', () => this.choose(viewDirections.iso));
    this.canvas.addEventListener('keydown', event => { if (event.key === 'Enter') this.choose(viewDirections.iso); });
  }
  private pick(event: PointerEvent): Vec3 | undefined {
    const rect = this.canvas.getBoundingClientRect(); this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.camera);
    const point = this.raycaster.ray.intersectBox(this.box, new THREE.Vector3()); return point ? navigatorDirection(point.toArray()) : undefined;
  }
  private project(point: THREE.Vector3): THREE.Vector2 { const p = point.clone().applyQuaternion(this.inverse); return new THREE.Vector2(size / 2 + p.x * size / 2, size / 2 - p.y * size / 2); }
  private polygon(points: THREE.Vector3[], color: string): void {
    const ctx = this.context; ctx.beginPath(); points.forEach((point, i) => { const p = this.project(point); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  render(): void {
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(this.sourceCamera.quaternion);
    this.camera.position.copy(direction).multiplyScalar(4); this.camera.quaternion.copy(this.sourceCamera.quaternion); this.camera.updateMatrixWorld(true); this.inverse.copy(this.sourceCamera.quaternion).invert();
    const ctx = this.context; ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0); ctx.clearRect(0, 0, size, size);
    for (const face of faces) {
      const normal = new THREE.Vector3(...face.normal); if (normal.dot(direction) <= 1e-6) continue;
      const center = normal.clone().multiplyScalar(.5), up = new THREE.Vector3(...face.up), right = new THREE.Vector3().crossVectors(up, normal);
      const point = (x: number, y: number) => center.clone().addScaledVector(right, x).addScaledVector(up, y);
      this.polygon([point(-.5, -.5), point(.5, -.5), point(.5, .5), point(-.5, .5)], '#3b3b3b');
      if (this.hover) {
        const stops = [-.5, -.25, .25, .5];
        for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) {
          const candidate = navigatorDirection(point((stops[x] + stops[x + 1]) / 2, (stops[y] + stops[y + 1]) / 2).toArray());
          if (candidate.every((v, i) => v === this.hover![i])) this.polygon([point(stops[x], stops[y]), point(stops[x + 1], stops[y]), point(stops[x + 1], stops[y + 1]), point(stops[x], stops[y + 1])], '#f0a06080');
        }
      }
      const origin = this.project(center), x = this.project(center.clone().add(right)).sub(origin).multiplyScalar(2 / size), y = this.project(center.clone().add(up)).sub(origin).multiplyScalar(-2 / size);
      ctx.save(); ctx.transform(x.x, x.y, y.x, y.y, origin.x, origin.y); ctx.fillStyle = '#e0e0e0'; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(face.name, 0, 0); ctx.restore();
    }
    const origin = new THREE.Vector3(-.5, -.5, -.5), start = this.project(origin);
    const axes: { axis: Vec3; color: string; name: string }[] = [{ axis: [1, 0, 0], color: '#c98080', name: 'x' }, { axis: [0, 1, 0], color: '#80c980', name: 'y' }, { axis: [0, 0, 1], color: '#8080c9', name: 'z' }];
    for (const item of axes) {
      const axis = new THREE.Vector3(...item.axis), end = this.project(origin.clone().add(axis)), delta = end.clone().sub(start); if (delta.length() < 1) continue;
      ctx.globalAlpha = axes.some(other => other !== item && new THREE.Vector3(...other.axis).negate().dot(direction) > 0) ? 1 : .3;
      ctx.strokeStyle = item.color; ctx.fillStyle = item.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      delta.normalize().multiplyScalar(5); const side = new THREE.Vector2(-delta.y, delta.x); ctx.beginPath(); ctx.moveTo(end.x + delta.x, end.y + delta.y); ctx.lineTo(end.x - delta.x + side.x, end.y - delta.y + side.y); ctx.lineTo(end.x - delta.x - side.x, end.y - delta.y - side.y); ctx.closePath(); ctx.fill();
      const label = this.project(origin.clone().addScaledVector(axis, 1.3)); ctx.font = '11px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(item.name, label.x, label.y);
    }
    ctx.globalAlpha = 1;
  }
  dispose(): void { this.canvas.remove(); }
}
