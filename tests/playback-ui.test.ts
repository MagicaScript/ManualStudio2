import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { zipSync, strToU8 } from 'fflate';
import type { Camera, Project } from '../shared/types.ts';

async function settledState(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const overlay = document.querySelector<HTMLCanvasElement>('#playbackOverlay'), button = document.querySelector<HTMLButtonElement>('#playButton');
    return { ...window.manualStudio.getSession(), camera: window.manualStudio.view.cameraState(), overlayHidden: overlay?.hidden, button: button?.getAttribute('aria-label'), frameNumber: document.querySelector('#frameNumber')?.textContent };
  });
}

function sameCamera(actual: Camera, expected: Camera, reason: string): void {
  for (const key of ['eye', 'target', 'up'] as const) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[key][axis] - expected[key][axis]) < 1e-8, `${reason}: ${key}[${axis}]`);
}

test('playback stops remain stable after paint and external API navigation stops active playback', { timeout: 45000 }, async context => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath, 'The playback interface check requires installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-playback-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const xml = '<model unit="millimeter"><resources><object id="1" name="Bracket"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
    const imported = await fetch(`${base}/api/import?name=Playback.3mf`, { method: 'POST', body: zipSync({ '3D/3dmodel.model': strToU8(xml) }) }); assert.equal(imported.status, 200); let project = await imported.json() as Project;
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const edited = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: Array.from({ length: 3 }, (_, index) => ({ type: 'step.add', name: `Step ${index + 1}`, parts: [project.model.parts[0].id] })) })); assert.equal(edited.status, 200); project = (await edited.json() as { project: Project }).project;
    const secondCamera: Camera = { eye: [80, 40, 70], target: [1, 2, 3], up: [0, 0, 1], margin: 1.25 };
    const cameraEdit = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'frame.update', stepId: project.steps[1].id, frameId: project.steps[1].frames[0].id, patch: { camera: secondCamera } }] })); assert.equal(cameraEdit.status, 200); project = (await cameraEdit.json() as { project: Project }).project;
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await page.evaluate(id => window.manualStudio.openStep(id), project.steps[0].id);
    await page.locator('#playButton').click(); assert.equal((await settledState(page)).playing, true);
    await page.locator('#playButton').click(); await page.locator(`[data-frame="${project.steps[0].frames[1].id}"]`).click();
    const stopped = [];
    for (let paint = 0; paint < 8; paint++) stopped.push(await settledState(page));
    for (const state of stopped) { assert.equal(state.playing, false); assert.equal(state.overlayHidden, true); assert.equal(state.button, 'Play all steps'); assert.equal(state.frameId, project.steps[0].frames[1].id); assert.equal(state.frameNumber, '2/6'); }
    context.diagnostic(JSON.stringify({ rapidPlayPauseEnd: 'stable across 16 paints', state: stopped.at(-1) }));

    await page.evaluate(id => window.manualStudio.openStep(id), project.steps[0].id); await page.locator('#playButton').click(); assert.equal((await settledState(page)).playing, true);
    const selected = await fetch(`${base}/api/projects/${project.id}/session`, { ...post({ selected: [project.model.parts[0].id] }), method: 'PUT' }); assert.equal(selected.status, 200);
    const selectedState = await settledState(page); assert.equal(selectedState.playing, true, 'A selection-only API update must not interrupt playback.');
    const navigated = await fetch(`${base}/api/projects/${project.id}/session`, { ...post({ stepId: project.steps[1].id, frameId: null }), method: 'PUT' }); assert.equal(navigated.status, 200);
    assert.equal((await navigated.json() as { playing: boolean }).playing, false);
    const navigation = [];
    for (let paint = 0; paint < 8; paint++) navigation.push(await settledState(page));
    context.diagnostic(JSON.stringify({ apiNavigationDuringPlayback: navigation.at(-1) }));
    for (const state of navigation.slice(-4)) { assert.equal(state.playing, false); assert.equal(state.overlayHidden, true); assert.equal(state.stepId, project.steps[1].id); assert.equal(state.frameId, project.steps[1].frames[0].id); }
    sameCamera(navigation.at(-1)!.camera, secondCamera, 'API navigation must restore the saved camera');
    const manualCamera: Camera = { eye: [100, -60, 40], target: [3, 3, 3], up: [0, 0, 1], margin: 1.25 };
    await page.evaluate(camera => window.manualStudio.view.setCamera(camera), manualCamera);
    await fetch(`${base}/api/projects/${project.id}/session`, { ...post({ selected: [] }), method: 'PUT' });
    sameCamera((await settledState(page)).camera, manualCamera, 'Selection-only updates must retain the current camera');
    await page.evaluate(id => window.manualStudio.openStep(id), project.steps[2].id); const localFit = (await settledState(page)).camera;
    await page.evaluate(camera => window.manualStudio.view.setCamera(camera), manualCamera);
    await fetch(`${base}/api/projects/${project.id}/session`, { ...post({ stepId: project.steps[2].id, frameId: null }), method: 'PUT' });
    sameCamera((await settledState(page)).camera, localFit, 'An API step without a saved camera must fit exactly like local navigation');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-playback-')); await rm(resolved, { recursive: true, force: true });
  }
});
