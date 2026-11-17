import { PerspectiveCamera, Vector3 } from 'three';
import type { Anchor, Note } from '../shared/types.ts';
import { ANNOTATION_LINE_WIDTH } from '../shared/render-style.ts';

interface ProjectedAnchor { x: number; y: number; depth: number }
interface ScreenMark { noteId: string; path: Path2D; color: string; filled: boolean; hitWidth: number }
type ResolveAnchor = (anchor: Anchor) => { point: Vector3; visible: boolean };

/** Screen-facing outlines retain their source anchor and millimeter dimensions. */
export class AnnotationOverlay {
  readonly element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private marks: ScreenMark[] = [];
  private readonly hitContext = document.createElement('canvas').getContext('2d')!;

  constructor() {
    this.element.classList.add('canvas-leaders', 'annotation-outlines');
    this.element.setAttribute('aria-hidden', 'true');
  }

  clear(): void {
    this.marks = [];
    this.element.replaceChildren();
  }

  update(notes: readonly Note[], camera: PerspectiveCamera, width: number, height: number, resolveAnchor: ResolveAnchor): void {
    this.clear();
    this.element.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const project = (anchor: Anchor): ProjectedAnchor | undefined => {
      const { point, visible } = resolveAnchor(anchor);
      if (!visible) return;
      const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const projected = point.project(camera);
      if (depth <= 0 || projected.z < -1 || projected.z > 1) return;
      return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, depth };
    };
    for (const note of notes) {
      if (note.hidden) continue;
      if (note.kind === 'arrow' && note.anchors.length >= 2) {
        const start = project(note.anchors[0]), end = project(note.anchors[1]);
        if (start && end) this.arrow(note.id, start, end, note.color);
        continue;
      }
      if (note.kind !== 'rectangle' && note.kind !== 'circle') continue;
      for (const anchor of note.anchors) {
        const center = project(anchor);
        if (!center) continue;
        const { x, y, depth } = center;
        const radius = note.size * camera.projectionMatrix.elements[5] * height / (2 * depth);
        if (!(radius > 0) || !Number.isFinite(radius)) continue;
        const path = note.kind === 'rectangle'
          ? `M ${x - radius} ${y - radius} h ${2 * radius} v ${2 * radius} h ${-2 * radius} Z`
          : `M ${x + radius} ${y} A ${radius} ${radius} 0 0 1 ${x} ${y + radius} A ${radius} ${radius} 0 0 1 ${x - radius} ${y} A ${radius} ${radius} 0 0 1 ${x} ${y - radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`;
        this.add(note.id, path, note.color, false, Math.max(ANNOTATION_LINE_WIDTH, Math.min(12, radius)));
      }
    }
  }

  private arrow(noteId: string, start: ProjectedAnchor, end: ProjectedAnchor, color: string): void {
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (length < .001) return;
    // Bambu uses a 12 px base and the golden ratio for the screen-space head.
    const headHeight = Math.min(12 * 1.618033, length / 2), halfBase = headHeight / (2 * 1.618033);
    const ux = dx / length, uy = dy / length;
    const baseX = end.x - ux * headHeight, baseY = end.y - uy * headHeight;
    this.add(noteId, `M ${start.x} ${start.y} L ${end.x} ${end.y}`, color);
    this.add(noteId, `M ${end.x} ${end.y} L ${baseX - uy * halfBase} ${baseY + ux * halfBase} L ${baseX + uy * halfBase} ${baseY - ux * halfBase} Z`, color, true);
  }

  private add(noteId: string, data: string, color: string, filled = false, hitWidth = 12): void {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    element.dataset.noteId = noteId;
    element.setAttribute('d', data);
    element.setAttribute('stroke', filled ? 'none' : color);
    element.setAttribute('fill', filled ? color : 'none');
    element.setAttribute('stroke-width', String(ANNOTATION_LINE_WIDTH));
    this.element.append(element);
    this.marks.push({ noteId, path: new Path2D(data), color, filled, hitWidth });
  }

  hit(x: number, y: number): string | undefined {
    for (const mark of this.marks.toReversed()) {
      this.hitContext.lineWidth = mark.hitWidth;
      if (mark.filled ? this.hitContext.isPointInPath(mark.path, x, y) : this.hitContext.isPointInStroke(mark.path, x, y)) return mark.noteId;
    }
  }

  draw(context: CanvasRenderingContext2D): void {
    context.save();
    context.lineWidth = ANNOTATION_LINE_WIDTH;
    context.lineCap = 'butt';
    context.lineJoin = 'miter';
    for (const mark of this.marks) {
      if (mark.filled) { context.fillStyle = mark.color; context.fill(mark.path); }
      else { context.strokeStyle = mark.color; context.stroke(mark.path); }
    }
    context.restore();
  }
}
