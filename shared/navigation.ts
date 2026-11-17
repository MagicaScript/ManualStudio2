import type { Vec3 } from './types.ts';

export const viewDirections: Record<string, Vec3> = {
  top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0],
  left: [-1, 0, 0], right: [1, 0, 0], iso: [-1, -1, Math.SQRT2],
};
const viewKeys: Record<string, string> = { '1': 'top', '2': 'bottom', '3': 'front', '4': 'back', '5': 'left', '6': 'right', '7': 'iso' };
export function shortcutView(key: string, code: string): string | undefined { return viewKeys[code.replace(/^(Digit|Numpad)/, '')] ?? viewKeys[key]; }

/** Bambu's face grid uses a central half-width panel and quarter-width edge panels. */
export function navigatorDirection(point: Vec3): Vec3 { return point.map(value => Math.abs(value) > .25 ? Math.sign(value) : 0) as Vec3; }

export function orbitDirection(direction: Vec3, dx: number, dy: number): Vec3 {
  const length = Math.hypot(...direction);
  const azimuth = Math.atan2(direction[0], -direction[1]) - dx * .01;
  const elevation = Math.max(-Math.PI / 2 + 1e-6, Math.min(Math.PI / 2 - 1e-6, Math.asin(Math.max(-1, Math.min(1, direction[2] / length))) + dy * .01));
  const horizontal = Math.cos(elevation);
  return [Math.sin(azimuth) * horizontal, -Math.cos(azimuth) * horizontal, Math.sin(elevation)];
}
