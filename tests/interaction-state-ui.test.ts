import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { zipSync, strToU8 } from 'fflate';
import type { Command, Project } from '../shared/types.ts';
import { DEFAULT_GLUE_COLOR } from '../shared/render-style.ts';

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function openPartSearch(page: Page, text: string): Promise<void> {
  if (!await page.locator('#partSearch').isVisible()) await page.locator('#searchButton').click();
  await page.locator('#partSearch').fill(text);
}
async function surfacePoints(page: Page, partId: string): Promise<{ x: number; y: number }[]> {
  await painted(page);
  const points = await page.evaluate(id => {
    const view = window.manualStudio.view, mesh = view.meshes.get(id);
    if (!mesh) return [];
    mesh.updateMatrixWorld(true);
    const screen = view.renderer.domElement.getBoundingClientRect(), positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.getIndex();
    const result: { x: number; y: number }[] = [];
    for (let face = 0; face < (indices?.count ?? positions.count) / 3; face++) {
      const vertices = [0, 1, 2].map(corner => mesh.position.clone().fromBufferAttribute(positions, indices?.getX(face * 3 + corner) ?? face * 3 + corner));
      vertices.forEach(vertex => mesh.localToWorld(vertex));
      const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0]));
      if (normal.dot(view.camera.position.clone().sub(vertices[0])) <= 0) continue;
      for (const weights of [[.25, .35, .4], [.4, .35, .25]]) {
        const point = vertices[0].clone().multiplyScalar(weights[0]).addScaledVector(vertices[1], weights[1]).addScaledVector(vertices[2], weights[2]).project(view.camera);
        const pixel = { x: screen.left + (point.x + 1) * screen.width / 2, y: screen.top + (1 - point.y) * screen.height / 2 };
        if (point.z >= -1 && point.z <= 1 && document.elementFromPoint(pixel.x, pixel.y) === view.renderer.domElement) result.push(pixel);
      }
    }
    return result;
  }, partId);
  assert.ok(points.length >= 2, 'The fixture must expose two surface points outside application panels.');
  return points;
}

