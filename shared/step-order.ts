export function stepReorderChanges(order: readonly string[], stepId: string, before?: string): boolean {
  const source = order.indexOf(stepId);
  if (source < 0) throw new Error(`Unknown step: ${stepId}`);
  const target = before === undefined ? order.length : order.indexOf(before);
  if (target < 0) throw new Error(`Unknown step: ${before}`);
  return target !== source && target !== source + 1;
}
