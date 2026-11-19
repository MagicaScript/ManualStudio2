import { Matrix4, Plane, Triangle, Vector3, type BufferGeometry } from 'three';
import type { Anchor, ModelTreeNode, Project, SurfaceRegion, Vec3 } from '../shared/types.ts';
import { isAxisReference, isDirection, isFiniteNumber, isRecord, isVec3, poseMatrix, resolveAxis } from '../shared/assembly-motion.ts';
import { browserRoots, modelVisibility } from '../shared/model-tree.ts';
import { connectedFace, cylinderAxis } from '../shared/surfaces.ts';
import { loadGeometry, meshTree, poseContext, readTriangle, surfaceVertices } from './geometry-data.ts';

type Context = ReturnType<typeof poseContext>;
type Axis = { origin: Vector3; direction: Vector3 };
interface Cylinder extends Axis { diameter: number; extent: [number, number]; maxRadialError: number }
interface ClipPlane { normal: Vec3; constant: number }

function axisCoordinates(axis: Axis, matrix: Matrix4) {
  return { origin: axis.origin.clone().applyMatrix4(matrix).toArray(), direction: axis.direction.clone().transformDirection(matrix).toArray() };
}

function findGeometry(project: Project, request: Record<string, unknown>, context: Context) {
  const { query = '', referencePartId } = request;
  if (typeof query !== 'string' || referencePartId !== undefined && typeof referencePartId !== 'string') throw new Error('Provide a text query and optionally a reference part ID.');
  const inverse = referencePartId === undefined ? undefined : poseMatrix(context.pose(referencePartId)).invert();
  const { parts, axes, objects } = modelVisibility(project);
  const names = new Map<string, string[]>();
  const objectResults: { id: string; name: string; path: string[]; componentPath?: string; visible: boolean }[] = [];
  const matches = (...values: (string | undefined)[]): boolean => values.some(value => value?.toLowerCase().includes(query.trim().toLowerCase()));
  const visit = (node: ModelTreeNode, parents: string[]): void => {
    const path = [...parents, node.name];
    if (node.partId || node.axisId) names.set(node.partId ?? node.axisId!, path);
    if (node.kind === 'object' && matches(node.id, node.name, node.componentPath, path.join(' / '))) {
      objectResults.push({ id: node.id, name: node.name, path, componentPath: node.componentPath, visible: objects.get(node.id) ?? true });
    }
    node.children?.forEach(child => visit(child, path));
  };
  browserRoots(project.model).forEach(node => visit(node, []));
  return {
    objects: objectResults,
    parts: project.model.parts.filter(part => matches(part.id, part.name, part.sourceName, part.path, part.nativeToken, names.get(part.id)?.join(' / '))).map(part => {
      const pose = context.pose(part.id);
      return {
        id: part.id, name: part.name, sourceName: part.sourceName, path: names.get(part.id) ?? [part.name], sourcePath: part.path,
        objectId: part.objectId, sourceStatus: part.sourceStatus, nativeToken: part.nativeToken, occurrenceToken: part.occurrenceToken,
        materialName: part.materialName, appearanceName: part.appearanceName,
        modelVisible: parts.get(part.id) ?? true, hiddenInFrame: context.frame?.hidden.includes(part.id) ?? false,
        pose, sourcePose: part.home, assemblyPose: part.assemblyHome ?? part.home, sourceBounds: part.bounds,
        vertices: part.geometry.vertices, triangles: part.geometry.triangles,
        ...(inverse && { localToReference: inverse.clone().multiply(poseMatrix(pose)).toArray() }),
      };
    }),
    axes: (project.model.constructionAxes ?? []).filter(axis => matches(axis.id, axis.name, axis.sourceName, axis.componentPath, axis.nativeToken, names.get(axis.id)?.join(' / '))).map(axis => {
      const world = resolveAxis({ axisId: axis.id }, [axis], context.lookup);
      return {
        id: axis.id, name: axis.name, path: names.get(axis.id) ?? [axis.name], componentPath: axis.componentPath,
        nativeToken: axis.nativeToken, occurrenceToken: axis.occurrenceToken, partIds: axis.partIds,
        visible: axes.get(axis.id) ?? axis.visible, extent: axis.extent, extentSource: axis.extentSource,
        source: { origin: axis.origin, direction: axis.direction }, world: { origin: world.origin.toArray(), direction: world.direction.toArray() },
        ...(inverse && { localToReference: axisCoordinates(world, inverse) }),
      };
    }),
    referencePartId,
  };
}

