import { easeMotion } from '../shared/playback.ts';
import { arrangeLabelBoxes, labelMargin, type LabelLayoutBox } from '../shared/text-layout.ts';

type Offset = [number, number];
type OffsetTrack = (Offset | undefined)[];
interface MotionBox extends LabelLayoutBox { id: string }

/** Plan on a fixed time grid so drawing and seeking never depend on previously drawn frames. */
export function planLabelMotion(duration: number, width: number, height: number, positionsAt: (progress: number) => MotionBox[]): Map<string, OffsetTrack> {
  // Include the transition midpoint where unmatched annotations change visibility.
  const intervals = Math.max(20, Math.min(120, 2 * Math.ceil(duration * 12)));
  const radius = Math.max(2, Math.min(Math.floor(intervals / 4), Math.ceil(.20 * intervals / duration)));
  const samples = Array.from({ length: intervals + 1 }, (_, index) => positionsAt(index / intervals));
  const first = samples[0];
  const moving = samples.some(positions => positions.length !== first.length || positions.some((box, index) => {
    const start = first[index];
    return box.id !== start.id || box.width !== start.width || box.height !== start.height ||
      Math.hypot(box.x - start.x, box.y - start.y, box.anchorX - start.anchorX, box.anchorY - start.anchorY) > .001;
  }));
  if (!moving) {
    const offsets = arrangeLabelBoxes(first, width, height).map((box, index) => [box.x - first[index].x, box.y - first[index].y] satisfies Offset);
    return new Map(first.map((box, index) => [box.id, [offsets[index], offsets[index]]]));
  }
  const indexed = samples.map(boxes => new Map(boxes.map(box => [box.id, box])));
  const tracks = new Map<string, OffsetTrack>();
  for (let index = 0; index <= intervals; index++) {
    const positions = samples[index];
    const preference = (box: MotionBox) => {
      const previous = tracks.get(box.id)?.[index - 1];
      const offset = previous && (previous[0] || previous[1]) ? previous : undefined;
      const before = indexed[Math.max(index - radius, 0)].get(box.id) ?? box;
      const after = indexed[Math.min(index + radius, intervals)].get(box.id) ?? box;
      const dx = after.x - before.x, dy = after.y - before.y;
      const vertical = Math.abs(dx) >= Math.abs(dy);
      // A detour across the direction of travel stays clear as the labels pass one another.
      const detourAngle = vertical
        ? ((offset?.[1] || box.y + box.height / 2 - box.anchorY) <= 0 ? -Math.PI / 2 : Math.PI / 2)
        : ((offset?.[0] || box.x + box.width / 2 - box.anchorX) >= 0 ? 0 : Math.PI);
      return { offset, detourAngle };
    };
    const arranged = arrangeLabelBoxes(positions, width, height, [], index > 0 && index < intervals ? preference : undefined);
    arranged.forEach((box, boxIndex) => {
      const track = tracks.get(box.id) ?? Array<Offset | undefined>(intervals + 1).fill(undefined);
      const original = positions[boxIndex];
      track[index] = [box.x - original.x, box.y - original.y];
      tracks.set(box.id, track);
    });
  }
  // Blend avoidance changes on both sides of a collision, retaining the exact endpoint layouts.
  for (const [id, track] of tracks) {
    const endpointWindow = (endpointIndex: number): number => {
      const endpoint = track[endpointIndex]; if (!endpoint) return radius;
      const half = Math.floor(intervals / 2);
      let travel = 0;
      for (let distance = 1; distance <= half; distance++) {
        const offset = track[endpointIndex === 0 ? distance : intervals - distance];
        if (offset) travel = Math.max(travel, Math.hypot(offset[0] - endpoint[0], offset[1] - endpoint[1]));
      }
      // A large detour needs longer than the ordinary collision smoothing window to settle.
      return Math.min(half, Math.max(radius, Math.ceil(travel * intervals / (320 * duration))));
    };
    const startWindow = endpointWindow(0), endWindow = endpointWindow(intervals);
    tracks.set(id, track.map((offset, index) => {
      const box = indexed[index].get(id);
      if (!offset || !box || index === 0 || index === intervals) return offset;
      let x = 0, y = 0, weight = 0;
      for (let sample = Math.max(index - radius, 0); sample <= Math.min(index + radius, intervals); sample++) {
        const point = track[sample]; if (!point) continue;
        const influence = radius + 1 - Math.abs(sample - index);
        x += point[0] * influence; y += point[1] * influence; weight += influence;
      }
      const atStart = index < startWindow, atEnd = index > intervals - endWindow;
      const endpoint = atStart ? track[0] : atEnd ? track[intervals] : undefined;
      const blend = endpoint ? easeMotion(atStart ? index / startWindow : (intervals - index) / endWindow) : 1;
      const dx = x / weight * blend + (endpoint?.[0] ?? 0) * (1 - blend);
      const dy = y / weight * blend + (endpoint?.[1] ?? 0) * (1 - blend);
      return [boundCoordinate(box.x + dx, width - box.width) - box.x, boundCoordinate(box.y + dy, height - box.height) - box.y];
    }));
  }
  return tracks;
}

export function labelMotionOffset(track: OffsetTrack | undefined, progress: number): Offset {
  if (!track) return [0, 0];
  const index = progress * (track.length - 1), first = Math.floor(index);
  const from = track[first], to = track[first + 1];
  if (!from || !to) return from ?? to ?? [0, 0];
  const t = index - first;
  // Matched tangents keep motion continuous without overshooting a planned detour.
  const tangent = (a: number, b: number): number => a * b > 0 ? Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)) : 0;
  const coordinate = (axis: 0 | 1): number => {
    const start = from[axis], end = to[axis], delta = end - start;
    const outgoing = tangent(start - (track[first - 1]?.[axis] ?? start), delta);
    const incoming = tangent(delta, (track[first + 2]?.[axis] ?? end) - end);
    return start + t * (outgoing + t * (3 * delta - 2 * outgoing - incoming + t * (outgoing + incoming - 2 * delta)));
  };
  return [coordinate(0), coordinate(1)];
}

function boundCoordinate(value: number, room: number, feather = 0): number {
  const lower = labelMargin, upper = Math.max(lower, room - labelMargin);
  const easeToEdge = (distance: number): number => {
    if (distance >= feather) return feather;
    const t = 1 - distance / feather;
    return feather * (1 - t * t * (2 - t));
  };
  if (value < lower) return lower - easeToEdge(lower - value);
  if (value > upper) return upper + easeToEdge(value - upper);
  return value;
}

export function positionAnimatedLabel<T extends LabelLayoutBox>(box: T, track: OffsetTrack | undefined, progress: number, width: number, height: number): T {
  const [dx, dy] = labelMotionOffset(track, progress);
  // The exact camera projection between samples can extend past the planned margin.
  // Ease the last few pixels of travel so contact with the edge has no velocity jump.
  return { ...box, x: boundCoordinate(box.x + dx, width - box.width, 4), y: boundCoordinate(box.y + dy, height - box.height, 4) };
}
