import { BoxGeometry, CylinderGeometry, Matrix4, Vector3, type BufferGeometry } from 'three';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Project } from '../shared/types.ts';

const definitions: { name: string; geometry: BufferGeometry; position: Vector3; color: string }[] = [
  { name: 'Printed bracket', geometry: new BoxGeometry(42, 20, 6), position: new Vector3(0, 0, 0), color: '#D0D0CE' },
  { name: 'Printed support', geometry: new BoxGeometry(26, 14, 8), position: new Vector3(0, 0, -7), color: '#DA9A61' },
  { name: 'Carbon rod', geometry: new CylinderGeometry(2.5, 2.5, 96, 48).applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 2)), position: new Vector3(0, 0, 6), color: '#383A3B' },
  { name: 'Retainer', geometry: new BoxGeometry(12, 20, 5), position: new Vector3(0, 0, 11), color: '#E0E0DC' },
];
const objects = definitions.map((definition, i) => {
  const positions = definition.geometry.getAttribute('position'); const index = definition.geometry.getIndex(); const count = index?.count ?? positions.count;
  const vertices = Array.from({ length: positions.count }, (_, v) => `<vertex x="${positions.getX(v)}" y="${positions.getY(v)}" z="${positions.getZ(v)}"/>`).join('');
  const triangles = Array.from({ length: count / 3 }, (_, t) => `<triangle v1="${index?.getX(t * 3) ?? t * 3}" v2="${index?.getX(t * 3 + 1) ?? t * 3 + 1}" v3="${index?.getX(t * 3 + 2) ?? t * 3 + 2}"/>`).join('');
  return `<object id="${i + 1}" name="${definition.name}" pid="10" pindex="${i}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`;
}).join('');
const model = `<model unit="millimeter"><metadata name="Title">Assembly Verification</metadata><resources><basematerials id="10">${definitions.map(d => `<base name="${d.name}" displaycolor="${d.color}"/>`).join('')}</basematerials>${objects}</resources><build>${definitions.map((d, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${d.position.x} ${d.position.y} ${d.position.z}"/>`).join('')}</build></model>`;
const archive = zipSync({ '3D/3dmodel.model': strToU8(model) });
await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/Assembly Verification.3mf', archive);
const response = await fetch('http://127.0.0.1:4189/api/import?name=Assembly%20Verification.3mf', { method: 'POST', body: archive });
if (!response.ok) throw new Error(await response.text()); const project = await response.json() as Project;
await writeFile('artifacts/verification-project-id.txt', project.id);
console.log(JSON.stringify({ id: project.id, parts: project.model.parts.map(part => ({ id: part.id, name: part.name })) }));
