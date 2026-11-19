import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';
import { createServer, type ViteDevServer } from 'vite';
import type { Command, Project } from '../shared/types.ts';
import { transactionModel } from './fixtures/assembly-transaction.ts';

async function painted(page: Page): Promise<void> { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

test('picker Cancel is transactional, OK is one undo, and GUI/CLI Final keeps the complete model and ordinary steps', { timeout: 120000 }, async () => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'Chrome is required for the assembly transaction check.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-transactions-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const imported = await fetch(`${base}/api/import?name=AssemblyTransactions.3mf`, { method: 'POST', body: Buffer.from(transactionModel()) }); assert.equal(imported.status, 200);
    let project = await imported.json() as Project;
    const [shell, support, unused, extra] = project.model.parts;
    const read = async (): Promise<Project> => await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project;
    const edit = async (commands: Command[]): Promise<Project> => {
      const current = await read(), response = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: current.revision, commands }));
      assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { project: Project }).project;
    };
    project = await edit([{ type: 'step.add', name: 'Completed shell', parts: [shell.id] }, { type: 'step.add', name: 'Completed support', parts: [support.id] }, { type: 'step.add', name: 'Current operation', parts: [unused.id] }]);
    const [sourceA, sourceB, target] = project.steps;
    const authoredEnd = { position: [31.123456, 4.654321, 9.567891] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
    project = await edit([{ type: 'frame.update', stepId: sourceB.id, frameId: sourceB.frames[1].id, patch: { poses: { [support.id]: authoredEnd } } }]);
    const initial = structuredClone(project);
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen(); const url = frontend.resolvedUrls?.local[0]; assert.ok(url);
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } }); page.setDefaultTimeout(15000);
    const errors: string[] = []; let requests = 0; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands')) requests++; });
    await page.goto(`${url}?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    const openPicker = async (): Promise<void> => { await page.locator(`[data-step="${target.id}"] .card-actions [data-drop-step]`).click(); await page.locator('.object-picker').waitFor(); };
    const checkPart = async (name: string, id: string, checked: boolean): Promise<void> => {
      if (!(await page.getByLabel('Search add-object list', { exact: true }).isVisible())) await page.locator('#pickerSearchToggle').click();
      await page.getByLabel('Search add-object list', { exact: true }).fill(name); await page.locator(`[data-check-part="${id}"]`).setChecked(checked);
    };
    const searchPart = async (name: string): Promise<void> => { if (!(await page.getByLabel('Search parts', { exact: true }).isVisible())) await page.locator('#searchButton').click(); await page.getByLabel('Search parts', { exact: true }).fill(name); };
    await openPicker(); await checkPart(extra.name, extra.id, true); await page.locator(`[data-use-assembly="${sourceA.id}"]`).click();
    assert.equal(await page.locator(`[data-check-part="${extra.id}"]`).isChecked(), true, 'Choosing an assembly must preserve pending individual checks.');
    await page.locator(`[data-step="${sourceB.id}"] .step-chip-row`).dragTo(page.locator(`[data-step="${target.id}"] .step-chip-row`));
    await checkPart(support.name, support.id, true); await painted(page);
    assert.equal(requests, 0); assert.deepEqual(await read(), initial); assert.equal(await page.locator('#undoButton').isDisabled(), true);
    await page.locator('#cancelPicker').click(); assert.deepEqual(await read(), initial); assert.equal(await page.locator('#undoButton').isDisabled(), true);

    await openPicker(); await checkPart(extra.name, extra.id, true); await page.locator(`[data-use-assembly="${sourceA.id}"]`).click(); await page.locator(`[data-use-assembly="${sourceB.id}"]`).click(); await checkPart(support.name, support.id, false);
    await page.locator('#pickerConfirm').click(); await page.locator('.object-picker').waitFor({ state: 'detached' });
    assert.equal(requests, 1, 'Confirmation must save one batch, with one history entry.');
    project = await read(); const confirmed = structuredClone(project), current = project.steps.find(step => step.id === target.id)!;
    assert.deepEqual(new Set(current.partIds), new Set([unused.id, extra.id, shell.id])); assert.deepEqual(current.groups.map(group => group.sourceStepId), [sourceA.id]);
    await page.locator('#undoButton').click(); await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, confirmed.revision + 1); assert.deepEqual((await read()).steps, initial.steps);
    await page.locator('#redoButton').click(); await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, confirmed.revision + 2); assert.deepEqual((await read()).steps, confirmed.steps);

    const beforeDrops = await read(), dropRequests = requests;
    await openPicker(); await checkPart(extra.name, extra.id, false); await searchPart(extra.name);
    await page.locator(`#partTree [data-part="${extra.id}"]`).dragTo(page.locator(`[data-step="${target.id}"] .step-chip-row`));
    assert.equal(await page.locator(`[data-check-part="${extra.id}"]`).isChecked(), true, 'List drops must join the picker draft.');
    await checkPart(extra.name, extra.id, false); await page.locator(`#partTree [data-part="${extra.id}"]`).click({ button: 'middle' }); await painted(page);
    const point = await page.evaluate(id => {
      const view = window.manualStudio.view, mesh = view.meshes.get(id)!; const positions = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex()!;
      const center = mesh.position.clone().set(0, 0, 0);
      for (let vertex = 0; vertex < 3; vertex++) { const i = index.getX(vertex); center.x += positions.getX(i) / 3; center.y += positions.getY(i) / 3; center.z += positions.getZ(i) / 3; }
      mesh.localToWorld(center); center.project(view.camera); const box = view.renderer.domElement.getBoundingClientRect();
      return { x: box.left + (center.x + 1) * box.width / 2, y: box.top + (1 - center.y) * box.height / 2 };
    }, extra.id);
    const destination = await page.locator(`[data-step="${target.id}"] .step-chip-row`).boundingBox(); assert.ok(destination);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 15, point.y + 12, { steps: 4 });
    await page.locator('.part-drag-ghost:not([hidden])').waitFor();
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(id => document.querySelector<HTMLInputElement>(`[data-check-part="${id}"]`)?.checked, extra.id);
    assert.equal(requests, dropRequests); assert.deepEqual(await read(), beforeDrops);
    await page.locator('#cancelPicker').click(); assert.deepEqual(await read(), beforeDrops);

    await page.locator(`[data-step="${target.id}"]`).click({ button: 'right' }); await page.getByRole('button', { name: 'Create final assembly', exact: true }).click();
    await page.waitForFunction(() => window.manualStudio.getProject()?.steps.some(step => step.final)); project = await read();
    const summary = project.steps.at(-1)!; assert.equal(summary.final, true); assert.notEqual(summary.id, target.id); assert.deepEqual(project.steps.slice(0, -1), beforeDrops.steps); assert.equal(summary.partIds.length, 4);
    const finalCard = page.locator(`[data-step="${summary.id}"]`); assert.equal(await finalCard.locator('[data-reorder],[data-copy],[data-drop-step],[data-assembly]').count(), 0);
    await finalCard.locator('h3').click(); assert.equal(await page.locator('#addFrame').isDisabled(), false);
    await page.locator('[data-overview]').click();
    assert.equal(await page.evaluate(() => [...window.manualStudio.view.meshes.values()].filter(mesh => mesh.visible).length), 4, 'Final must not hide unassigned source bodies in Overall preview.');
    await page.locator('#addStep').click(); await page.locator('.object-picker').waitFor(); await page.locator('#cancelPicker').click(); project = await read();
    assert.equal(project.steps.at(-1)!.id, summary.id); assert.equal(project.steps.length, 5);

    await page.locator(`[data-step="${sourceB.id}"] h3`).click(); await page.locator(`[data-frame="${sourceB.frames[1].id}"]`).click(); await searchPart(support.name); await page.locator(`#partTree [data-part="${support.id}"]`).click();
    await page.locator('#selectedProperties').click(); await page.locator('#partRemovalEdit').check(); await page.locator('.modal-footer').getByRole('button', { name: 'Apply', exact: true }).click(); await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
    await page.locator(`[data-refresh-final="${summary.id}"]`).click();
    await page.waitForFunction(id => window.manualStudio.getProject()?.steps.at(-1)?.frames.at(-1)?.hidden.includes(id), support.id);
    await page.locator('#selectedProperties').click(); await page.locator('#partRemovalEdit').uncheck(); await page.locator('.modal-footer').getByRole('button', { name: 'Apply', exact: true }).click(); await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
    await page.locator(`[data-refresh-final="${summary.id}"]`).click();
    await page.waitForFunction(id => !window.manualStudio.getProject()?.steps.at(-1)?.frames.at(-1)?.hidden.includes(id), support.id);
    project = await read(); assert.deepEqual(project.steps.find(step => step.id === sourceB.id)!.frames[1].poses[support.id], authoredEnd); assert.deepEqual(project.steps.at(-1)!.frames[1].poses[support.id], authoredEnd); assert.equal(project.steps.at(-1)!.frames[1].hidden.includes(support.id), false);

    const cli = spawn(process.execPath, ['--experimental-strip-types', 'tools/manualstudio.ts', 'command', project.id, JSON.stringify({ type: 'step.final', stepId: sourceA.id, value: true })], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_URL: base }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = ''; cli.stdout.on('data', chunk => { output += String(chunk); }); cli.stderr.on('data', chunk => { stderr += String(chunk); }); const [exitCode] = await once(cli, 'close'); assert.equal(exitCode, 0, stderr);
    const cliResult = JSON.parse(output) as { project: Project; results: string[] }; assert.deepEqual(cliResult.results, [summary.id]); assert.equal(cliResult.project.steps.filter(step => step.final).length, 1); assert.deepEqual(cliResult.project.steps.slice(0, -1), project.steps.slice(0, -1));
    const invalid = structuredClone(cliResult.project); invalid.steps[0].final = true;
    const rejected = await fetch(`${base}/api/projects/${project.id}`, { ...post({ project: invalid, expectedRevision: cliResult.project.revision }), method: 'PUT' }); assert.equal(rejected.status, 400); assert.match(await rejected.text(), /Only one dedicated/); assert.deepEqual(await read(), cliResult.project);
    await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, cliResult.project.revision);
    const beforeMerge = await read(), mergeRequestCount = requests;
    await page.locator('#mergeSteps').click(); assert.equal(await page.locator('[data-merge-step]').count(), beforeMerge.steps.length); assert.equal(await page.locator('[data-overview] input').count(), 0); assert.equal(await page.locator('#confirmMerge').isDisabled(), true);
    await page.locator(`[data-merge-step="${sourceB.id}"]`).check(); await page.locator(`[data-merge-step="${sourceA.id}"]`).check();
    assert.equal(await page.locator('#confirmMerge').isDisabled(), false); assert.deepEqual(await read(), beforeMerge); await page.locator('#cancelMerge').click(); assert.equal(requests, mergeRequestCount); assert.deepEqual(await read(), beforeMerge);
    await page.locator('#mergeSteps').click(); await page.locator(`[data-merge-step="${sourceB.id}"]`).check(); await page.locator(`[data-merge-step="${sourceA.id}"]`).check(); await page.locator('#confirmMerge').click();
    await page.waitForFunction(count => window.manualStudio.getProject()?.steps.length === count, beforeMerge.steps.length + 1);
    const afterMerge = await read(), merged = afterMerge.steps[2]; assert.equal(merged.name, 'Merged Step'); assert.equal(merged.frames.length, 2); assert.deepEqual(merged.frames[1].poses[support.id], authoredEnd);
    assert.deepEqual(afterMerge.steps.filter(step => step.id !== merged.id), beforeMerge.steps); assert.deepEqual(afterMerge.settings, beforeMerge.settings); assert.equal(requests, mergeRequestCount + 1);
    await page.locator('#undoButton').click(); await page.waitForFunction(count => window.manualStudio.getProject()?.steps.length === count, beforeMerge.steps.length); assert.deepEqual((await read()).steps, beforeMerge.steps);
    await page.locator('#redoButton').click(); await page.waitForFunction(count => window.manualStudio.getProject()?.steps.length === count, afterMerge.steps.length);
    await page.locator(`[data-step="${merged.id}"] h3`).click(); assert.equal(await page.locator('#showLabels').isChecked(), true);
    await page.locator('#labelPositions').click(); await page.getByLabel('Label 1 X', { exact: true }).fill('47'); await page.locator('.modal-footer').getByRole('button', { name: 'Apply', exact: true }).click(); await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
    let labelsProject = await read(); assert.equal(labelsProject.steps.find(step => step.id === merged.id)!.frames[0].labels!.labelOffsets[shell.id][0], 47); assert.deepEqual(labelsProject.settings, beforeMerge.settings);
    await page.locator('#labelSettings').click(); await page.locator('#labelFont').fill('19'); await page.locator('.modal-footer').getByRole('button', { name: 'Apply', exact: true }).click(); await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.part-label')].every(label => getComputedStyle(label).fontSize === '19px'));
    assert.ok(await page.locator('.part-label').count()); await page.locator('#showLabels').uncheck(); await page.waitForFunction(() => document.querySelectorAll('.part-label').length === 0); await page.locator('#showLabels').check(); await page.waitForFunction(() => document.querySelectorAll('.part-label').length > 0);
    labelsProject = await read(); assert.deepEqual(labelsProject.settings, beforeMerge.settings); assert.deepEqual(labelsProject.steps.filter(step => step.id !== merged.id), beforeMerge.steps);
    await page.locator('#mergeSteps').click(); await page.locator('#mergeAll').check(); assert.equal(await page.locator('[data-merge-step]:checked').count(), labelsProject.steps.length); await page.locator('#mergeAll').uncheck();
    for (const id of [target.id, sourceB.id, sourceA.id]) await page.locator(`[data-merge-step="${id}"]`).check();
    assert.match(await page.locator('#mergeResult').innerText(), /Final assembly/); await page.locator('#confirmMerge').click();
    await page.waitForFunction(id => window.manualStudio.getSession().stepId !== id && window.manualStudio.getProject()?.steps.at(-1)?.final && !document.querySelector('#mergeControls:not([hidden])'), summary.id);
    const finalMerged = await read(); assert.equal(finalMerged.steps.length, labelsProject.steps.length + 1); assert.notEqual(finalMerged.steps.at(-1)!.id, summary.id); assert.deepEqual(finalMerged.steps.slice(0, -1), labelsProject.steps.map(step => step.id === summary.id ? { ...step, final: false } : step));
    assert.notDeepEqual(finalMerged.steps.at(-1)!.frames[0].poses[support.id], finalMerged.steps.at(-1)!.frames[1].poses[support.id]); assert.equal(await page.locator('#addFrame').isDisabled(), false);
    await page.locator('#addFrame').click(); await page.waitForFunction(() => window.manualStudio.getProject()?.steps.at(-1)?.frames.length === 3);
    assert.deepEqual((await read()).steps.slice(0, -1), labelsProject.steps.map(step => step.id === summary.id ? { ...step, final: false } : step));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await frontend?.close(); if (api.exitCode === null) { api.kill(); await once(api, 'close'); }
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-transactions-')); await rm(resolved, { recursive: true, force: true });
  }
});
