import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';
import { createServer, type ViteDevServer } from 'vite';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Command, Project } from '../shared/types.ts';
import { transactionModel } from './fixtures/assembly-transaction.ts';

test('Overall preview accepts successive drops, pans with the middle button, and filters independently of assembly actions', { timeout: 120000 }, async () => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'Chrome is required for the Overall preview check.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-overview-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let frontend: ViteDevServer | undefined, browser: Browser | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); });
      api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk))));
    });
    const modelPath = '3D/3dmodel.model';
    const archive = unzipSync(transactionModel(['Base', 'Collar', 'Cover', 'Spacer', 'Pin', 'Washer', 'Clip']));
    const xml = strFromU8(archive[modelPath])
      .replace('</resources>', '<object id="8" name="Mount"><components><component objectid="1"/><component objectid="2" transform="1 0 0 0 1 0 0 0 1 25 0 0"/></components></object></resources>')
      .replace(/<item objectid="[12]"[^>]*\/>/g, '')
      .replace('<build>', '<build><item objectid="8"/>');
    const imported = await fetch(`${base}/api/import?name=Overview.3mf`, { method: 'POST', body: Buffer.from(zipSync({ [modelPath]: strToU8(xml) })) });
    assert.equal(imported.status, 200);
    const initial = await imported.json() as Project;
    const [basePart, collar, cover, spacer, pin, washer, clip] = initial.model.parts;
    assert.equal(basePart.objectId, collar.objectId);
    const commands = async (revision: number, batch: Command[]): Promise<Project> => {
      const response = await fetch(`${base}/api/projects/${initial.id}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, commands: batch }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json() as { project: Project }).project;
    };
    const seeded = await commands(initial.revision, [
      { type: 'step.add', name: 'Mount base', parts: [basePart.id] },
      { type: 'step.add', name: 'Install spacer' },
      { type: 'part.initial', partIds: [pin.id], value: true },
      { type: 'settings.update', patch: { partVisibility: { [washer.id]: false } } },
    ]);
    const [occupied, empty] = seeded.steps;
    const initialProject = await commands(seeded.revision, [{ type: 'step.final', stepId: occupied.id, value: true }]);
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen();
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontend.resolvedUrls!.local[0]}?project=${initial.id}`);
    await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), initial.id);
    const camera = () => page.evaluate(() => window.manualStudio.view.cameraState());
    const selection = () => page.evaluate(() => window.manualStudio.getSession().selected);
    const project = () => page.evaluate(() => window.manualStudio.getProject()!);
    const visible = () => page.evaluate(() => [...window.manualStudio.view.meshes].filter(([, mesh]) => mesh.visible).map(([id]) => id));
    const screenPoint = (partId: string) => page.evaluate(id => {
      const view = window.manualStudio.view, mesh = view.meshes.get(id)!;
      const vertices = mesh.geometry.getAttribute('position'), vertex = mesh.position.clone(), center = vertex.clone().set(0, 0, 0);
      for (let index = 0; index < vertices.count; index++) center.add(vertex.fromBufferAttribute(vertices, index));
      mesh.localToWorld(center.divideScalar(vertices.count)).project(view.camera);
      const bounds = view.renderer.domElement.getBoundingClientRect();
      return { x: bounds.left + (center.x + 1) * bounds.width / 2, y: bounds.top + (1 - center.y) * bounds.height / 2 };
    }, partId);
    const clickPart = async (partId: string, button: 'left' | 'right' = 'left'): Promise<void> => {
      const point = await screenPoint(partId);
      await page.mouse.click(point.x, point.y, { button });
    };
    const overview = page.locator('[data-overview].active');
    const popup = page.locator('.popup-menu:not(.popup-submenu)');
    const occupiedCard = page.locator(`[data-step="${occupied.id}"]`);
    const filter = page.getByRole('checkbox', { name: 'Unassembled only' });
    const dragPart = async (partId: string, target: 'h3' | '.step-chip-row'): Promise<void> => {
      const point = await screenPoint(partId), destination = await occupiedCard.locator(target).boundingBox();
      assert.ok(destination);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 15, point.y - 12);
      await page.locator('.part-drag-ghost:not([hidden])').waitFor();
      await page.mouse.move(destination.x + 30, destination.y + destination.height / 2, { steps: 5 });
      await occupiedCard.and(page.locator('.drop-active')).waitFor();
      assert.equal(await occupiedCard.evaluate(card => getComputedStyle(card).borderTopColor), 'rgb(0, 214, 90)');
      await page.mouse.up();
      await page.locator('.drop-active').waitFor({ state: 'detached' });
    };

    const beforePan = await page.evaluate(() => {
      const view = window.manualStudio.view;
      view.controls.enableDamping = false;
      return view.cameraState();
    });
    const panStart = await screenPoint(collar.id);
    await page.mouse.move(panStart.x, panStart.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(panStart.x + 40, panStart.y + 27, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    const afterPan = await camera();
    assert.notDeepEqual(afterPan.target, beforePan.target);
    for (const i of [0, 1, 2]) assert.ok(Math.abs((afterPan.eye[i] - afterPan.target[i]) - (beforePan.eye[i] - beforePan.target[i])) < 1e-7, 'Pan must preserve the camera direction and distance.');
    assert.deepEqual(await selection(), []);
    await page.locator('#fitAll').click();

    await page.locator('#selectionMode').selectOption('object');
    await clickPart(collar.id, 'right');
    assert.deepEqual(new Set(await selection()), new Set([basePart.id, collar.id]));
    assert.equal(await popup.getByRole('button', { name: 'Add to Current Step', exact: true }).isDisabled(), true);
    await popup.getByRole('button', { name: 'Add to Existing Step', exact: true }).hover();
    assert.deepEqual(await popup.locator('.popup-submenu button').allTextContents(), ['Step 1 · Mount base', 'Step 2 · Install spacer']);
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });
    const rightDrag = await screenPoint(collar.id);
    await page.mouse.move(rightDrag.x, rightDrag.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(rightDrag.x + 25, rightDrag.y + 20, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    assert.equal(await popup.count(), 0, 'A right drag does not open a part menu.');
    await page.locator('#fitAll').click();
    await page.mouse.click(850, 820, { button: 'right' });
    assert.equal(await popup.count(), 0, 'A right click on empty space does not open a part menu.');
    assert.deepEqual(new Set(await selection()), new Set([basePart.id, collar.id]));

    await page.locator('#sectionValue').fill('.25');
    await page.locator('#explosionValue').fill('1.2');
    const section = await page.evaluate(() => window.manualStudio.view.sectionState());
    const exploded = await page.evaluate(id => window.manualStudio.view.meshes.get(id)!.position.toArray(), collar.id);
    await filter.check();
    assert.deepEqual(await visible(), [collar.id, cover.id, spacer.id, clip.id]);
    assert.deepEqual(await selection(), [collar.id]);
    assert.deepEqual(await page.evaluate(() => window.manualStudio.view.sectionState()), section);
    assert.deepEqual(await page.evaluate(id => window.manualStudio.view.meshes.get(id)!.position.toArray(), collar.id), exploded);
    assert.equal(await page.locator('#explosionValue').inputValue(), '1.20');
    assert.equal(await page.locator('#selectionMode').inputValue(), 'object');
    assert.deepEqual((await project()).settings, initialProject.settings);
    await page.locator('#sectionValue').fill('0');
    await page.locator('#explosionValue').fill('1');
    await clickPart(collar.id);
    assert.deepEqual(await selection(), [collar.id], 'Object mode selects only visible members in the filtered viewport.');

    const dropCamera = await camera();
    let resume = (): void => {};
    const delayFirstSave = new Promise<void>(resolve => { resume = resolve; });
    await page.route('**/commands', async route => { await delayFirstSave; await route.continue(); }, { times: 1 });
    try {
      await dragPart(collar.id, 'h3');
      await dragPart(cover.id, '.step-chip-row');
    } finally { resume(); }
    await page.waitForFunction(({ step, first, second }) => {
      const ids = window.manualStudio.getProject()?.steps.find(item => item.id === step)?.partIds;
      return ids?.includes(first) && ids.includes(second);
    }, { step: occupied.id, first: collar.id, second: cover.id });
    assert.deepEqual((await project()).steps[0].partIds, [basePart.id, collar.id, cover.id]);
    assert.equal(await overview.count(), 1);
    const afterDrops = await camera();
    for (const i of [0, 1, 2]) {
      assert.ok(Math.abs(afterDrops.eye[i] - dropCamera.eye[i]) < 1e-6);
      assert.ok(Math.abs(afterDrops.target[i] - dropCamera.target[i]) < 1e-6);
    }
    assert.deepEqual(await visible(), [spacer.id, clip.id]);

    await clickPart(spacer.id, 'right');
    await popup.getByRole('button', { name: 'Add to Existing Step', exact: true }).hover();
    await popup.getByRole('button', { name: 'Step 2 · Install spacer', exact: true }).click();
    await page.waitForFunction(({ step, id }) => window.manualStudio.getProject()?.steps.find(item => item.id === step)?.partIds.includes(id), { step: empty.id, id: spacer.id });
    assert.equal(await overview.count(), 1);
    assert.deepEqual(await visible(), [clip.id]);

    await clickPart(clip.id, 'right');
    await popup.getByRole('button', { name: 'Add to New Step', exact: true }).click();
    await page.waitForFunction(id => window.manualStudio.getProject()?.steps.find(step => step.id === window.manualStudio.getSession().stepId)?.partIds.includes(id), clip.id);
    assert.equal(await filter.isVisible(), false);
    const newStepId = await page.evaluate(() => window.manualStudio.getSession().stepId);
    await page.evaluate(id => window.manualStudio.view.fit([id]), spacer.id);
    await clickPart(spacer.id, 'right');
    await popup.getByRole('button', { name: 'Add to Current Step', exact: true }).click();
    await page.waitForFunction(({ step, id }) => window.manualStudio.getProject()?.steps.find(item => item.id === step)?.partIds.includes(id), { step: newStepId, id: spacer.id });
    await page.locator('#returnButton').click();
    assert.equal(await filter.isChecked(), true);
    assert.deepEqual(await visible(), []);
    await filter.uncheck();
    assert.deepEqual(await visible(), initial.model.parts.filter(part => part.id !== washer.id).map(part => part.id));
    assert.deepEqual((await project()).settings, initialProject.settings);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await frontend?.close(); if (api.exitCode === null) { api.kill(); await once(api, 'close'); }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-overview-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
