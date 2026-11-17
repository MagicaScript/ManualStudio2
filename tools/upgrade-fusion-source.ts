import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { planSync, applySync } from '../server/sync.ts';
import { setFusionOrigin } from '../server/fusion.ts';
import type { Model, Project, Vec3 } from '../shared/types.ts';

const [projectId, mappingFile, action] = process.argv.slice(2);
const base = process.env.MANUALSTUDIO_URL ?? 'http://127.0.0.1:4189';
const root = process.cwd();
const response = await fetch(`${base}/api/projects/${projectId}`); if (!response.ok) throw new Error(await response.text());
const original = await response.json() as Project;
const mapping = JSON.parse(await readFile(mappingFile, 'utf8')) as { modelId: string; offset: Vec3; mapping: Record<string, string> };
const model = JSON.parse(await readFile(path.join(root, 'data/models', mapping.modelId, 'model.json'), 'utf8')) as Model;
setFusionOrigin(model, mapping.offset);
const files = new Map<string, Uint8Array>();
for (const file of new Set([...original.model.parts, ...model.parts].map(part => part.geometry.file))) files.set(file, new Uint8Array(await readFile(path.join(root, 'data', file.slice(1)))));
const reader = (part: Model['parts'][number]): Uint8Array => files.get(part.geometry.file)!;
const plan = planSync(original, model, reader, mapping.mapping);
assert.equal(plan.matches.length, original.model.parts.length); assert.equal(plan.added.length, 0); assert.equal(plan.removed.length, 0); assert.equal(plan.unresolved.length, 0);
const updated = applySync(original, plan, reader);
const structure = (project: Project) => project.steps.map(step => ({ ...step,
  frames: step.frames.map(frame => ({ ...frame, poses: undefined, notes: frame.notes.map(note => ({ ...note, anchors: note.anchors.map(anchor => ({ partId: anchor.partId, target: anchor.target, region: anchor.region && { kind: anchor.region.kind, radius: anchor.region.radius, width: anchor.region.width, axis: anchor.region.axis } })) })) })),
  groups: step.groups.map(group => ({ ...group, poses: undefined })) }));
assert.deepEqual(structure(updated), structure(original));
let maxPoseChange = 0, maxAnchorChange = 0;
for (let i = 0; i < original.steps.length; i++) for (let j = 0; j < original.steps[i].frames.length; j++) for (const [partId, before] of Object.entries(original.steps[i].frames[j].poses)) {
  const after = updated.steps[i].frames[j].poses[partId]; assert.deepEqual(after.quaternion, before.quaternion);
  maxPoseChange = Math.max(maxPoseChange, Math.hypot(...after.position.map((value, axis) => value - before.position[axis])));
}
for (let i = 0; i < original.steps.length; i++) for (let j = 0; j < original.steps[i].frames.length; j++) {
  const before = original.steps[i].frames[j], after = updated.steps[i].frames[j];
  for (let n = 0; n < before.notes.length; n++) for (let a = 0; a < before.notes[n].anchors.length; a++) {
    const oldAnchor = before.notes[n].anchors[a], newAnchor = after.notes[n].anchors[a];
    maxAnchorChange = Math.max(maxAnchorChange, Math.hypot(...newAnchor.point.map((value, axis) => value - oldAnchor.point[axis])));
  }
}
assert.ok(maxPoseChange < .05, `Authored positions changed by ${maxPoseChange} mm.`);
assert.ok(maxAnchorChange < .1, `Surface anchors moved by ${maxAnchorChange} mm.`);
assert.ok(updated.model.constructionAxes?.every(axis => axis.partIds.every(id => updated.model.parts.some(part => part.id === id))));
const report = { source: model.source, matchedParts: plan.matches.length, steps: original.steps.length, axes: model.constructionAxes?.length, maxPoseChangeMillimeters: maxPoseChange, maxAnchorChangeMillimeters: maxAnchorChange, previousRevision: original.revision };
await writeFile(path.join(root, 'artifacts/Pre Native Import.json'), JSON.stringify(original));
await writeFile(path.join(root, 'artifacts/Fusion Source Upgrade Verification.json'), JSON.stringify(report, null, 2));
if (action === '--apply') {
  const saved = await fetch(`${base}/api/projects/${projectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: updated, expectedRevision: original.revision }) });
  if (!saved.ok) throw new Error(await saved.text());
  const project = await saved.json() as Project; console.log(JSON.stringify({ ...report, savedRevision: project.revision }, null, 2));
} else console.log(JSON.stringify(report, null, 2));