function fitCylinder(geometry: BufferGeometry, triangles: number[], points: Vector3[]): Cylinder | undefined {
  const direction = new Vector3(...cylinderAxis(geometry, triangles));
  const tangent = Math.abs(direction.x) < .8 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = tangent.cross(direction).normalize(), v = new Vector3().crossVectors(direction, u);
  const mean = points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
  const triangle = new Triangle(), normal = new Vector3();
  const seed = readTriangle(geometry, triangles[0], triangle).getNormal(new Vector3());
  let curved = false;
  for (const id of triangles) {
    readTriangle(geometry, id, triangle).getNormal(normal);
    if (Math.abs(normal.dot(direction)) > .005) return;
    if (Math.abs(seed.dot(normal)) < .995) curved = true;
  }
  if (!curved) return;

  let xx = 0, xy = 0, yy = 0, xr = 0, yr = 0;
  let min = Infinity, max = -Infinity;
  for (const point of points) {
    const delta = point.clone().sub(mean);
    const x = delta.dot(u), y = delta.dot(v), r = (x * x + y * y) * .5, axial = delta.dot(direction);
    xx += x * x; xy += x * y; yy += y * y; xr += x * r; yr += y * r;
    min = Math.min(min, axial); max = Math.max(max, axial);
  }
  const determinant = xx * yy - xy * xy;
  if (determinant <= 1e-10 * (xx + yy) ** 2 || max - min < 1e-6) return;
  const origin = mean.addScaledVector(u, (yy * xr - xy * yr) / determinant).addScaledVector(v, (xx * yr - xy * xr) / determinant);
  const radial = (point: Vector3): number => {
    const delta = point.clone().sub(origin);
    return Math.hypot(delta.dot(u), delta.dot(v));
  };
  const radius = points.reduce((sum, point) => sum + radial(point), 0) / points.length;
  const maxRadialError = points.reduce((max, point) => Math.max(max, Math.abs(radial(point) - radius)), 0);
  if (!Number.isFinite(radius) || radius <= 0 || maxRadialError > Math.max(.001, radius * .005)) return;
  return { origin, direction, diameter: radius * 2, maxRadialError, extent: [min, max] };
}

function clipPolygon(vertices: Vector3[], plane: Plane): Vector3[] {
  const clipped: Vector3[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
    if (da <= 0) clipped.push(a);
    if ((da <= 0) !== (db <= 0)) clipped.push(a.clone().lerp(b, da / (da - db)));
  }
  return clipped;
}

function coverage(geometry: BufferGeometry, triangles: number[], planes: Plane[], axis?: Axis, anchorPoint?: Vector3) {
  const triangle = new Triangle(), active: number[] = [], boundsMin = new Vector3(Infinity, Infinity, Infinity), boundsMax = new Vector3(-Infinity, -Infinity, -Infinity);
  let area = 0, low = Infinity, high = -Infinity;
  let nearest: { triangle: number; point: Vector3; distance: number } | undefined;
  const clippedFace = new Triangle(), candidate = new Vector3();
  for (const id of triangles) {
    const { a, b, c } = readTriangle(geometry, id, triangle);
    let polygon = [a, b, c];
    for (const plane of planes) polygon = clipPolygon(polygon, plane);
    let faceArea = 0;
    for (let i = 1; i + 1 < polygon.length; i++) {
      clippedFace.set(polygon[0], polygon[i], polygon[i + 1]);
      const area = clippedFace.getArea();
      faceArea += area;
      if (!anchorPoint || area <= 1e-12) continue;
      clippedFace.closestPointToPoint(anchorPoint, candidate);
      const distance = candidate.distanceToSquared(anchorPoint);
      if (!nearest || distance < nearest.distance) nearest = { triangle: id, point: candidate.clone(), distance };
    }
    if (faceArea <= 1e-12) continue;
    area += faceArea; active.push(id);
    for (const point of polygon) {
      boundsMin.min(point); boundsMax.max(point);
      if (axis) {
        const t = point.clone().sub(axis.origin).dot(axis.direction);
        low = Math.min(low, t); high = Math.max(high, t);
      }
    }
  }
  return { nearest, summary: { triangles: active, area, bounds: active.length ? [boundsMin.toArray(), boundsMax.toArray()] : null, ...(axis && { axialRange: active.length ? [low, high] : null }) } };
}

