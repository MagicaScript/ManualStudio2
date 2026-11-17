/** Range selection follows the currently visible assembly-list order. */
export function rangeSelection(order: string[], anchor: string | undefined, target: string, previous: string[] = [], additive = false): string[] {
  const end = order.indexOf(target); if (end < 0) return previous;
  const start = anchor ? order.indexOf(anchor) : -1;
  const range = start < 0 ? [target] : order.slice(Math.min(start, end), Math.max(start, end) + 1);
  return additive ? [...new Set([...previous, ...range])] : range;
}
export function nextListPart(order: string[], current: string | undefined, direction: 1 | -1): string | undefined {
  if (!order.length) return;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return direction === 1 ? order[0] : order.at(-1);
  return order[(index + direction + order.length) % order.length];
}
