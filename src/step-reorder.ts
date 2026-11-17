import { stepReorderChanges } from '../shared/step-order.ts';

interface StepMove { stepId: string; before?: string }
interface DraggedStep { id: string; card: HTMLElement; gap?: HTMLElement }

export class StepReorder {
  private dragged?: DraggedStep;
  private scrollFrame = 0;
  private pointer?: { x: number; y: number };
  private lastScrollTime = 0;

  constructor(private readonly container: HTMLElement, private readonly order: () => string[]) {}

  get active(): boolean { return !!this.dragged; }

  start(stepId: string, event: DragEvent): void {
    this.cancel();
    const card = this.container.querySelector<HTMLElement>(`[data-step="${CSS.escape(stepId)}"]`);
    if (!card || !this.order().includes(stepId)) return;
    this.dragged = { id: stepId, card };
    this.container.style.setProperty('--reorder-card-height', `${card.getBoundingClientRect().height}px`);
    this.container.classList.add('step-reordering');
    this.container.dataset.reorderStep = stepId;
    card.classList.add('step-reorder-source');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  over(event: DragEvent): void {
    if (!this.dragged) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    if (!this.inside(event.clientX, event.clientY)) { this.preview(); this.stopScrolling(); return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.preview(this.gapAt(event.target));
    if (!this.scrollFrame) { this.lastScrollTime = performance.now(); this.scrollFrame = requestAnimationFrame(time => this.scroll(time)); }
  }

  leave(event: DragEvent): void {
    if (this.dragged && !this.inside(event.clientX, event.clientY)) { this.preview(); this.stopScrolling(); }
  }

  drop(event: DragEvent): StepMove | undefined {
    if (!this.dragged) return;
    event.preventDefault();
    const gap = this.inside(event.clientX, event.clientY) ? this.gapAt(event.target) : undefined;
    const stepId = this.dragged.id, before = gap?.dataset.reorderBefore || undefined;
    const changed = !!gap && stepReorderChanges(this.order(), stepId, before);
    this.cancel();
    return changed ? { stepId, before } : undefined;
  }

  cancel(): void {
    this.stopScrolling();
    this.dragged?.card.classList.remove('step-reorder-source');
    this.preview();
    this.dragged = undefined;
    this.pointer = undefined;
    this.container.classList.remove('step-reordering');
    delete this.container.dataset.reorderStep;
    this.container.style.removeProperty('--reorder-card-height');
  }

  private gapAt(target: EventTarget | null): HTMLElement | undefined {
    const gap = target instanceof Element ? target.closest<HTMLElement>('[data-reorder-before]') : null;
    return gap && this.container.contains(gap) ? gap : undefined;
  }

  private inside(x: number, y: number): boolean {
    const box = this.container.getBoundingClientRect();
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  }

  private preview(gap?: HTMLElement): void {
    if (!this.dragged || this.dragged.gap === gap) return;
    this.dragged.gap?.classList.remove('step-reorder-target', 'step-reorder-original');
    this.dragged.gap = gap;
    if (!gap) return;
    const changed = stepReorderChanges(this.order(), this.dragged.id, gap.dataset.reorderBefore || undefined);
    gap.classList.add(changed ? 'step-reorder-target' : 'step-reorder-original');
  }

  private stopScrolling(): void { cancelAnimationFrame(this.scrollFrame); this.scrollFrame = 0; }

  private scroll(time: number): void {
    this.scrollFrame = 0;
    if (!this.dragged || !this.pointer || !this.inside(this.pointer.x, this.pointer.y)) return;
    const box = this.container.getBoundingClientRect(), edge = Math.min(42, box.height / 5);
    const speed = this.pointer.y < box.top + edge ? -280 * (1 - (this.pointer.y - box.top) / edge)
      : this.pointer.y > box.bottom - edge ? 280 * (1 - (box.bottom - this.pointer.y) / edge) : 0;
    const previous = this.container.scrollTop;
    this.container.scrollTop += speed * Math.min(time - this.lastScrollTime, 32) / 1000;
    this.lastScrollTime = time;
    if (this.container.scrollTop !== previous) this.preview(this.gapAt(document.elementFromPoint(this.pointer.x, this.pointer.y)));
    this.scrollFrame = requestAnimationFrame(next => this.scroll(next));
  }
}
