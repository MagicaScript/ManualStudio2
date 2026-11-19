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
import type { Project } from '../shared/types.ts';

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function startDrag(page: Page, stepId: string): Promise<void> {
  const handle = page.locator(`[data-reorder="${stepId}"]`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox(); assert.ok(box);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 12, y + 3, { steps: 4 });
  await page.waitForFunction(id => document.querySelector<HTMLElement>('#structure')?.dataset.reorderStep === id, stepId);
}

test('native dragging opens insertion space, cancels over the original card, and moves the last step to the first gap', { timeout: 60000 }, async context => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'The step-reorder interaction check requires installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-step-reorder-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); });
      api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk))));
    });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const xml = '<model unit="millimeter"><resources><object id="1" name="Bracket"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
    const imported = await fetch(`${base}/api/import?name=Reorder.3mf`, { method: 'POST', body: zipSync({ '3D/3dmodel.model': strToU8(xml) }) });
    assert.equal(imported.status, 200); let project = await imported.json() as Project;
    const added = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: Array.from({ length: 4 }, (_, index) => ({ type: 'step.add', name: `Operation ${index + 1}`, parts: [project.model.parts[0].id] })) }));
    assert.equal(added.status, 200); project = (await added.json() as { project: Project }).project;
    const order = project.steps.map(step => step.id), last = order[3];
    const noOp = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'step.reorder', stepId: last, before: last }, { type: 'step.reorder', stepId: last }] }));
    assert.equal(noOp.status, 200);
    assert.deepEqual((await noOp.json() as { project: Project }).project, project, 'CLI/API cancellation must preserve the full saved revision.');

    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen(); const frontendUrl = frontend.resolvedUrls?.local[0]; assert.ok(frontendUrl);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontendUrl}?project=${project.id}`);
    await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await page.locator(`[data-step="${last}"] .step-tag`).click();
    await page.locator(`[data-rename-step="${last}"]`).dblclick();
    await page.locator('#stepNameEdit').waitFor({ state: 'visible' });
    await page.locator('.modal-footer').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(id => window.manualStudio.command([{ type: 'step.reorder', stepId: id, before: id }]), last);
    assert.equal(await page.locator('#undoButton').isDisabled(), true, 'A no-op must not add an undo entry.');
    let commandRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands')) commandRequests++; });

    const firstCard = page.locator(`[data-step="${order[0]}"]`), targetGap = page.locator(`[data-reorder-before="${order[0]}"]`);
    const firstBefore = await firstCard.boundingBox(); assert.ok(firstBefore);
    const sourceBefore = await page.locator(`[data-step="${last}"]`).boundingBox(); assert.ok(sourceBefore);
    await startDrag(page, last);
    const gapBefore = await targetGap.boundingBox(); assert.ok(gapBefore);
    await page.mouse.move(gapBefore.x + gapBefore.width / 2, gapBefore.y + gapBefore.height / 2, { steps: 10 });
    await page.mouse.move(gapBefore.x + gapBefore.width / 2, gapBefore.y + gapBefore.height / 2);
    await page.waitForFunction(height => (document.querySelector('.step-reorder-target')?.getBoundingClientRect().height ?? 0) >= height + 20, sourceBefore.height, { timeout: 6000 });
    const firstPreview = await firstCard.boundingBox(); assert.ok(firstPreview);
    assert.ok(firstPreview.y - firstBefore.y >= sourceBefore.height + 8, 'The first card must yield one full step of insertion space.');
    const transition = await targetGap.evaluate(element => getComputedStyle(element).transitionDuration);
    assert.notEqual(transition, '0s', 'The insertion movement must animate.');
    const sourceReturn = await page.locator(`[data-step="${last}"]`).boundingBox(); assert.ok(sourceReturn);
    await page.mouse.move(sourceReturn.x + sourceReturn.width / 2, sourceReturn.y + sourceReturn.height / 2, { steps: 12 });
    await page.mouse.move(sourceReturn.x + sourceReturn.width / 2, sourceReturn.y + sourceReturn.height / 2);
    await page.waitForFunction(id => (document.querySelector(`[data-reorder-before="${id}"]`)?.getBoundingClientRect().height ?? Infinity) < 13, order[0], { timeout: 6000 });
    const originalCard = await page.locator(`[data-step="${last}"]`).boundingBox(); assert.ok(originalCard);
    await page.mouse.move(originalCard.x + originalCard.width / 2, originalCard.y + originalCard.height / 2, { steps: 4 });
    await page.mouse.move(originalCard.x + originalCard.width / 2, originalCard.y + originalCard.height / 2);
    await page.mouse.up(); await painted(page);
    assert.equal(commandRequests, 0, 'Dropping back onto the original card must not send an edit.');
    assert.deepEqual(await (await fetch(`${base}/api/projects/${project.id}`)).json(), project);
    assert.equal(await page.locator('#undoButton').isDisabled(), true);
    assert.equal(await page.locator('.step-reorder-target,.step-reorder-source').count(), 0);

    await startDrag(page, last);
    const destination = await targetGap.boundingBox(); assert.ok(destination);
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 10 });
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2);
    await page.waitForFunction(() => !!document.querySelector('.step-reorder-target'));
    await page.mouse.up();
    await page.waitForFunction(id => window.manualStudio.getProject()?.steps[0].id === id, last);
    const moved = await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project;
    assert.deepEqual(moved.steps.map(step => step.id), [last, ...order.slice(0, 3)]);
    assert.deepEqual(moved.steps, [project.steps[3], ...project.steps.slice(0, 3)], 'Reordering must preserve every authored step object.');
    assert.equal(moved.revision, project.revision + 1); assert.equal(commandRequests, 1);
    assert.equal(await page.locator('#undoButton').isEnabled(), true, 'The browser must retain history for its own saved reorder.');
    await page.evaluate(id => window.manualStudio.command([{ type: 'step.description', stepId: id, text: 'Temporary local description' }]), last);
    await page.locator('#undoButton').click();
    await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, moved.revision + 2);
    assert.equal(await page.locator('#undoButton').isEnabled(), true);
    assert.equal(await page.locator('#redoButton').isEnabled(), true);
    const externalEdit = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: moved.revision + 2, commands: [{ type: 'step.description', stepId: last, text: 'Assembly authored through the CLI' }] }));
    assert.equal(externalEdit.status, 200); const externallyAuthored = (await externalEdit.json() as { project: Project }).project;
    await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, externallyAuthored.revision);
    assert.equal(await page.locator('#undoButton').isDisabled(), true, 'An external edit must invalidate stale local undo snapshots.');
    assert.equal(await page.locator('#redoButton').isDisabled(), true, 'An external edit must invalidate stale local redo snapshots.');
    const requestsAfterExternalEdit = commandRequests;
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y'); await painted(page);
    assert.equal(commandRequests, requestsAfterExternalEdit);
    assert.deepEqual(await (await fetch(`${base}/api/projects/${project.id}`)).json(), externallyAuthored, 'Undo/redo must not overwrite the externally authored assembly.');
    assert.deepEqual(errors, []);
    context.diagnostic(JSON.stringify({ insertionShiftPx: firstPreview.y - firstBefore.y, sourceCardHeightPx: sourceBefore.height, cancelledDropRequests: 0, reorderRequests: 1, finalOrder: moved.steps.map(step => step.name), externalEditClearedUndoAndRedo: true }));
  } finally {
    await browser?.close(); await frontend?.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-step-reorder-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
