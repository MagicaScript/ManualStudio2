import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Project, SyncPlan } from '../shared/types.ts';

test('HTTP API imports, edits with revision protection, syncs and reopens portable projects', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-api-'));
  const processHandle = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise<string>((resolve, reject) => { processHandle.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); processHandle.once('error', reject); processHandle.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const emptyWorkspace = await fetch(`${base}/api/projects`);
    assert.equal(emptyWorkspace.status, 200);
    assert.deepEqual(await emptyWorkspace.json(), []);
    const xml = `<model unit="millimeter"><resources><object id="1" name="Bracket"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const bytes = zipSync({ '3D/3dmodel.model': strToU8(xml) });
    const imported = await fetch(`${base}/api/import?name=Bracket.3mf`, { method: 'POST', body: bytes }); assert.equal(imported.status, 200); let project = await imported.json() as Project; assert.equal(project.steps.length, 0); assert.equal(project.model.parts.length, 1);
    const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const commands = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'step.add', name: 'Install bracket', parts: [project.model.parts[0].id] }] })); assert.equal(commands.status, 200); project = (await commands.json() as { project: Project }).project; assert.equal(project.steps[0].frames.length, 2);
    const conflict = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: 0, commands: [{ type: 'step.add' }] })); assert.equal(conflict.status, 409);
    const planResponse = await fetch(`${base}/api/projects/${project.id}/sync?name=Bracket-v2.3mf`, { method: 'POST', body: bytes }); const plan = await planResponse.json() as SyncPlan; assert.equal(plan.matches.length, 1);
    const synced = await fetch(`${base}/api/sync/${plan.id}/apply`, post({})); assert.equal(synced.status, 200); const updated = await synced.json() as Project; assert.deepEqual(updated.steps, project.steps);
    const archiveResponse = await fetch(`${base}/api/projects/${project.id}/archive`); assert.equal(archiveResponse.status, 200); const archive = await archiveResponse.arrayBuffer(); assert.ok(archive.byteLength > 400);
    const reopened = await fetch(`${base}/api/open-archive`, { method: 'POST', body: archive }); assert.equal(reopened.status, 200); const restored = await reopened.json() as Project; assert.notEqual(restored.id, project.id); assert.deepEqual(restored.steps, project.steps);
    const renderJob = await fetch(`${base}/api/render`, post({ projectId: project.id, kind: 'png', renderer: 'external' })); const job = await renderJob.json() as { id: string }; const completion = await fetch(`${base}/api/render/${job.id}`, post({ filename: 'test.txt', data: Buffer.from('render test').toString('base64') })); const result = await completion.json() as { result: { url: string } }; assert.equal(await (await fetch(base + result.result.url)).text(), 'render test');
  } finally {
    processHandle.kill(); await new Promise<void>(resolve => processHandle.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); assert.ok(path.basename(resolved).startsWith('manualstudio-api-')); await rm(resolved, { recursive: true, force: true });
  }
});
