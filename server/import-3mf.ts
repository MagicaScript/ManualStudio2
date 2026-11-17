import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { Matrix3, Matrix4, Vector3, Box3 } from 'three';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { uid } from '../shared/document.ts';
import type { Model, Part, Vec3 } from '../shared/types.ts';

type Xml = Record<string, unknown>;
function record(value: unknown): Xml { return value && typeof value === 'object' && !Array.isArray(value) ? value as Xml : {}; }
function list(value: unknown): Xml[] { return (Array.isArray(value) ? value : value ? [value] : []).map(record); }
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
function field(node: Xml, key: string): string { return text(node[`@_${key}`]); }
function number(node: Xml, key: string, fallback = 0): number { const value = field(node, key); return value ? Number(value) : fallback; }
function metadata(node: Xml): Record<string, string> { return Object.fromEntries(list(node.metadata).map(m => [field(m, 'key') || field(m, 'name'), field(m, 'value') || text(m['#text'])])); }
export function matrix3mf(value: string): Matrix4 {
  if (!value) return new Matrix4();
  const v = value.trim().split(/\s+/).map(Number); if (v.length !== 12 || !v.every(Number.isFinite)) throw new Error('Invalid 3MF transformation.');
  return new Matrix4().set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
}
const unitScale: Record<string, number> = { micron: .001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
export interface ImportedModel { model: Model; binary: Uint8Array }

/** Restore Bambu assembly transforms; ordinary Fusion 3MF uses its nested build transforms. */
export function parse3mf(bytes: Uint8Array, filename: string, modelId = uid('model')): ImportedModel {
  const archive = unzipSync(bytes); const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, removeNSPrefix: true });
  const parse = (name: string): Xml => { const entry = archive[name]; if (!entry) throw new Error(`Missing 3MF entry: ${name}`); return record(parser.parse(strFromU8(entry)) as unknown); };
  let rootFile = '3D/3dmodel.model';
  if (archive['_rels/.rels']) {
    const rels = list(record(parse('_rels/.rels').Relationships).Relationship);
    const rel = rels.find(r => field(r, 'Type').endsWith('/3dmodel')); if (rel) rootFile = field(rel, 'Target').replace(/^\//, '');
  }
  const documents = new Map<string, Xml>();
  const getDocument = (name: string): Xml => { let doc = documents.get(name); if (!doc) { doc = record(parse(name).model); documents.set(name, doc); } return doc; };
  const root = getDocument(rootFile); const meta = metadata(root);
  const config = archive['Metadata/model_settings.config'] ? record(parse('Metadata/model_settings.config').config) : {};
  const objectSettings = new Map(list(config.object).map(obj => [field(obj, 'id'), obj]));
  const assembly = list(record(config.assemble).assemble_item);
  let colors: string[] = [];
  if (archive['Metadata/project_settings.config']) {
    const settings = record(JSON.parse(strFromU8(archive['Metadata/project_settings.config'])) as unknown);
    if (Array.isArray(settings.filament_colour)) colors = settings.filament_colour.filter((c): c is string => typeof c === 'string');
  }
  const parts: Part[] = []; const buffers: Uint8Array[] = []; let byteOffset = 0;
  const model: Model = { id: modelId, name: meta.Title || path.basename(filename, path.extname(filename)), sourceFile: filename, revision: 1, importedAt: new Date().toISOString(), parts, materials: colors };
  const sourceKeyCounts = new Map<string, number>();
  function traverse(file: string, objectId: string, transform: Matrix4, rootId: string, branch: string[], buildIndex: number, stack: string[], volumeIndex = 0, explosionLocal?: Vector3): void {
    const key = `${file}:${objectId}`; if (stack.includes(key)) throw new Error('Cyclic 3MF component graph.');
    const doc = getDocument(file); const resources = record(doc.resources); const obj = list(resources.object).find(o => field(o, 'id') === objectId);
    if (!obj) throw new Error(`Missing 3MF object ${key}.`);
    const configObject = objectSettings.get(rootId) ?? {}; const configMeta = metadata(configObject);
    const configPart = list(configObject.part).find(p => field(p, 'id') === objectId) ?? {}; const partMeta = metadata(configPart);
    const name = partMeta.name || field(obj, 'name') || configMeta.name || `Part ${objectId}`;
    const objectName = configMeta.name || branch[0] || field(obj, 'name') || model.name;
    const components = list(record(obj.components).component);
    if (components.length) {
      components.forEach((component, i) => {
        const target = field(component, 'path'); const childFile = target ? target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), target)) : file;
        const parentUnit = unitScale[field(doc, 'unit') || 'millimeter']; const childUnit = unitScale[field(getDocument(childFile), 'unit') || 'millimeter'];
        if (!parentUnit || !childUnit) throw new Error('Unsupported 3MF unit.');
        let local = matrix3mf(field(component, 'transform')).multiply(new Matrix4().makeScale(childUnit / parentUnit, childUnit / parentUnit, childUnit / parentUnit));
        const assemblyVolume = assembly.find(item => field(item, 'object_id') === rootId && field(item, 'volume_id') === String(i));
        if (assemblyVolume && stack.length === 0) local = matrix3mf(field(assemblyVolume, 'transform'));
        const instance = assembly.find(item => field(item, 'object_id') === rootId && field(item, 'instance_id') === '0');
        const values = field(instance ?? {}, 'offset').trim().split(/\s+/).map(Number);
        const offset = assemblyVolume ? new Vector3().setFromMatrixPosition(local).add(values.length === 3 ? new Vector3(values[0], values[1], values[2]) : new Vector3()) : explosionLocal;
        traverse(childFile, field(component, 'objectid'), transform.clone().multiply(local), rootId, [...branch, name], buildIndex, [...stack, key], i, offset);
      }); return;
    }
    const mesh = record(obj.mesh); const vertices = list(record(mesh.vertices).vertex); const triangles = list(record(mesh.triangles).triangle);
    if (!vertices.length || !triangles.length) return;
    const positions = new Float32Array(vertices.length * 3); const bounds = new Box3(); const point = new Vector3();
    vertices.forEach((vertex, i) => { point.set(number(vertex, 'x'), number(vertex, 'y'), number(vertex, 'z')).applyMatrix4(transform); bounds.expandByPoint(point); positions.set(point.toArray(), i * 3); });
    const center = bounds.getCenter(new Vector3()); for (let i = 0; i < positions.length; i += 3) { positions[i] -= center.x; positions[i + 1] -= center.y; positions[i + 2] -= center.z; }
    const indices = new Uint32Array(triangles.length * 3);
    triangles.forEach((triangle, i) => { const ids = [number(triangle, 'v1'), number(triangle, 'v2'), number(triangle, 'v3')]; if (ids.some(id => id < 0 || id >= vertices.length)) throw new Error('3MF triangle references an invalid vertex.'); if (transform.determinant() < 0) [ids[1], ids[2]] = [ids[2], ids[1]]; indices.set(ids, i * 3); });
    const materialIndex = Math.max(0, Number(partMeta.extruder || configMeta.extruder || 1) - 1); let color = colors[materialIndex] || '#d6d6d2';
    const pid = field(obj, 'pid'); const pindex = number(obj, 'pindex');
    const material = list(resources.basematerials).find(m => field(m, 'id') === pid);
    const base = list(material?.base)[pindex]; if (base && field(base, 'displaycolor')) color = field(base, 'displaycolor').slice(0, 7);
    if (!colors.includes(color)) colors.push(color);
    const persistent = field(configPart, 'uuid') || field(obj, 'UUID');
    const repeated = persistent ? sourceKeyCounts.get(persistent) ?? 0 : 0; if (persistent) sourceKeyCounts.set(persistent, repeated + 1);
    parts.push({ id: uid('part'), name, sourceName: name, objectName, objectId: `${rootId}:build-${buildIndex}`, path: [...branch.filter(Boolean), name].join('/'), sourceObject: `${file}:${objectId}:build-${buildIndex}:volume-${volumeIndex}`,
      ...(persistent ? { sourceKey: repeated ? `${persistent}:instance-${repeated}` : persistent } : {}),
      ...(explosionLocal ? { explosionOffset: explosionLocal.clone().applyMatrix3(new Matrix3().setFromMatrix4(transform)).toArray() } : {}),
      geometry: { file: `/models/${modelId}/geometry.bin`, offset: byteOffset, vertices: vertices.length, triangles: triangles.length },
      home: { position: center.toArray(), quaternion: [0, 0, 0, 1] }, bounds: [bounds.min.toArray(), bounds.max.toArray()], color, material: colors.indexOf(color), sourceStatus: 'active', initiallyAssembled: false });
    const p = new Uint8Array(positions.buffer); const ix = new Uint8Array(indices.buffer); buffers.push(p, ix); byteOffset += p.byteLength + ix.byteLength;
  }
  const unit = unitScale[field(root, 'unit') || 'millimeter']; if (!unit) throw new Error('Unsupported 3MF unit.');
  list(record(root.build).item).forEach((item, buildIndex) => {
    const rootId = field(item, 'objectid');
    const assembled = assembly.find(a => field(a, 'object_id') === rootId && field(a, 'instance_id') === '0');
    const matrix = new Matrix4().makeScale(unit, unit, unit).multiply(matrix3mf(field(assembled ?? item, 'transform')));
    traverse(rootFile, rootId, matrix, rootId, [], buildIndex, []);
  });
  if (!parts.length) throw new Error('The 3MF contains no mesh parts.');
  const center = new Box3(); parts.forEach(part => { center.expandByPoint(new Vector3(...part.bounds[0])); center.expandByPoint(new Vector3(...part.bounds[1])); });
  const assemblyCenter = center.getCenter(new Vector3()); parts.forEach(part => { part.explosionOffset ??= new Vector3(...part.home.position).sub(assemblyCenter).toArray(); });
  const binary = new Uint8Array(byteOffset); let cursor = 0; buffers.forEach(buffer => { binary.set(buffer, cursor); cursor += buffer.length; });
  return { model, binary };
}
export async function persistModel(imported: ImportedModel, directory: string): Promise<void> {
  const folder = path.join(directory, imported.model.id); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'geometry.bin'), imported.binary); await writeFile(path.join(folder, 'model.json'), JSON.stringify(imported.model));
}
export function geometryArrays(part: Part, bytes: Uint8Array): { positions: Float32Array; indices: Uint32Array } {
  const start = bytes.byteOffset + part.geometry.offset;
  return { positions: new Float32Array(bytes.buffer, start, part.geometry.vertices * 3), indices: new Uint32Array(bytes.buffer, start + part.geometry.vertices * 12, part.geometry.triangles * 3) };
}
export function localBounds(part: Part): [Vec3, Vec3] {
  return [part.bounds[0].map((v, i) => v - part.home.position[i]) as Vec3, part.bounds[1].map((v, i) => v - part.home.position[i]) as Vec3];
}
