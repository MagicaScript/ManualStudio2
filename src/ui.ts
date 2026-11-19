import './copy-notifications.css';

export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function element<T extends HTMLElement = HTMLElement>(selector: string): T { const result = document.querySelector<T>(selector); if (!result) throw new Error(`Missing interface element ${selector}`); return result; }
export { icon } from './icons.ts';

interface MenuAction { label: string; action: () => void | Promise<void>; danger?: boolean; disabled?: boolean }
type MenuItem = MenuAction | { label: string; submenu: MenuAction[]; disabled?: boolean };

function positionMenu(popup: HTMLElement, x: number, y: number): void {
  popup.style.left = `${Math.max(4, Math.min(x, innerWidth - popup.offsetWidth - 4))}px`;
  popup.style.top = `${Math.max(4, Math.min(y, innerHeight - popup.offsetHeight - 4))}px`;
}

document.addEventListener('pointerdown', event => {
  const popup = document.querySelector('.popup-menu');
  if (popup && event.target instanceof Node && !popup.contains(event.target)) popup.remove();
}, true);

export function menu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[]): void {
  document.querySelector('.popup-menu')?.remove();
  const popup = document.createElement('div');
  popup.className = 'popup-menu';
  const closeSubmenu = (): void => {
    popup.querySelector('.popup-submenu')?.remove();
    popup.querySelector('[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
  };
  const actionButton = (item: MenuAction): HTMLButtonElement => {
    const button = document.createElement('button');
    button.textContent = item.label;
    button.disabled = !!item.disabled;
    if (item.danger) button.className = 'danger';
    button.onclick = async () => {
      popup.remove();
      try { await item.action(); } catch (error) { toast(String(error)); }
    };
    return button;
  };
  for (const item of items) {
    if (!('submenu' in item)) {
      const button = actionButton(item);
      button.onpointerenter = closeSubmenu;
      popup.append(button);
      continue;
    }
    const button = document.createElement('button');
    button.textContent = item.label;
    button.disabled = !!item.disabled;
    button.setAttribute('aria-expanded', 'false');
    button.className = 'popup-submenu-toggle';
    const openSubmenu = (): void => {
      if (button.disabled || button.getAttribute('aria-expanded') === 'true') return;
      closeSubmenu();
      const submenu = document.createElement('div');
      submenu.className = 'popup-menu popup-submenu';
      item.submenu.forEach(child => submenu.append(actionButton(child)));
      popup.append(submenu);
      button.setAttribute('aria-expanded', 'true');
      const parent = popup.getBoundingClientRect();
      const x = parent.right + submenu.offsetWidth <= innerWidth - 4 ? parent.right - 1 : parent.left - submenu.offsetWidth + 1;
      positionMenu(submenu, x, button.getBoundingClientRect().top);
    };
    button.onpointerenter = openSubmenu;
    button.onclick = openSubmenu;
    popup.append(button);
  }
  document.body.append(popup);
  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    positionMenu(popup, rect.left, rect.bottom + 3);
  } else positionMenu(popup, anchor.x, anchor.y);
}
let toastTimer: ReturnType<typeof setTimeout>;
function positionCopyConfirmations(): void {
  const region = document.querySelector<HTMLElement>('.copy-notifications'); if (!region) return;
  const status = document.querySelector<HTMLElement>('.toast');
  region.style.bottom = `${status ? Math.max(110, innerHeight - status.getBoundingClientRect().top + 8) : 110}px`;
}
type CopyPosition = { top: number; bottom: number };
function copyPositions(container: HTMLElement): Map<HTMLElement, CopyPosition> {
  const positions = new Map<HTMLElement, CopyPosition>();
  for (const child of container.children) if (child instanceof HTMLElement) {
    const box = child.getBoundingClientRect(); positions.set(child, { top: box.top, bottom: box.bottom });
  }
  // Snapshot the current motion before replacing it; the independent fade keeps its original clock.
  for (const child of positions.keys()) child.getAnimations().filter(animation => animation.id === 'copy-notification-motion').forEach(animation => animation.cancel());
  return positions;
}
function animateCopyPositions(container: HTMLElement, positions: Map<HTMLElement, CopyPosition>, arriving?: HTMLElement): void {
  const gap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
  const last = [...positions.values()].at(-1);
  for (const child of container.children) if (child instanceof HTMLElement) {
    const box = child.getBoundingClientRect(), previous = positions.get(child);
    const offset = previous ? previous.top - box.top : child === arriving ? Math.max(box.height + gap, (last?.bottom ?? box.top) + gap - box.top) : 0;
    if (Math.abs(offset) < .5) continue;
    const animation = child.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: 120, easing: 'cubic-bezier(.2,.7,.2,1)' });
    animation.id = 'copy-notification-motion';
  }
}
function copyConfirmation(message: string): void {
  let region = document.querySelector<HTMLDivElement>('.copy-notifications');
  if (!region) {
    region = document.createElement('div'); region.className = 'copy-notifications'; region.setAttribute('role', 'log');
    region.setAttribute('aria-label', 'Copy confirmations'); region.setAttribute('aria-live', 'polite'); region.setAttribute('aria-relevant', 'additions');
    document.body.append(region);
  }
  const previous = copyPositions(region);
  const node = document.createElement('div'); node.className = 'copy-notification'; node.textContent = message;
  const container = region;
  const expire = (event: AnimationEvent): void => {
    if (event.target !== node || event.animationName !== 'copy-confirmation-fade') return;
    node.removeEventListener('animationend', expire); const positions = copyPositions(container); node.remove();
    if (!container.childElementCount) container.remove(); else animateCopyPositions(container, positions);
  };
  node.addEventListener('animationend', expire);
  region.append(node); positionCopyConfirmations(); region.scrollTop = region.scrollHeight; animateCopyPositions(region, previous, node);
}
export function toast(message: string, duration: number | 'copy' = 5500): void {
  if (duration === 'copy') { copyConfirmation(message); return; }
  document.querySelector('.toast')?.remove(); clearTimeout(toastTimer); const node = document.createElement('div'); node.className = 'toast'; node.textContent = message.replace(/^Error: /, ''); document.body.append(node); positionCopyConfirmations(); toastTimer = setTimeout(() => { node.remove(); positionCopyConfirmations(); }, duration);
}
export function modal(title: string, content: string, actions: { label: string; primary?: boolean; action: (root: HTMLElement) => void | Promise<void> }[]): HTMLElement {
  document.querySelector('.modal-backdrop')?.remove(); const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop'; backdrop.innerHTML = `<section class="modal"><header class="modal-header">${escape(title)}<button class="icon" data-close>×</button></header><div class="modal-body">${content}</div><footer class="modal-footer"></footer></section>`;
  backdrop.querySelector('[data-close]')!.addEventListener('click', () => backdrop.remove()); const footer = backdrop.querySelector('footer')!;
  actions.forEach(action => { const button = document.createElement('button'); button.textContent = action.label; button.className = action.primary ? 'primary' : ''; button.onclick = () => { Promise.resolve(action.action(backdrop)).catch(error => toast(String(error))); }; footer.append(button); }); document.body.append(backdrop); return backdrop;
}
export async function pickFile(accept: string): Promise<File | undefined> { return new Promise(resolve => { const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.onchange = () => resolve(input.files?.[0]); input.addEventListener('cancel', () => resolve(undefined)); input.click(); }); }
export function busy(text?: string, cancel?: () => void): void {
  if (!text) { document.querySelector('.busy-overlay')?.remove(); return; }
  let overlay = document.querySelector<HTMLDivElement>('.busy-overlay'); if (!overlay) { overlay = document.createElement('div'); overlay.className = 'busy-overlay'; document.body.append(overlay); }
  overlay.innerHTML = `<div class="busy-card"><span class="spinner"></span>${escape(text)}${cancel ? '<p><button data-cancel>Cancel</button></p>' : ''}</div>`; overlay.querySelector('[data-cancel]')?.addEventListener('click', () => cancel?.());
}