function paintRegion(request: Record<string, unknown>, project: Project, context: Context, geometry: BufferGeometry, anchor: Anchor, transform: Matrix4, cylinder?: Cylinder) {
  const { band, clipPlanes = [], space = 'local' } = request;
  const inverse = transform.clone().invert();
  if (!Array.isArray(clipPlanes) || !clipPlanes.every((plane): plane is ClipPlane => isRecord(plane) && isDirection(plane.normal) && isFiniteNumber(plane.constant))) {
    throw new Error('Clip planes require a nonzero normal and a finite constant.');
  }
  const planes = clipPlanes.map(({ normal, constant }) => {
    const plane = new Plane(new Vector3(...normal), constant).normalize();
    return space === 'world' ? plane.applyMatrix4(inverse) : plane;
  });
  const triangleIds = anchor.region!.triangles;
  const region: SurfaceRegion = {
    kind: 'face', triangles: triangleIds, center: anchor.point, normal: anchor.normal, radius: 0, axis: anchor.normal, width: 0,
    ...(planes.length && { clipPlanes: planes.map(plane => ({ normal: plane.normal.toArray(), constant: plane.constant })) }),
  };
  let axis: Axis | undefined, range: [number, number] | undefined;
  if (band !== undefined) {
    if (!isRecord(band) || !Array.isArray(band.range) || band.range.length !== 2 || !band.range.every(isFiniteNumber) || band.range[0] >= band.range[1]
      || band.axis !== undefined && !isAxisReference(band.axis)) throw new Error('A band requires an increasing axial range and optionally an axis reference.');
    range = [band.range[0], band.range[1]];
    if (band.axis) {
      const resolved = resolveAxis(band.axis, project.model.constructionAxes ?? [], context.lookup);
      axis = { origin: resolved.origin.applyMatrix4(inverse), direction: resolved.direction.transformDirection(inverse) };
    } else axis = cylinder;
    if (!axis) throw new Error('No cylinder could be fitted to this patch. Select a cylindrical surface or specify a band axis.');
    const [low, high] = range, axisDotOrigin = axis.direction.dot(axis.origin);
    region.kind = 'band'; region.axis = axis.direction.toArray();
    region.width = high - low; region.center = axis.origin.clone().addScaledVector(axis.direction, (low + high) / 2).toArray();
    planes.push(new Plane(axis.direction.clone().negate(), axisDotOrigin + low), new Plane(axis.direction.clone(), -axisDotOrigin - high));
  }
  const { summary, nearest } = coverage(geometry, triangleIds, planes, axis, new Vector3(...anchor.point));
  region.triangles = summary.triangles;
  let paintedAnchor: Anchor | null = null;
  if (nearest) {
    const triangle = readTriangle(geometry, nearest.triangle, new Triangle());
    paintedAnchor = {
      ...anchor, target: band === undefined ? 'face' : 'band', region, point: nearest.point.toArray(),
      triangle: nearest.triangle, normal: triangle.getNormal(new Vector3()).toArray(),
      barycentric: triangle.getBarycoord(nearest.point, new Vector3())?.toArray(),
    };
  }
  return {
    anchor: paintedAnchor,
    coverage: { ...summary, requestedRange: range, axis: axis && { local: axisCoordinates(axis, new Matrix4()), world: axisCoordinates(axis, transform) } },
  };
}

