import './inline-name.css';

let activeEdit: { target: HTMLElement; finish: (save: boolean) => void } | undefined;

/** Keep the editor above canvas labels and list rows without nesting controls inside a button. */
export function editInlineName(target: HTMLElement, name: string, saveName: (name: string) => void): void {
  if (activeEdit?.target === target) return;
  activeEdit?.finish(true);
  const input = document.createElement('input'); input.type = 'text'; input.className = 'inline-name-editor'; input.value = name;
  input.setAttribute('aria-label', 'Name'); input.autocomplete = 'off'; input.spellcheck = false;
  const style = getComputedStyle(target); input.style.font = style.font; input.style.letterSpacing = style.letterSpacing;
  let frame = 0, finished = false;
  const outside = (event: PointerEvent): void => { if (event.target !== input) finish(true); };
  const finish = (save: boolean): void => {
    if (finished) return; finished = true; cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside, true);
    activeEdit = undefined; target.classList.remove('inline-name-target'); input.remove();
    const value = input.value.trim(); if (save && value && value !== name) saveName(value);
  };
  const place = (): void => {
    if (!target.isConnected) { finish(false); return; }
    const box = target.getBoundingClientRect();
    input.style.left = `${Math.max(4, box.left)}px`; input.style.top = `${box.top}px`;
    input.style.width = `${Math.min(Math.max(box.width, 100), innerWidth - Math.max(4, box.left) - 4)}px`;
    input.style.height = `${Math.max(box.height, 21)}px`; frame = requestAnimationFrame(place);
  };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter'); }
  });
  for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu']) input.addEventListener(type, event => event.stopPropagation());
  input.addEventListener('blur', () => finish(true));
  document.body.append(input); target.classList.add('inline-name-target'); activeEdit = { target, finish }; place();
  document.addEventListener('pointerdown', outside, true); input.focus({ preventScroll: true }); input.select();
}