test('selection, project switching and queued glue operations retain their intended context', { timeout: 90000 }, async context => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath, 'Interaction regression requires installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-interaction-state-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const request = async <T>(route: string, init?: RequestInit): Promise<T> => { const response = await fetch(base + route, init); assert.ok(response.ok, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`); return response.json() as Promise<T>; };
    const read = (id: string): Promise<Project> => request(`/api/projects/${id}`);
    const command = async (id: string, commands: Command[]): Promise<Project> => (await request<{ project: Project }>(`/api/projects/${id}/commands`, post({ expectedRevision: (await read(id)).revision, commands }))).project;
    const xml = '<model unit="millimeter"><resources>' + ['Front bracket', 'Rear plate', 'Test shaft'].map((name, index) => `<object id="${index + 1}" name="${name}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object>`).join('') + '</resources><build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 24 0 0"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 -24 0 0"/></build></model>';
    const createFixture = async (name: string): Promise<Project> => {
      const imported = await request<Project>(`/api/import?name=${encodeURIComponent(name + '.3mf')}`, { method: 'POST', body: Buffer.from(zipSync({ '3D/3dmodel.model': strToU8(xml) })) });
      return command(imported.id, [{ type: 'step.add', name: 'Install all parts', parts: imported.model.parts.map(part => part.id) }, { type: 'step.add', name: 'Check assembly', parts: imported.model.parts.map(part => part.id) }, { type: 'settings.update', patch: { showLabels: false } }]);
    };
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen(); const url = frontend.resolvedUrls?.local[0]; assert.ok(url);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } }); page.setDefaultTimeout(7000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const navigate = async (project: Project): Promise<void> => { await page.goto(`${url}?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id); };
    const revision = async (value: number): Promise<void> => { await page.waitForFunction(expected => window.manualStudio.getProject()!.revision >= expected, value); };
    const row = (id: string) => page.locator(`#partTree [data-part="${id}"]`);

    await context.test('context-menu selection is stable and blank canvas cannot create an empty merged step', async () => {
      const project = await createFixture('Selection context'), [first, second, third] = project.model.parts;
      await navigate(project); await openPartSearch(page, first.name); await row(first.id).click();
      await openPartSearch(page, second.name); await row(second.id).click({ modifiers: ['Control'] });
      assert.deepEqual(await page.evaluate(() => window.manualStudio.getSession().selected), [first.id, second.id]);
      await row(second.id).click({ button: 'right' });
      assert.deepEqual(await page.evaluate(() => window.manualStudio.getSession().selected), [first.id, second.id], 'A context menu on a selected row preserves the complete selection.');
      await page.locator('.popup-menu button').filter({ hasText: /^Initially assembled$/ }).click(); await revision(project.revision + 1);
      assert.deepEqual((await read(project.id)).model.parts.filter(part => part.initiallyAssembled).map(part => part.id).sort(), [first.id, second.id].sort());
      await openPartSearch(page, third.name); await row(third.id).click({ button: 'right' });
      assert.deepEqual(await page.evaluate(() => window.manualStudio.getSession().selected), [third.id], 'A context menu outside the selection selects its own target.');
      await page.keyboard.press('Escape'); await openPartSearch(page, first.name); await row(first.id).click({ modifiers: ['Control'] });
      assert.equal(await page.locator('#selectionStep').isVisible(), true); assert.equal(await page.locator('#selectionStep').isDisabled(), false);
      const canvas = await page.locator('#viewport canvas').boundingBox(); assert.ok(canvas);
      await page.mouse.click(canvas.x + canvas.width * .58, canvas.y + canvas.height * .78);
      assert.deepEqual(await page.evaluate(() => window.manualStudio.getSession().selected), []);
      assert.equal(await page.locator('#selectionStep').isVisible(), false); assert.equal(await page.locator('#selectionStep').isDisabled(), true);
      assert.equal(await page.locator('#partTree [aria-selected="true"]').count(), 0);
      await page.locator('#selectionStep').dispatchEvent('click'); await painted(page);
      assert.equal((await read(project.id)).steps.length, project.steps.length, 'A stale or dispatched merge action cannot create an empty step.');
    });

    await context.test('project and model loads reset isolation, selection, tool and toolbar state', async () => {
      const initial = await createFixture('Isolated project'), next = await createFixture('Second project');
      await navigate(initial); await openPartSearch(page, initial.model.parts[0].name); await row(initial.model.parts[0].id).click({ button: 'right' });
      await page.locator('.popup-menu button').filter({ hasText: /^Isolate selected parts$/ }).click();
      assert.equal(await page.evaluate(() => [...window.manualStudio.view.meshes.values()].filter(mesh => mesh.visible).length), 1);
      await page.locator(`[data-step="${initial.steps[0].id}"] h3`).click(); await page.locator('[data-tool="glue"]').click();
      await page.locator('#projectSelect').selectOption(next.id); await page.waitForFunction(id => window.manualStudio.getProject()?.id === id && !document.querySelector('.busy-overlay'), next.id);
      assert.equal(await page.evaluate(() => [...window.manualStudio.view.meshes.values()].filter(mesh => mesh.visible).length), next.model.parts.length);
      assert.equal(await page.evaluate(() => window.manualStudio.view.tool), 'select');
      assert.deepEqual(await page.evaluate(() => window.manualStudio.getSession().selected), []);
      assert.equal(await page.locator('[data-tool="glue"]').evaluate(button => button.classList.contains('active')), false);
      const points = await surfacePoints(page, next.model.parts[0].id); await page.mouse.click(points[0].x, points[0].y);
      assert.deepEqual(await page.evaluate(() => window.manualStudio.getSession().selected), [next.model.parts[0].id], 'The new model immediately accepts ordinary selection.');
      await page.evaluate(() => { const view = window.manualStudio.view; view.setVisibility([...view.meshes.keys()], false); view.isolate(['obsolete-part']); });
      const updated = await read(next.id); updated.model.id += '-updated';
      const saved = await request<Project>(`/api/projects/${next.id}`, { ...post({ project: updated, expectedRevision: updated.revision }), method: 'PUT' });
      await revision(saved.revision);
      assert.equal(await page.evaluate(() => [...window.manualStudio.view.meshes.values()].filter(mesh => mesh.visible).length), next.model.parts.length, 'A new source model also resets transient visibility.');
    });

    await context.test('rapid glue clicks merge from latest saved notes and stay in their original frame', async () => {
      let project = await createFixture('Queued glue'); await navigate(project);
      await page.locator(`[data-step="${project.steps[0].id}"] h3`).click(); await page.locator('[data-tool="glue"]').click(); await page.locator('#glueMode').selectOption('circle');
      let nextGate: ReturnType<typeof gate> | undefined, received: ReturnType<typeof gate> | undefined;
      await page.route('**/api/projects/*/commands', async route => { const wait = nextGate; nextGate = undefined; received?.release(); if (wait) await wait.promise; await route.continue(); });
      const hold = () => { nextGate = gate(); received = gate(); return { release: nextGate.release, request: received.promise }; };
      const click = async (index = 0): Promise<void> => { const points = await surfacePoints(page, project.model.parts[0].id); await page.mouse.click(points[index].x, points[index].y); };
      try {
        let pending = hold(); await click(); await pending.request; await click(1); pending.release(); await revision(project.revision + 2); project = await read(project.id);
        const initialNoteId = project.steps[0].frames[0].notes[0].id;
        assert.equal(project.steps[0].frames[0].notes.length, 1); assert.equal(project.steps[0].frames[0].notes[0].anchors.length, 2); assert.equal(project.steps[0].frames[0].notes[0].color, DEFAULT_GLUE_COLOR);
        pending = hold(); await click(); await pending.request; await click(1); pending.release(); await revision(project.revision + 2); project = await read(project.id);
        assert.equal(project.steps[0].frames[0].notes.length, 1); assert.equal(project.steps[0].frames[0].notes[0].id, initialNoteId); assert.equal(project.steps[0].frames[0].notes[0].anchors.length, 4);

        pending = hold(); await click(); await pending.request;
        await page.locator('#editNoteColor').fill('#a1b2c3'); await page.locator('#editNoteColor').dispatchEvent('change');
        await page.locator('[data-close-note]').click(); await page.locator('.note-editor').waitFor({ state: 'detached' }); await painted(page);
        const label = await page.locator(`.surface-note[data-note-id="${initialNoteId}"]`).boundingBox(); assert.ok(label);
        assert.equal(await page.evaluate(label => document.elementFromPoint(label.x + label.width / 2, label.y + label.height / 2)?.closest<HTMLElement>('.surface-note')?.dataset.noteId, label), initialNoteId, 'The drag target must be an exposed label.');
        await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2); await page.mouse.down(); await page.mouse.move(label.x + label.width / 2 + 15, label.y + label.height / 2 - 12, { steps: 2 }); await page.mouse.up();
        await page.locator(`.surface-note[data-note-id="${initialNoteId}"]`).click();
        await page.locator('[data-delete-region="0"]').click(); pending.release(); await revision(project.revision + 4); project = await read(project.id);
        assert.equal(project.steps[0].frames[0].notes[0].anchors.length, 4, 'Moving or editing a note and deleting an old region retain a queued new paint region.');
        assert.equal(project.steps[0].frames[0].notes[0].color, '#a1b2c3'); assert.notDeepEqual(project.steps[0].frames[0].notes[0].offset, [30, -40]);

        await page.locator('[data-tool="glue"]').click();
        await page.locator('#newGlueNote').click(); await page.locator('#noteColor').fill('#6588a9'); await page.locator('#noteColor').dispatchEvent('change');
        pending = hold(); await click(); await pending.request; await page.locator('#newGlueNote').click(); await click(1); pending.release(); await revision(project.revision + 2); project = await read(project.id);
        assert.deepEqual(project.steps[0].frames[0].notes.map(note => note.anchors.length), [4, 1, 1], 'New region set starts a distinct operation even while an earlier operation is saving.');
        assert.deepEqual(project.steps[0].frames[0].notes.slice(1).map(note => note.color), ['#6588a9', '#6588a9']);

        const firstFrame = project.steps[0].frames[0].id, secondFrame = project.steps[0].frames[1].id;
        pending = hold(); await click(); await pending.request;
        await page.locator(`[data-frame="${secondFrame}"]`).click(); await click(1); pending.release(); await revision(project.revision + 2); project = await read(project.id);
        assert.deepEqual(project.steps[0].frames[0].notes.map(note => note.anchors.length), [4, 1, 2]);
        assert.equal(project.steps[0].frames[1].notes.length, 1); assert.equal(project.steps[0].frames[1].notes[0].anchors.length, 1);
        assert.equal(await page.evaluate(() => window.manualStudio.getSession().frameId), secondFrame);
        assert.equal(await page.locator('.note-editor .small.muted').first().innerText(), '1 attachment');

        pending = hold(); await click(); await pending.request;
        await page.locator(`[data-step="${project.steps[1].id}"] h3`).click(); await page.locator('[data-tool="glue"]').click(); await click(1); pending.release(); await revision(project.revision + 2); project = await read(project.id);
        assert.equal(project.steps[0].frames[1].notes[0].anchors.length, 2); assert.equal(project.steps[1].frames[0].notes[0].anchors.length, 1);
        assert.equal(project.steps[0].frames[0].id, firstFrame); assert.equal(await page.evaluate(() => window.manualStudio.getSession().stepId), project.steps[1].id);
      } finally { nextGate?.release(); await page.unroute('**/api/projects/*/commands'); }
    });

    await context.test('late external reloads cannot restore another project or overwrite a newer local edit', async () => {
      const first = await createFixture('Delayed first project'), second = await createFixture('Delayed second project'); await navigate(first);
      const release = gate(), captured = gate(); let held = false;
      await page.route(`**/api/projects/${first.id}`, async route => {
        if (route.request().method() !== 'GET' || held) { await route.continue(); return; }
        held = true; const response = await route.fetch(); captured.release(); await release.promise; await route.fulfill({ response });
      });
      try {
        await command(first.id, [{ type: 'step.rename', stepId: first.steps[0].id, name: 'Externally updated first project' }]); await captured.promise;
        await page.locator('#projectSelect').selectOption(second.id); await page.waitForFunction(id => window.manualStudio.getProject()?.id === id && !document.querySelector('.busy-overlay'), second.id);
        const arrived = page.waitForResponse(response => response.url().endsWith(`/api/projects/${first.id}`) && response.request().method() === 'GET'); release.release(); await arrived; await painted(page);
        assert.equal(await page.evaluate(() => window.manualStudio.getProject()!.id), second.id);
        assert.deepEqual(await page.evaluate(() => [...window.manualStudio.view.meshes.keys()].sort()), second.model.parts.map(part => part.id).sort());
      } finally { release.release(); await page.unroute(`**/api/projects/${first.id}`); }

      await navigate(await read(first.id));
      const geometryRelease = gate(), geometryCaptured = gate(), openRelease = gate(), openCaptured = gate();
      const geometryPath = first.model.parts[0].geometry.file;
      const previousMesh = await page.evaluateHandle(id => window.manualStudio.view.meshes.get(id), first.model.parts[0].id);
      await page.route(`**${geometryPath}`, async route => { const response = await route.fetch(); geometryCaptured.release(); await geometryRelease.promise; await route.fulfill({ response }); });
      await page.route(`**/api/projects/${second.id}`, async route => { openCaptured.release(); await openRelease.promise; await route.continue(); });
      try {
        const updated = await read(first.id); updated.model.id += '-late-model';
        await request(`/api/projects/${first.id}`, { ...post({ project: updated, expectedRevision: updated.revision }), method: 'PUT' }); await geometryCaptured.promise;
        await page.locator('#projectSelect').selectOption(second.id); await openCaptured.promise;
        const arrived = page.waitForResponse(response => response.url().endsWith(geometryPath)); geometryRelease.release(); await arrived; await painted(page);
        assert.equal(await previousMesh.evaluate(mesh => [...window.manualStudio.view.meshes.values()].includes(mesh!)), true, 'A stale geometry load must not swap meshes while a different project is opening.');
        openRelease.release(); await page.waitForFunction(id => window.manualStudio.getProject()?.id === id && !document.querySelector('.busy-overlay'), second.id);
        assert.deepEqual(await page.evaluate(() => [...window.manualStudio.view.meshes.keys()].sort()), second.model.parts.map(part => part.id).sort());
      } finally { geometryRelease.release(); openRelease.release(); await previousMesh.dispose(); await page.unroute(`**${geometryPath}`); await page.unroute(`**/api/projects/${second.id}`); }

      const current = await read(first.id); await navigate(current);
      const olderRelease = gate(), olderCaptured = gate(); held = false;
      await page.route(`**/api/projects/${first.id}`, async route => {
        if (route.request().method() !== 'GET' || held) { await route.continue(); return; }
        held = true; const response = await route.fetch(); olderCaptured.release(); await olderRelease.promise; await route.fulfill({ response });
      });
      try {
        await command(first.id, [{ type: 'step.description', stepId: first.steps[0].id, text: 'Older external description' }]); await olderCaptured.promise;
        const newer = await command(first.id, [{ type: 'step.description', stepId: first.steps[0].id, text: 'Newer external description' }]); await revision(newer.revision);
        await page.evaluate(id => window.manualStudio.command([{ type: 'step.rename', stepId: id, name: 'Newest local edit' }]), first.steps[0].id);
        const before = await page.evaluate(() => window.manualStudio.getProject()!);
        const arrived = page.waitForResponse(response => response.url().endsWith(`/api/projects/${first.id}`) && response.request().method() === 'GET'); olderRelease.release(); await arrived; await painted(page);
        assert.deepEqual(await page.evaluate(() => window.manualStudio.getProject()), before, 'An older external response cannot replace a later local revision.');
      } finally { olderRelease.release(); await page.unroute(`**/api/projects/${first.id}`); }
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await frontend?.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-interaction-state-')); await rm(resolved, { recursive: true, force: true });
  }
});
