import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';
import { createServer, type ViteDevServer } from 'vite';
import { zipSync, strToU8 } from 'fflate';
import type { Camera, Project } from '../shared/types.ts';

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
function sameCamera(actual: Camera, expected: Camera): void {
  for (const key of ['eye', 'target', 'up'] as const) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[key][axis] - expected[key][axis]) < 1e-8, `Renaming must not focus the camera: ${key}[${axis}]`);
}

test('list and canvas names edit the same document, middle-click focuses, and right-click copies the full name', { timeout: 60000 }, async context => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'Name interactions require installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-name-interactions-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const xml = '<model unit="millimeter"><resources><object id="1" name="Bracket"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
    const imported = await fetch(`${base}/api/import?name=Names.3mf`, { method: 'POST', body: zipSync({ '3D/3dmodel.model': strToU8(xml) }) }); assert.equal(imported.status, 200); let project = await imported.json() as Project;
    const part = project.model.parts[0], sourceName = part.sourceName, sourcePath = part.path;
    project.model.constructionAxes = [{ id: 'axis-test', name: 'Pivot axis', componentPath: part.objectName, nativeToken: 'axis-token', origin: [...part.home.position], direction: [0, 0, 1], extent: [-12, 12], visible: true, partIds: [part.id] }];
    project.model.browserTree = [{ id: 'object-test', kind: 'object', name: 'Bracket assembly', componentPath: part.objectName, children: [
      { id: `part:${part.id}`, kind: 'part', name: part.name, partId: part.id }, { id: 'axis:axis-test', kind: 'axis', name: 'Pivot axis', axisId: 'axis-test' },
    ] }];
    const saved = await fetch(`${base}/api/projects/${project.id}`, { ...post({ project, expectedRevision: project.revision }), method: 'PUT' }); assert.equal(saved.status, 200); project = await saved.json() as Project;
    const added = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'step.add', name: 'Install bracket', parts: [part.id] }, { type: 'settings.update', patch: { showLabels: true, labelMode: 'part', labelFontSize: 18 } }] })); assert.equal(added.status, 200); project = (await added.json() as { project: Project }).project;
    const authoredStep = structuredClone(project.steps[0]);
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen(); const frontendUrl = frontend.resolvedUrls?.local[0]; assert.ok(frontendUrl);
    browser = await chromium.launch({ executablePath, headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await browserContext.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontendUrl}?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await page.evaluate(id => window.manualStudio.openStep(id), project.steps[0].id);
    await page.locator('[data-tree-node="object-test"] .tree-caret').first().click();
    const rowName = page.locator(`[data-rename-part="${part.id}"]`), editor = page.getByRole('textbox', { name: 'Name', exact: true });
    const initialCamera = await page.evaluate(() => window.manualStudio.view.cameraState());
    await rowName.dblclick(); await editor.waitFor({ state: 'visible' });
    assert.deepEqual(await editor.evaluate(input => { const element = input as HTMLInputElement; return [element.selectionStart, element.selectionEnd]; }), [0, part.name.length]);
    await editor.fill('List renamed bracket'); await editor.press('Enter');
    await page.waitForFunction(name => window.manualStudio.getProject()?.model.parts[0].name === name, 'List renamed bracket');
    await painted(page); sameCamera(await page.evaluate(() => window.manualStudio.view.cameraState()), initialCamera);
    assert.equal(await page.locator(`.part-label[data-name-id="${part.id}"]`).innerText(), 'List renamed bracket');

    const revisionAfterRename = (await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project).revision;
    await rowName.dblclick(); await editor.fill('Discard this name'); await editor.press('Escape'); await painted(page);
    assert.equal((await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project).revision, revisionAfterRename);
    await rowName.dblclick(); await editor.fill('Saved on blur'); await page.locator('.active-tab').click();
    await page.waitForFunction(() => window.manualStudio.getProject()?.model.parts[0].name === 'Saved on blur');

    const label = page.locator(`.part-label[data-name-id="${part.id}"]`);
    const beforeCanvasRename = await page.evaluate(() => window.manualStudio.view.cameraState());
    await label.dblclick(); await editor.fill('Canvas renamed bracket'); await editor.press('Enter');
    await page.waitForFunction(() => window.manualStudio.getProject()?.model.parts[0].name === 'Canvas renamed bracket');
    await painted(page); sameCamera(await page.evaluate(() => window.manualStudio.view.cameraState()), beforeCanvasRename);
    assert.equal(await rowName.innerText(), 'Canvas renamed bracket');
    const beforeCopy = await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project;
    await label.click({ button: 'right' });
    await page.waitForFunction(async () => await navigator.clipboard.readText() === 'Canvas renamed bracket');
    const firstConfirmation = await page.locator('.copy-notification').elementHandle(); assert.ok(firstConfirmation);
    await label.click({ button: 'right' });
    await page.waitForFunction(() => document.querySelectorAll('.copy-notification').length === 2);
    assert.equal(await firstConfirmation.evaluate(node => node.isConnected), true, 'A repeated copy must keep the preceding confirmation.');
    assert.deepEqual(await page.locator('.copy-notification').allTextContents(), ['Name copied to clipboard.', 'Name copied to clipboard.']);
    assert.deepEqual(await (await fetch(`${base}/api/projects/${project.id}`)).json(), beforeCopy, 'Copying a label must not move it or mutate the project.');
    assert.equal(await editor.count(), 0);

    const originalDistance = await page.evaluate(() => { const view = window.manualStudio.view; const camera = view.cameraState(); camera.eye = camera.eye.map((value, axis) => camera.target[axis] + (value - camera.target[axis]) * 4) as [number, number, number]; view.setCamera(camera); return Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis])); });
    await rowName.click({ button: 'middle' }); await painted(page);
    const focusedDistance = await page.evaluate(() => { const camera = window.manualStudio.view.cameraState(); return Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis])); });
    assert.ok(focusedDistance < originalDistance / 2, 'Middle-click on the list name must focus the part.');
    await page.evaluate(() => { const view = window.manualStudio.view; const camera = view.cameraState(); camera.eye = camera.eye.map((value, axis) => camera.target[axis] + (value - camera.target[axis]) * 4) as [number, number, number]; view.setCamera(camera); });
    await painted(page); await label.click({ button: 'middle' }); await painted(page);
    const labelDistance = await page.evaluate(() => { const camera = window.manualStudio.view.cameraState(); return Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis])); });
    assert.ok(Math.abs(labelDistance - focusedDistance) < 1e-6, 'A label uses the same middle-click focus.');

    await page.locator('[data-rename-object="object-test"]').dblclick(); await editor.fill('Renamed assembly'); await editor.press('Enter');
    await page.waitForFunction(() => window.manualStudio.getProject()?.model.browserTree?.[0].name === 'Renamed assembly');
    await page.locator('[data-rename-axis="axis-test"]').dblclick(); await editor.fill('Renamed pivot axis'); await editor.press('Enter');
    await page.waitForFunction(() => window.manualStudio.getProject()?.model.constructionAxes?.[0].name === 'Renamed pivot axis');
    await page.evaluate(() => window.manualStudio.command([{ type: 'settings.update', patch: { labelMode: 'object' } }]));
    const objectLabel = page.locator('.part-label[data-name-kind="object"][data-name-id="object-test"]');
    await objectLabel.waitFor({ state: 'visible' }); assert.equal(await objectLabel.innerText(), 'Renamed assembly');
    await objectLabel.dblclick(); await editor.fill('Assembly label rename'); await editor.press('Enter');
    await page.waitForFunction(() => window.manualStudio.getProject()?.model.browserTree?.[0].name === 'Assembly label rename');
    assert.equal(await page.locator('[data-rename-object="object-test"]').innerText(), 'Assembly label rename');
    const final = await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project;
    assert.equal(final.model.parts[0].sourceName, sourceName); assert.equal(final.model.parts[0].path, sourcePath);
    assert.equal(final.model.browserTree?.[0].children?.[0].name, 'Canvas renamed bracket');
    assert.equal(final.model.browserTree?.[0].children?.[1].name, 'Renamed pivot axis');
    assert.deepEqual(final.steps[0], authoredStep, 'Renaming must not alter poses, frames or membership.');
    await page.evaluate(id => window.manualStudio.command([{ type: 'step.add', name: 'Grouped stage', inherit: id }, { type: 'settings.update', patch: { labelMode: 'auto' } }]), authoredStep.id);
    const groupStep = await page.evaluate(() => window.manualStudio.getProject()!.steps.at(-1)!);
    await page.evaluate(id => window.manualStudio.openStep(id), groupStep.id);
    const groupLabel = page.locator(`.part-label[data-name-kind="group"][data-name-id="${groupStep.groups[0].id}"]`);
    await groupLabel.dblclick(); await editor.fill('Completed bracket group'); await editor.press('Enter');
    await page.waitForFunction(() => window.manualStudio.getProject()?.steps.at(-1)?.groups[0].name === 'Completed bracket group');
    assert.equal(await groupLabel.innerText(), 'Completed bracket group');
    assert.deepEqual((await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project).steps[0], authoredStep);
    assert.deepEqual(errors, []);
    context.diagnostic(JSON.stringify({ part: final.model.parts[0].name, object: final.model.browserTree?.[0].name, axis: final.model.constructionAxes?.[0].name, clipboard: await page.evaluate(() => navigator.clipboard.readText()), sourceIdentityPreserved: true, cameraUnchangedOnRename: true }));
  } finally {
    await browser?.close(); await frontend?.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-name-interactions-')); await rm(resolved, { recursive: true, force: true });
  }
});
