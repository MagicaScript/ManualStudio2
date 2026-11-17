export function wrapLabelText(text: string, width: number, measure: (value: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (line && measure(line + character) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface LabelInsets { left: number; right: number; top: number; bottom: number }
export interface MeasuredLabelBox { lines: string[]; width: number; height: number }
export function measureLabelBox(text: string, maximumWidth: number, lineHeight: number, insets: LabelInsets, measure: (value: string) => number): MeasuredLabelBox {
  const naturalWidth = Math.max(0, ...text.replace(/\r\n?/g, '\n').split('\n').map(line => measure(line.trim().replace(/\s+/g, ' '))));
  const width = Math.min(maximumWidth, Math.ceil(naturalWidth) + insets.left + insets.right + 2);
  const lines = wrapLabelText(text, Math.max(1, width - insets.left - insets.right), measure);
  return { lines, width, height: Math.ceil(lines.length * lineHeight + insets.top + insets.bottom) };
}

export interface LabelRectangle { x: number; y: number; width: number; height: number }
export interface LabelLayoutBox extends LabelRectangle { anchorX: number; anchorY: number }
export function arrangeLabelBoxes<T extends LabelLayoutBox>(labels: readonly T[], width: number, height: number, obstacles: readonly LabelRectangle[] = []): T[] {
  const margin = 12, gap = 12; const placed: T[] = [];
  const intersects = (a: LabelRectangle, b: LabelRectangle): boolean => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
  for (const label of labels) {
    const at = (x: number, y: number): T => ({ ...label, x: Math.max(margin, Math.min(width - label.width - margin, x)), y: Math.max(margin, Math.min(height - label.height - margin, y)) });
    let candidate = at(label.x, label.y);
    if ([...obstacles, ...placed].some(other => intersects(candidate, other))) {
      const angle = Math.atan2(label.y + label.height / 2 - label.anchorY, label.x + label.width / 2 - label.anchorX);
      let found = false;
      for (let radius = 16; radius <= Math.hypot(width, height) && !found; radius += 16) {
        for (const offset of [0, 1, -1, 2, -2, 3, -3, 4]) {
          const next = at(label.x + Math.cos(angle + offset * Math.PI / 4) * radius, label.y + Math.sin(angle + offset * Math.PI / 4) * radius);
          if ([...obstacles, ...placed].some(other => intersects(next, other))) continue;
          candidate = next; found = true; break;
        }
      }
    }
    placed.push(candidate);
  }
  return placed;
}
