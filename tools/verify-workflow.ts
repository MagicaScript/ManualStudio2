import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import type { Command, Project } from '../shared/types.ts';
const base = 'http://127.0.0.1:4189'; const projectId = (await readFile('artifacts/verification-project-id.txt', 'utf8')).trim();
let project = await (await fetch(`${base}/api/projects/${projectId}`)).json() as Project;
const parts = Object.fromEntries(project.model.parts.map(part => [part.name, part.id]));
async function command(commands: Command[]): Promise<(string | undefined)[]> { const response = await fetch(`${base}/api/projects/${projectId}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: project.revision, commands }) }); if (!response.ok) throw new Error(await response.text()); const result = await response.json() as { project: Project; results: (string | undefined)[] }; project = result.project; return result.results; }
const first = project.steps[0]; assert.ok(first, 'UI created a step.'); assert.ok(first.partIds.includes(parts['Carbon rod']), '3D canvas drag added the carbon rod.');
const glue = first.frames[0].notes.find(note => note.kind === 'glue'); assert.equal(glue?.anchors.length, 3, 'Three separate surface bands were created by clicks.'); assert.ok(glue?.anchors.every(anchor => anchor.partId === parts['Carbon rod'] && anchor.region?.kind === 'band')); assert.equal(glue?.text, 'Glue at both ends and the center.');
await command([{ type: 'step.rename', stepId: first.id, name: 'Remove support and apply adhesive' }, { type: 'part.initial', partIds: [parts['Printed bracket'], parts['Printed support']], value: true }, { type: 'part.remove', stepId: first.id, partIds: [parts['Printed support']], value: true }]);
const nextId = (await command([{ type: 'step.copy', stepId: first.id, inherit: true }]))[0]!; const next = project.steps.find(step => step.id === nextId)!;
assert.ok(!next.partIds.includes(parts['Printed support']), 'Removed supports do not enter the next assembly.'); assert.equal(next.groups[0].partIds.length, 2);
await command([{ type: 'step.rename', stepId: nextId, name: 'Install the retainer' }, { type: 'step.members', stepId: nextId, partIds: [...next.partIds, parts.Retainer] }, { type: 'step.final', stepId: nextId, value: true }]);
for (const step of project.steps) await command(step.frames.map(frame => ({ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { duration: .6 } })));
const report = { projectId, firstStep: first.id, nextStep: nextId, uiDrag: 'passed', surfaceBands: 3, removedSupportExcluded: true, groupMembers: 2, frames: project.steps.reduce((sum, step) => sum + step.frames.length, 0) };
await writeFile('artifacts/workflow-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
