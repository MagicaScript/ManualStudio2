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
interface LayoutPreference { offset?: readonly [number, number]; detourAngle?: number }
export const labelMargin = 12;
export function arrangeLabelBoxes<T extends LabelLayoutBox>(labels: readonly T[], width: number, height: number, obstacles: readonly LabelRectangle[] = [], preference?: (label: T) => LayoutPreference): T[] {
  const margin = labelMargin, gap = preference ? 32 : 12; const placed: T[] = [];
  for (const label of labels) {
    const at = (x: number, y: number): T => ({ ...label, x: Math.max(margin, Math.min(width - label.width - margin, x)), y: Math.max(margin, Math.min(height - label.height - margin, y)) });
    const occupied = [...obstacles, ...placed];
    const blocked = (box: LabelRectangle, clearance = gap): boolean => occupied.some(other =>
      box.x < other.x + other.width + clearance && box.x + box.width + clearance > other.x &&
      box.y < other.y + other.height + clearance && box.y + box.height + clearance > other.y);
    let candidate = at(label.x, label.y);
    const choice = preference?.(label), previous = choice?.offset;
    if (previous && blocked(candidate, gap + 12)) {
      const displaced = at(label.x + previous[0], label.y + previous[1]);
      if (!blocked(displaced)) {
        let near = 0, far = 1;
        for (let iteration = 0; iteration < 7; iteration++) {
          const middle = (near + far) / 2;
          if (blocked(at(label.x + previous[0] * middle, label.y + previous[1] * middle), gap + 6)) near = middle;
          else far = middle;
        }
        placed.push(at(label.x + previous[0] * far, label.y + previous[1] * far)); continue;
      }
    }
    if (blocked(candidate)) {
      const angle = previous
        ? Math.atan2(previous[1], previous[0])
        : Math.atan2(label.y + label.height / 2 - label.anchorY, label.x + label.width / 2 - label.anchorX);
      let found = false;
      if (choice?.detourAngle !== undefined) {
        const dx = Math.cos(choice.detourAngle), dy = Math.sin(choice.detourAngle);
        for (let radius = 16; radius <= Math.max(128, label.height * 2); radius += 16) {
          const next = at(label.x + dx * radius, label.y + dy * radius);
          if (!blocked(next)) { candidate = next; found = true; break; }
        }
      }
      for (let radius = 16; radius <= Math.hypot(width, height) && !found; radius += 16) {
        for (const offset of [0, 1, -1, 2, -2, 3, -3, 4]) {
          const next = at(label.x + Math.cos(angle + offset * Math.PI / 4) * radius, label.y + Math.sin(angle + offset * Math.PI / 4) * radius);
          if (blocked(next)) continue;
          candidate = next; found = true; break;
        }
      }
    }
    placed.push(candidate);
  }
  return placed;
}
