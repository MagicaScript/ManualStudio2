import { Vector3 } from 'three';
import { isDirection, isFiniteNumber, isRecord, isVec3 } from './assembly-motion.ts';
import type { Centerline, CenterlineSegment } from './types.ts';

type Arc = Extract<CenterlineSegment, { kind: 'arc' }>;

export function isCenterline(value: unknown): value is Centerline {
  return isRecord(value) && typeof value.partId === 'string' && isVec3(value.start)
    && Array.isArray(value.segments) && value.segments.length > 0 && value.segments.every(segment => isRecord(segment) && (
      segment.kind === 'line' && isVec3(segment.to) || segment.kind === 'arc' && isVec3(segment.center)
        && isDirection(segment.normal) && isFiniteNumber(segment.angleDegrees)
    ));
}

interface Piece {
  length: number;
  pointAt(distance: number): Vector3;
  directionAt(distance: number): Vector3;
}

function straight(start: Vector3, end: Vector3): Piece {
  const delta = end.clone().sub(start), length = delta.length();
  if (!(length > 1e-9 && Number.isFinite(length))) throw new Error('A centerline straight segment needs distinct endpoints.');
  const direction = delta.divideScalar(length);
  return { length, pointAt: distance => start.clone().addScaledVector(direction, distance), directionAt: () => direction.clone() };
}

function circular(start: Vector3, arc: Arc): Piece {
  const center = new Vector3(...arc.center), normal = new Vector3(...arc.normal).normalize(), radial = start.clone().sub(center);
  const radius = radial.clone().projectOnPlane(normal).length();
  if (Math.abs(radial.dot(normal)) > 1e-4) throw new Error('An arc center and its start must lie in the arc plane.');
  const sweep = arc.angleDegrees * (Math.PI / 180), length = radius * Math.abs(sweep), sign = Math.sign(sweep);
  if (!(radius > 1e-9 && length > 1e-9 && Number.isFinite(length))) throw new Error('An arc needs a nonzero radius and sweep.');
  const radialAt = (distance: number) => radial.clone().applyAxisAngle(normal, sign * distance / radius);
  return { length, pointAt: distance => radialAt(distance).add(center), directionAt: distance => normal.clone().cross(radialAt(distance)).normalize().multiplyScalar(sign) };
}

export function compileCenterline(path: Centerline) {
  const start = new Vector3(...path.start);
  const arc = path.segments.find(segment => segment.kind === 'arc');
  let normal = arc && new Vector3(...arc.normal).normalize();
  let end = start, length = 0;
  const pieces = path.segments.map(segment => {
    const begin = length;
    const piece = segment.kind === 'line' ? straight(end, new Vector3(...segment.to)) : circular(end, segment);
    if (segment.kind === 'arc' && normal && Math.abs(new Vector3(...segment.normal).normalize().dot(normal)) < 1 - 1e-8) {
      throw new Error('All arcs in a centerline must share a plane.');
    }
    end = piece.pointAt(piece.length);
    length += piece.length;
    return { ...piece, begin, end };
  });
  if (!Number.isFinite(length)) throw new Error('The centerline length must be finite.');
  const first = pieces[0], last = pieces[pieces.length - 1], startDirection = first.directionAt(0);
  if (!normal) {
    normal = pieces.map(piece => startDirection.clone().cross(piece.directionAt(0))).find(candidate => candidate.lengthSq() > 1e-12)?.normalize()
      ?? startDirection.clone().cross(Math.abs(startDirection.x) < .9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
  }
  for (const piece of pieces) {
    if (Math.abs(piece.end.clone().sub(start).dot(normal)) > 1e-4 || Math.abs(piece.directionAt(0).dot(normal)) > 1e-6) {
      throw new Error('All segments in a centerline must lie in the same plane.');
    }
  }
  const endDirection = last.directionAt(last.length);
  const pointAt = (distance: number): Vector3 => {
    if (distance < 0) return start.clone().addScaledVector(startDirection, distance);
    if (distance >= length) return end.clone().addScaledVector(endDirection, distance - length);
    const piece = pieces.find(piece => distance < piece.begin + piece.length) ?? last;
    return piece.pointAt(distance - piece.begin);
  };
  const chordAt = (distance: number, halfSpan: number): Vector3 => {
    const chord = pointAt(distance + halfSpan).sub(pointAt(distance - halfSpan));
    if (chord.lengthSq() < 1e-18 || !Number.isFinite(chord.lengthSq())) throw new Error('The centerline chord has no direction. Use a different half-span.');
    return chord.normalize();
  };
  return { length, normal, pointAt, chordAt };
}
