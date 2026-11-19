import { BufferAttribute, BufferGeometry, Triangle, Vector3 } from 'three';
import { connectedFace } from '../shared/surfaces.ts';
import { copy, refreshFinalAssembly, uid } from '../shared/document.ts';
import type { Anchor, Model, Part, Project, SyncMatch, SyncPlan } from '../shared/types.ts';
import { geometryArrays } from './import-3mf.ts';

type GeometryReader = (part: Part) => Uint8Array;
interface CanonicalTriangles { values: Float32Array; order: Uint32Array; vertexWidth: number }
interface ComparisonGeometry { positions: Float32Array; indices: Uint32Array; normals?: Float32Array; canonical?: CanonicalTriangles }
type GeometryComparisonCache = Map<string, ComparisonGeometry>;
function comparisonGeometry(part: Part, read: GeometryReader, cache: GeometryComparisonCache): ComparisonGeometry {
  const ref = part.geometry, key = `${ref.file}:${ref.offset}:${ref.vertices}:${ref.triangles}:${ref.normalsOffset ?? ''}`;
  const cached = cache.get(key); if (cached) return cached;
  const bytes = read(part), arrays: ComparisonGeometry = geometryArrays(part, bytes);
  if (ref.normalsOffset !== undefined) arrays.normals = new Float32Array(bytes.buffer, bytes.byteOffset + ref.normalsOffset, ref.vertices * 3);
  cache.set(key, arrays); return arrays;
}
function canonicalTriangles(geometry: ComparisonGeometry): CanonicalTriangles {
  if (geometry.canonical) return geometry.canonical;
  const { positions, indices, normals } = geometry, vertexWidth = normals ? 6 : 3, stride = vertexWidth * 3;
  const count = indices.length / 3, values = new Float32Array(count * stride);
  const feature = (vertex: number, component: number): number => component < 3 ? positions[vertex * 3 + component] : normals![vertex * 3 + component - 3];
  const rotationOrder = (triangle: number, a: number, b: number): number => {
    for (let corner = 0; corner < 3; corner++) for (let component = 0; component < vertexWidth; component++) {
      const difference = feature(indices[triangle * 3 + (a + corner) % 3], component) - feature(indices[triangle * 3 + (b + corner) % 3], component);
      if (difference) return difference;
    }
    return 0;
  };
  for (let triangle = 0; triangle < count; triangle++) {
    // Cyclic rotations preserve winding; reversing a triangle must remain a real change.
    let first = 0; for (let candidate = 1; candidate < 3; candidate++) if (rotationOrder(triangle, candidate, first) < 0) first = candidate;
    for (let corner = 0; corner < 3; corner++) for (let component = 0; component < vertexWidth; component++) values[triangle * stride + corner * vertexWidth + component] = feature(indices[triangle * 3 + (first + corner) % 3], component);
  }
  const order = Uint32Array.from({ length: count }, (_, index) => index);
  order.sort((a, b) => { for (let component = 0; component < stride; component++) { const difference = values[a * stride + component] - values[b * stride + component]; if (difference) return difference; } return 0; });
  geometry.canonical = { values, order, vertexWidth }; return geometry.canonical;
}
export function identicalGeometry(a: Part, b: Part, read: GeometryReader, cache: GeometryComparisonCache = new Map()): boolean {
  if (a.geometry.vertices !== b.geometry.vertices || a.geometry.triangles !== b.geometry.triangles) return false;
  if (a.geometry.file === b.geometry.file && a.geometry.offset === b.geometry.offset && a.geometry.normalsOffset === b.geometry.normalsOffset) return true;
  const old = comparisonGeometry(a, read, cache), next = comparisonGeometry(b, read, cache);
  if (!!old.normals !== !!next.normals) return false;
  const aligned = old.indices.every((value, index) => value === next.indices[index])
    && old.positions.every((value, index) => Math.abs(value - next.positions[index]) <= .001)
    && (!old.normals || old.normals.every((value, index) => Math.abs(value - next.normals![index]) <= 1e-6));
  if (aligned) return true;
  const first = canonicalTriangles(old), second = canonicalTriangles(next), stride = first.vertexWidth * 3;
  for (let row = 0; row < first.order.length; row++) for (let component = 0; component < stride; component++) {
    const tolerance = component % first.vertexWidth < 3 ? .001 : 1e-6;
    if (Math.abs(first.values[first.order[row] * stride + component] - second.values[second.order[row] * stride + component]) > tolerance) return false;
  }
  return true;
}
function nativeVersionChanged(previous: Model, incoming: Model): boolean {
  const before = previous.source, after = incoming.source;
  if (!before?.fileId || !after || before.fileId !== after.fileId) return false;
  if (before.versionId && after.versionId) return before.versionId !== after.versionId;
  return before.version !== undefined && after.version !== undefined && before.version !== after.version;
}
export function planSync(project: Project, incoming: Model, read: GeometryReader, manual: Record<string, string> = {}): SyncPlan {
  const matches: SyncMatch[] = []; const usedOld = new Set<string>(); const usedNew = new Set<string>();
  const geometryCache: GeometryComparisonCache = new Map();
  const oldParts = project.model.parts; const fresh = incoming.parts;
  function bind(old: Part, next: Part, reason: SyncMatch['reason']): void {
    if (usedOld.has(old.id) || usedNew.has(next.id)) throw new Error('Each source part can be matched only once.');
    matches.push({ oldId: old.id, newId: next.id, reason, geometryChanged: !identicalGeometry(old, next, read, geometryCache) }); usedOld.add(old.id); usedNew.add(next.id);
  }
  for (const [newId, oldId] of Object.entries(manual)) {
    if (oldId === 'new') continue;
    const old = oldParts.find(p => p.id === oldId); const next = fresh.find(p => p.id === newId);
    if (!old || !next) throw new Error('Manual sync mapping references an unknown part.'); bind(old, next, 'manual');
  }
  const passes: { reason: SyncMatch['reason']; key: (p: Part) => string }[] = [
    { reason: 'source-key', key: p => p.sourceKey ?? '' }, { reason: 'path', key: p => p.path }, { reason: 'name', key: p => p.sourceName },
  ];
  for (const pass of passes) for (const next of fresh) {
    if (usedNew.has(next.id) || manual[next.id] === 'new') continue;
    const key = pass.key(next); if (!key) continue;
    const olds = oldParts.filter(p => !usedOld.has(p.id) && pass.key(p) === key);
    const news = fresh.filter(p => !usedNew.has(p.id) && pass.key(p) === key);
    if (olds.length === 1 && news.length === 1) bind(olds[0], next, pass.reason);
  }
  const unresolved: SyncPlan['unresolved'] = [];
  for (const next of fresh) {
    if (usedNew.has(next.id) || manual[next.id] === 'new') continue;
    const candidates = oldParts.filter(old => !usedOld.has(old.id) && identicalGeometry(old, next, read, geometryCache));
    if (candidates.length === 1) {
      const old = candidates[0]; const competing = fresh.filter(p => !usedNew.has(p.id) && manual[p.id] !== 'new' && identicalGeometry(old, p, read, geometryCache));
      if (competing.length === 1) { bind(old, next, 'geometry'); continue; }
    }
    if (candidates.length) unresolved.push({ newId: next.id, candidates: candidates.map(p => p.id) });
  }
  const replacesBaseline = nativeVersionChanged(project.model, incoming);
  const removed = oldParts.filter(p => (replacesBaseline || p.sourceStatus === 'active') && !usedOld.has(p.id)).map(p => p.id);
  const removedIds = new Set(removed);
  const removedFromSteps = replacesBaseline ? project.steps.flatMap(step => {
    const partIds = step.partIds.filter(id => removedIds.has(id)); if (!partIds.length) return [];
    const noteIds = [...new Set(step.frames.flatMap(frame => frame.notes.filter(note => note.anchors.some(anchor => removedIds.has(anchor.partId))).map(note => note.id)))];
    return [{ stepId: step.id, partIds, noteIds }];
  }) : [];
  return { id: uid('sync'), baseRevision: project.revision, model: incoming, matches,
    added: fresh.filter(p => !usedNew.has(p.id)).map(p => p.id), removed, unresolved,
    ...(incoming.source ? { replacesBaseline, removedFromSteps } : {}) };
}
function rebindAnchor(anchor: Anchor, part: Part, read: GeometryReader, mesh: BufferGeometry): void {
  const geometry = geometryArrays(part, read(part)); const p = new Vector3(...anchor.point); const triangle = new Triangle(); const closest = new Vector3();
  let distance = Infinity; let index = 0; const normal = new Vector3(); const point = new Vector3();
  for (let i = 0; i < geometry.indices.length; i += 3) {
    triangle.a.fromArray(geometry.positions, geometry.indices[i] * 3); triangle.b.fromArray(geometry.positions, geometry.indices[i + 1] * 3); triangle.c.fromArray(geometry.positions, geometry.indices[i + 2] * 3);
    triangle.closestPointToPoint(p, closest); const candidate = closest.distanceToSquared(p);
    if (candidate < distance) { distance = candidate; index = i / 3; point.copy(closest); triangle.getNormal(normal); }
  }
  anchor.point = point.toArray(); anchor.normal = normal.toArray(); anchor.triangle = index;
  anchor.needsReview = distance > 1 || Boolean(anchor.region);
  if (anchor.region) { anchor.region.center = point.toArray(); anchor.region.normal = normal.toArray(); anchor.region.triangles = connectedFace(mesh, index); }
}
function pruneMissingParts(project: Project, previous: Model): void {
  const active = new Set(project.model.parts.map(part => part.id));
  const removed = new Set(previous.parts.filter(part => !active.has(part.id)).map(part => part.id));
  const emptyGroups = new Set<string>();
  for (const step of project.steps) {
    step.partIds = step.partIds.filter(id => !removed.has(id));
    step.removePartIds = step.removePartIds.filter(id => !removed.has(id));
    if (step.removalRestore) { for (const id of removed) delete step.removalRestore[id]; if (!Object.keys(step.removalRestore).length) delete step.removalRestore; }
    for (const group of step.groups) {
      group.partIds = group.partIds.filter(id => !removed.has(id));
      for (const id of removed) delete group.poses[id];
      if (!group.partIds.length) emptyGroups.add(group.id);
    }
    step.groups = step.groups.filter(group => group.partIds.length);
    for (const frame of step.frames) {
      for (const id of removed) delete frame.poses[id];
      frame.hidden = frame.hidden.filter(id => !removed.has(id));
      if (frame.xrayPartIds) frame.xrayPartIds = frame.xrayPartIds.filter(id => !removed.has(id));
      if (frame.labels) { frame.labels.hiddenLabels = frame.labels.hiddenLabels.filter(id => !removed.has(id)); for (const id of removed) delete frame.labels.labelOffsets[id]; }
      frame.notes = frame.notes.filter(note => !note.anchors.some(anchor => removed.has(anchor.partId)));
    }
  }
  const settings = project.settings;
  settings.labelOffsets = Object.fromEntries(Object.entries(settings.labelOffsets).filter(([id]) => !removed.has(id) && !emptyGroups.has(id)));
  settings.hiddenLabels = settings.hiddenLabels.filter(id => !removed.has(id) && !emptyGroups.has(id));
  // A new saved version starts from Fusion's visibility defaults, not the previous local eye overrides.
  settings.partVisibility = {};
  settings.objectVisibility = {};
  settings.constructionAxisVisibility = {};
  settings.showConstructionAxes = true;
}
function retainMissingReferences(model: Model, previous: Model): void {
  const axes = new Set(model.constructionAxes?.map(axis => axis.id));
  const oldAxes = previous.constructionAxes?.filter(axis => !axes.has(axis.id)) ?? [];
  if (oldAxes.length) model.constructionAxes = [...(model.constructionAxes ?? []), ...copy(oldAxes)];
  if (!model.browserTree || !previous.browserTree) return;
  const nodes = new Map<string, NonNullable<Model['browserTree']>[number]>();
  const representedParts = new Set<string>(), representedAxes = new Set<string>();
  const collect = (children: NonNullable<Model['browserTree']>): void => { for (const node of children) { nodes.set(node.id, node); if (node.partId) representedParts.add(node.partId); if (node.axisId) representedAxes.add(node.axisId); if (node.children) collect(node.children); } };
  collect(model.browserTree);
  const merge = (children: NonNullable<Model['browserTree']>, target: NonNullable<Model['browserTree']>): void => {
    for (const node of children) {
      if (node.partId && representedParts.has(node.partId) || node.axisId && representedAxes.has(node.axisId)) continue;
      const existing = nodes.get(node.id);
      if (existing) { if (node.children) merge(node.children, existing.children ??= []); continue; }
      const restored = copy(node);
      if (node.children) { restored.children = []; merge(node.children, restored.children); if (!restored.children.length) continue; }
      target.push(restored); nodes.set(restored.id, restored); if (restored.partId) representedParts.add(restored.partId); if (restored.axisId) representedAxes.add(restored.axisId);
    }
  };
  merge(previous.browserTree, model.browserTree);
}

