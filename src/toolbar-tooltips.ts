import './toolbar-tooltips.css';

interface ToolbarTooltip {
  button: HTMLButtonElement;
  text: string;
}

export function installToolbarTooltips(items: readonly ToolbarTooltip[]): void {
  let active: { button: HTMLButtonElement; tooltip: HTMLDivElement } | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const hide = (): void => {
    clearTimeout(pending);
    pending = undefined;
    if (!active) return;
    active.tooltip.hidden = true;
    active.button.removeAttribute('aria-describedby');
    active = undefined;
  };

  for (const { button, text } of items) {
    const target = document.createElement('span');
    target.className = 'toolbar-tooltip-target';
    button.before(target);
    target.append(button);
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title || text);
    button.removeAttribute('title');

    const tooltip = document.createElement('div');
    tooltip.className = 'toolbar-tooltip';
    tooltip.id = `${button.id}-tooltip`;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = text;
    tooltip.hidden = true;
    document.body.append(tooltip);

    const show = (): void => {
      hide();
      if (!button.isConnected) return;
      tooltip.hidden = false;
      const anchor = button.getBoundingClientRect();
      const box = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(4, Math.min(anchor.left + 3, window.innerWidth - box.width - 4))}px`;
      tooltip.style.top = `${anchor.bottom + 4}px`;
      button.setAttribute('aria-describedby', tooltip.id);
      active = { button, tooltip };
    };

    target.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch') return;
      hide();
      pending = setTimeout(show, 400);
    });
    target.addEventListener('pointerleave', hide);
    target.addEventListener('pointerdown', hide);
    target.addEventListener('click', hide);
    button.addEventListener('focus', show);
    button.addEventListener('blur', hide);
  }

  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
