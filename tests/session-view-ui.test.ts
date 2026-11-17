import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { zipSync, strToU8 } from 'fflate';
import type { Project, SessionState } from '../shared/types.ts';

test('section planes and timeline stops synchronize with the API, including fractional frame previews', { timeout: 60000 }, async () => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath);
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-session-view-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let frontend: ViteDevServer | undefined, browser: Browser | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const xml = '<model unit="millimeter"><resources><object id="1" name="Bracket"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen(); browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(frontend.resolvedUrls!.local[0]);
    await page.locator('#emptyState').waitFor({ state: 'visible' });
    for (const button of ['saveButton', 'exportButton', 'settingsButton']) assert.equal(await page.locator('#' + button).isDisabled(), true);
    assert.equal(await page.locator('#importButton').isEnabled(), true);
    let project = await (await fetch(`${base}/api/import?name=Session.3mf`, { method: 'POST', body: zipSync({ '3D/3dmodel.model': strToU8(xml) }) })).json() as Project;
    project = (await (await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'step.add', name: 'Install bracket', parts: [project.model.parts[0].id] }] }))).json() as { project: Project }).project;
    const step = project.steps[0], part = project.model.parts[0], sessionUrl = `${base}/api/projects/${project.id}/session`;
    await page.goto(`${frontend.resolvedUrls!.local[0]}?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    for (const button of ['saveButton', 'exportButton', 'settingsButton']) assert.equal(await page.locator('#' + button).isEnabled(), true);
    assert.equal(await page.locator('#explodeButton').isDisabled(), true, 'Automatic teardown needs an assembly step.');
    await page.locator('#sectionValue').fill('.45'); await page.locator('#sectionValue').press('Tab');
    await page.waitForFunction(async id => (await (await fetch(`/api/projects/${id}/session`)).json()).section === .45, project.id);
    let state = await (await fetch(sessionUrl)).json() as SessionState;
    assert.deepEqual(state.sectionNormal, await page.evaluate(() => window.manualStudio.view.sectionState().normal));
    await fetch(sessionUrl, { ...post({ section: .65, sectionNormal: [1, 0, 0] }), method: 'PUT' });
    await page.waitForFunction(() => window.manualStudio.view.sectionState().amount === .65);
    assert.equal(await page.locator('#sectionValue').inputValue(), '0.65'); assert.deepEqual(await page.evaluate(() => window.manualStudio.view.sectionState().normal), [1, 0, 0]);
    await page.locator(`[data-step="${step.id}"] h3`).click();
    assert.equal(await page.locator('#explodeButton').isEnabled(), true, 'A new movable member can be automatically exploded.');
    await page.locator('#playSlider').press('End');
    await page.waitForFunction(async ({ id, frameId }) => (await (await fetch(`/api/projects/${id}/session`)).json()).frameId === frameId, { id: project.id, frameId: step.frames[1].id });
    state = await (await fetch(sessionUrl)).json() as SessionState;
    assert.equal(state.frameProgress, 0); assert.equal(state.section, 0);
    assert.equal(await page.evaluate(() => window.manualStudio.getSession().frameId), step.frames[1].id);
    await fetch(sessionUrl, { ...post({ stepId: step.id, frameId: step.frames[0].id, frameProgress: .5 }), method: 'PUT' });
    await page.waitForFunction(() => window.manualStudio.getSession().frameProgress === .5);
    const position = await page.evaluate(id => window.manualStudio.view.meshes.get(id)!.position.toArray(), part.id);
    const expected = step.frames[0].poses[part.id].position.map((value, index) => (value + step.frames[1].poses[part.id].position[index]) / 2);
    position.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-8));
    await fetch(sessionUrl, { ...post({ frameId: step.frames[1].id }), method: 'PUT' });
    await page.waitForFunction(id => window.manualStudio.getSession().frameId === id, step.frames[1].id);
    assert.equal((await (await fetch(sessionUrl)).json() as SessionState).frameProgress, undefined, 'A new explicit keyframe selection clears an earlier fractional preview.');
    await page.locator('#addStep').click(); await page.locator('#cancelPicker').click();
    assert.equal(await page.locator('#playStep').isDisabled(), true);
    await page.locator('[data-tool="glue"]').click(); assert.equal(await page.locator('#playStep').isDisabled(), true, 'Guide-only rerenders must preserve disabled local playback.');
    assert.equal(await page.locator('#explodeButton').isDisabled(), true);

    const projectUrl = `${base}/api/projects/${project.id}`;
    const saved = await (await fetch(projectUrl)).json() as Project;
    const inheritedResult = await fetch(projectUrl + '/commands', post({ expectedRevision: saved.revision, commands: [{ type: 'step.copy', stepId: step.id, inherit: true }, { type: 'step.add', name: 'Initially assembled bracket', parts: [part.id] }] }));
    assert.equal(inheritedResult.status, 200);
    const inherited = await inheritedResult.json() as { project: Project; results: string[] };
    await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, inherited.project.revision);
    await page.locator(`[data-step="${inherited.results[0]}"] h3`).click();
    assert.equal(await page.locator('#explodeButton').isDisabled(), true, 'An inherited assembly is already fixed before any part is marked initially assembled.');
    await page.locator('#explodeButton').evaluate(button => (button as HTMLButtonElement).click());
    assert.equal((await (await fetch(projectUrl)).json() as Project).revision, inherited.project.revision);

    const initialResult = await fetch(projectUrl + '/commands', post({ expectedRevision: inherited.project.revision, commands: [{ type: 'part.initial', partIds: [part.id], value: true }] }));
    assert.equal(initialResult.status, 200);
    const initiallyAssembled = await initialResult.json() as { project: Project };
    await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, initiallyAssembled.project.revision);
    await page.locator(`[data-step="${inherited.results[1]}"] h3`).click();
    assert.equal(await page.locator('#explodeButton').isDisabled(), true, 'A step containing only initially assembled parts has no teardown.');
    await page.locator('#explodeButton').evaluate(button => (button as HTMLButtonElement).click());
    assert.equal((await (await fetch(projectUrl)).json() as Project).revision, initiallyAssembled.project.revision);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await frontend?.close(); if (api.exitCode === null) { api.kill(); await once(api, 'close'); }
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-session-view-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