function retainAuthoredReferenceNames(model: Model, previous: Model): void {
  const source = previous.source, incoming = model.source;
  if (!source?.fileId || source.fileId !== incoming?.fileId) return;
  const sameVersion = source.versionId && incoming.versionId
    ? source.versionId === incoming.versionId
    : source.version !== undefined && source.version === incoming.version;
  if (!sameVersion) return;

  const axisNames = new Map<string, string>();
  for (const axis of model.constructionAxes ?? []) {
    const prior = previous.constructionAxes?.find(candidate => candidate.id === axis.id);
    if (prior?.sourceName === undefined || prior.name === prior.sourceName) continue;
    axis.sourceName = axis.name;
    axis.name = prior.name;
    axisNames.set(axis.id, axis.name);
  }

  const objectNames = new Map<string, string>();
  const collect = (nodes: NonNullable<Model['browserTree']>): void => {
    for (const node of nodes) {
      if (node.kind === 'object' && node.sourceName !== undefined && node.name !== node.sourceName) objectNames.set(node.id, node.name);
      if (node.children) collect(node.children);
    }
  };
  const apply = (nodes: NonNullable<Model['browserTree']>): void => {
    for (const node of nodes) {
      const name = node.kind === 'object' ? objectNames.get(node.id) : node.axisId ? axisNames.get(node.axisId) : undefined;
      if (name !== undefined && name !== node.name) {
        if (node.kind === 'object') node.sourceName = node.name;
        node.name = name;
      }
      if (node.children) apply(node.children);
    }
  };
  collect(previous.browserTree ?? []);
  apply(model.browserTree ?? []);
}

