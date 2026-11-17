import { icon } from './ui.ts';

interface PanelState { expanded: boolean; animation?: Animation }

/** Keep disclosure state outside panel markup, which is rebuilt when frames change. */
export class PanelDisclosure {
  private states = new Map<string, PanelState>();

  sync(panel: HTMLElement): void {
    const state = this.state(panel);
    state.animation?.cancel(); state.animation = undefined;
    this.clearSize(panel);
    this.applyState(panel, state.expanded);
  }

  toggle(panel: HTMLElement): void { this.setExpanded(panel, !this.state(panel).expanded); }

  setExpanded(panel: HTMLElement, expanded: boolean): void {
    const state = this.state(panel);
    if (state.expanded === expanded) return;
    const from = panel.getBoundingClientRect().height;
    state.animation?.cancel(); this.clearSize(panel);
    state.expanded = expanded;
    this.applyState(panel, expanded);
    const to = panel.getBoundingClientRect().height;
    const body = panel.querySelector<HTMLElement>(':scope > .panel-body');
    const header = panel.querySelector<HTMLElement>(':scope > .panel-header');
    if (!body || !header || panel.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 1) return;
    body.hidden = false;
    body.style.height = `${Math.max(0, Math.max(to, from) - header.getBoundingClientRect().height)}px`;
    panel.classList.add('panel-animating'); panel.style.height = `${to}px`;
    const animation = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    state.animation = animation;
    void animation.finished.then(() => {
      if (state.animation !== animation) return;
      state.animation = undefined; this.clearSize(panel); this.applyState(panel, expanded);
    }).catch(() => {});
  }

  private state(panel: HTMLElement): PanelState {
    let state = this.states.get(panel.id);
    if (!state) { state = { expanded: true }; this.states.set(panel.id, state); }
    return state;
  }

  private clearSize(panel: HTMLElement): void {
    panel.classList.remove('panel-animating'); panel.style.removeProperty('height');
    panel.querySelector<HTMLElement>(':scope > .panel-body')?.style.removeProperty('height');
  }

  private applyState(panel: HTMLElement, expanded: boolean): void {
    const body = panel.querySelector<HTMLElement>(':scope > .panel-body');
    const button = panel.querySelector<HTMLButtonElement>('[data-panel-toggle]');
    if (!body || !button) return;
    if (!expanded && body.contains(document.activeElement)) button.focus({ preventScroll: true });
    body.hidden = !expanded; body.inert = !expanded;
    panel.classList.toggle('panel-collapsed', !expanded);
    button.innerHTML = icon(expanded ? 'collapsePanel' : 'expandPanel');
    button.setAttribute('aria-expanded', String(expanded)); button.setAttribute('aria-controls', body.id);
    button.title = `${expanded ? 'Collapse' : 'Expand'} ${panel.dataset.panelName ?? ''}`.trim();
    button.setAttribute('aria-label', button.title);
  }
}