export async function queryGeometry(project: Project, directory: string, request: Record<string, unknown>) {
  const { operation, partId, frameId, progress = 0, space = 'local', point, triangle: seed, triangles, angleDegrees = 25, includeMesh = false } = request;
  if (frameId !== undefined && typeof frameId !== 'string' || !isFiniteNumber(progress) || progress < 0 || progress > 1 || progress !== 0 && frameId === undefined) {
    throw new Error('Provide a keyframe ID to sample progress between 0 and 1.');
  }
  const context = poseContext(project, frameId, progress);
  const metadata = { revision: project.revision, frameId: frameId ?? null, progress, units: 'mm' };
  if (operation === 'find') return { ...metadata, ...findGeometry(project, request, context) };
  if (operation !== 'surface' && operation !== 'paint') throw new Error('Geometry operation must be find, surface, or paint.');
  if (typeof partId !== 'string' || !context.parts.has(partId)) throw new Error('Provide a part ID from this project.');
  if (!isFiniteNumber(angleDegrees) || angleDegrees < 0 || angleDegrees >= 180 || typeof includeMesh !== 'boolean' || space !== 'local' && space !== 'world') {
    throw new Error('Invalid surface angle, coordinate space, or mesh option.');
  }
  const part = context.parts.get(partId)!, triangleCount = part.geometry.triangles;
  const validTriangle = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value < triangleCount;
  if (seed === undefined ? !isVec3(point) : !validTriangle(seed) || point !== undefined) throw new Error('Provide one valid triangle index or a 3D point.');
  if (triangles !== undefined && (!Array.isArray(triangles) || !triangles.length || !triangles.every(validTriangle))) throw new Error('Triangle IDs must be nonempty and in the part mesh.');
  const geometry = await loadGeometry(part, directory);
  const transform = poseMatrix(context.pose(partId));
  const localPoint = isVec3(point) ? new Vector3(...point) : undefined;
  if (localPoint && space === 'world') localPoint.applyMatrix4(transform.clone().invert());
  const hit = localPoint && meshTree(geometry).closestPointToPoint(localPoint);
  const id = validTriangle(seed) ? seed : hit?.faceIndex;
  if (id === undefined) throw new Error('No triangle could be found.');
  const surface = triangles ? [...new Set<number>(triangles)] : connectedFace(geometry, id, angleDegrees);
  if (!surface.includes(id)) throw new Error('The selected surface must contain the seed triangle.');
  const triangle = readTriangle(geometry, id, new Triangle());
  const snap = hit?.point ?? triangle.getMidpoint(new Vector3());
  const barycentric = triangle.getBarycoord(snap, new Vector3());
  if (!barycentric) throw new Error('The seed triangle has no area.');
  const normal = triangle.getNormal(new Vector3()), points = surfaceVertices(geometry, surface);
  const cylinder = fitCylinder(geometry, surface, points);
  const anchor: Anchor = {
    partId, point: snap.toArray(), normal: normal.toArray(), target: 'face', triangle: id, barycentric: barycentric.toArray(),
    region: { kind: 'face', triangles: surface, center: snap.toArray(), normal: normal.toArray(), radius: 0, axis: normal.toArray(), width: 0 },
  };
  if (operation === 'paint') return { ...metadata, ...paintRegion(request, project, context, geometry, anchor, transform, cylinder) };
  return {
    ...metadata, anchor, snapDistance: hit?.distance ?? 0,
    world: { point: snap.clone().applyMatrix4(transform).toArray(), normal: normal.clone().transformDirection(transform).toArray() },
    surface: coverage(geometry, surface, []).summary,
    cylinder: cylinder ? {
      diameter: cylinder.diameter, axialRange: cylinder.extent, maxRadialError: cylinder.maxRadialError,
      local: axisCoordinates(cylinder, new Matrix4()), world: axisCoordinates(cylinder, transform),
    } : null,
    ...(includeMesh && { mesh: { space: 'local', triangles: surface.map(id => {
      const { a, b, c } = readTriangle(geometry, id, triangle);
      return { id, vertices: [a.toArray(), b.toArray(), c.toArray()] };
    }) } }),
  };
}