export function applySync(project: Project, plan: SyncPlan, read: GeometryReader): Project {
  if (plan.baseRevision !== project.revision) throw new Error('The project changed after this sync preview. Review it again.');
  if (plan.unresolved.length) throw new Error('Resolve ambiguous part matches before applying the update.');
  const next = copy(project); const mapping = new Map(plan.matches.map(match => [match.newId, match]));
  const oldParts = new Map(project.model.parts.map(part => [part.id, part]));
  const updated = plan.model.parts.map(incoming => {
    const match = mapping.get(incoming.id); if (!match) return copy(incoming);
    const previous = oldParts.get(match.oldId)!; const part = { ...copy(incoming), id: previous.id, name: previous.name === previous.sourceName ? incoming.name : previous.name, initiallyAssembled: previous.initiallyAssembled };
    // An equivalent retessellation can reorder triangles. Retain the existing numbering
    // so surface annotations and painted-region memberships keep their exact bindings.
    if (match.geometryChanged === false) part.geometry = copy(previous.geometry);
    const delta = new Vector3(...part.home.position).sub(new Vector3(...previous.home.position));
    if (!part.explosionOffset && previous.explosionOffset) part.explosionOffset = new Vector3(...previous.explosionOffset).add(delta).toArray();
    if (previous.assemblyHome) part.assemblyHome = { position: new Vector3(...previous.assemblyHome.position).add(delta).toArray(), quaternion: [...previous.assemblyHome.quaternion] };
    let mesh: BufferGeometry | undefined;
    if (match.geometryChanged) { const arrays = geometryArrays(part, read(part)); mesh = new BufferGeometry(); mesh.setAttribute('position', new BufferAttribute(arrays.positions, 3)); mesh.setIndex(new BufferAttribute(arrays.indices, 1)); }
    for (const step of next.steps) {
      for (const frame of step.frames) {
        const pose = frame.poses[part.id]; if (pose) pose.position = new Vector3(...pose.position).add(delta).toArray();
        if (mesh) frame.notes.forEach(note => note.anchors.filter(anchor => anchor.partId === part.id).forEach(anchor => rebindAnchor(anchor, part, read, mesh!)));
      }
      step.groups.forEach(group => { const pose = group.poses[part.id]; if (pose) pose.position = new Vector3(...pose.position).add(delta).toArray(); });
      const removal = step.removalRestore?.[part.id]; if (removal) for (const pose of [removal.start, removal.end]) pose.position = new Vector3(...pose.position).add(delta).toArray();
    }
    mesh?.dispose();
    return part;
  });
  const replacesBaseline = nativeVersionChanged(project.model, plan.model);
  const sameNativeVersion = !!project.model.source && !!plan.model.source && !replacesBaseline;
  const retained = replacesBaseline ? [] : project.model.parts.filter(part => !plan.matches.some(match => match.oldId === part.id)).map(part => sameNativeVersion ? copy(part) : { ...copy(part), sourceStatus: 'removed' as const });
  next.model = { ...copy(plan.model), revision: project.model.revision + 1, parts: [...updated, ...retained] };
  next.model.constructionAxes?.forEach(axis => { axis.partIds = axis.partIds.map(partId => mapping.get(partId)?.oldId ?? partId); });
  const remapTree = (nodes: NonNullable<Model['browserTree']>): void => {
    for (const node of nodes) { if (node.partId) { const previousId = node.partId; node.partId = mapping.get(previousId)?.oldId ?? previousId; if (node.id === `part:${previousId}`) node.id = `part:${node.partId}`; } if (node.children) remapTree(node.children); }
  };
  if (next.model.browserTree) remapTree(next.model.browserTree);
  retainAuthoredReferenceNames(next.model, project.model);
  if (sameNativeVersion) retainMissingReferences(next.model, project.model);
  if (replacesBaseline) pruneMissingParts(next, project.model);
  refreshFinalAssembly(next);
  return next;
}
