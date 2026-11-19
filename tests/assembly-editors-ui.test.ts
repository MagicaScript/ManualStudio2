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
import type { Camera, Project, Vec3 } from '../shared/types.ts';

async function fillVector(page: Page, label: string, value: Vec3): Promise<void> {
  for (const [index, axis] of ['X', 'Y', 'Z'].entries()) await page.getByLabel(`${label} ${axis}`, { exact: true }).fill(String(value[index]));
}
async function applyEditor(page: Page): Promise<void> {
  await page.locator('.modal-footer').getByRole('button', { name: 'Apply', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
}

test('GUI editors author precise axis moves, frames, label positions and clipped glue regions', { timeout: 60000 }, async () => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'The authoring controls require installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-assembly-editors-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let frontend: ViteDevServer | undefined, browser: Browser | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const solid = (id: number, name: string, x: number): string => `<object id="${id}" name="${name}"><mesh><vertices><vertex x="${x}" y="0" z="0"/><vertex x="${x + 10}" y="0" z="0"/><vertex x="${x}" y="10" z="0"/><vertex x="${x}" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object>`;
    const xml = `<model unit="millimeter"><resources>${solid(1, 'Tube A', 0)}${solid(2, 'Tube B', 20)}</resources><build><item objectid="1"/><item objectid="2"/></build></model>`;
    const imported = await fetch(`${base}/api/import?name=Axis Assembly.3mf`, { method: 'POST', body: zipSync({ '3D/3dmodel.model': strToU8(xml) }) }); assert.equal(imported.status, 200);
    let project = await imported.json() as Project;
    const ids = project.model.parts.map(part => part.id);
    project.model.constructionAxes = [
      { id: 'axis-left', name: 'Pivot Axis', componentPath: 'Left:1', nativeToken: 'left-axis', origin: [0, 0, 0], direction: [.6, .8, 0], extent: [-20, 20], visible: false, partIds: ids },
      { id: 'axis-right', name: 'Pivot Axis', componentPath: 'Right:1', nativeToken: 'right-axis', origin: [0, 0, 0], direction: [-.6, .8, 0], extent: [-20, 20], visible: false, partIds: [] },
    ];
    const saved = await fetch(`${base}/api/projects/${project.id}`, { ...post({ expectedRevision: project.revision, project }), method: 'PUT' }); assert.equal(saved.status, 200); project = await saved.json() as Project;
    const added = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'step.add', name: 'Assembly operation', parts: ids }] })); assert.equal(added.status, 200); project = (await added.json() as { project: Project }).project;
    const step = project.steps[0], initialPoses = Object.fromEntries(project.model.parts.map(part => [part.id, { position: [part.home.position[0] + 6, part.home.position[1] + 8, part.home.position[2]], quaternion: part.home.quaternion }]));
    const initialized = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'frame.update', stepId: step.id, frameId: step.frames[0].id, patch: { poses: initialPoses } }] })); assert.equal(initialized.status, 200); project = (await initialized.json() as { project: Project }).project;
    const untouchedEnd = structuredClone(project.steps[0].frames[1]);
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } }); await frontend.listen();
    const url = frontend.resolvedUrls?.local[0]; assert.ok(url);
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await page.locator(`[data-step="${step.id}"] h3`).click();
    await page.locator('#searchButton').click(); await page.getByLabel('Search parts', { exact: true }).fill('Tube');
    await page.locator(`#partTree [data-part="${ids[0]}"]`).click(); await page.locator(`#partTree [data-part="${ids[1]}"]`).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Move along axis…', exact: true }).click();
    await page.getByLabel('Construction axis', { exact: true }).selectOption({ label: 'Pivot Axis — Left:1' });
    await page.getByLabel('Offset from assembly position', { exact: true }).fill('50'); await applyEditor(page);
    let current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    for (const part of project.model.parts) assert.deepEqual(current.steps[0].frames[0].poses[part.id], { position: [part.home.position[0] + 30, part.home.position[1] + 40, part.home.position[2]], quaternion: part.home.quaternion });
    assert.deepEqual(current.steps[0].frames[1], untouchedEnd);

    const target = current.steps[0].frames[0].poses[ids[0]].position;
    const camera: Camera = { eye: [target[0] + 40.123456789, target[1] - 65.234567891, target[2] + 40.345678912], target: [...target], up: [0, 0, 1], margin: 1.7 };
    await page.getByRole('button', { name: 'Frame settings…', exact: true }).click();
    await page.getByLabel('Frame name', { exact: true }).fill('Coat shaft contact surfaces');
    await page.getByLabel('Completed-step hold', { exact: true }).fill('2.5');
    await fillVector(page, 'Camera eye', camera.eye); await fillVector(page, 'Camera target', camera.target); await fillVector(page, 'Camera up', camera.up);
    await page.getByLabel('Camera margin', { exact: true }).fill('1.7'); await applyEditor(page);
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    assert.equal(current.steps[0].frames[0].name, 'Coat shaft contact surfaces'); assert.equal(current.steps[0].frames[0].duration, 2.5); assert.deepEqual(current.steps[0].frames[0].camera, camera);
    await page.getByRole('button', { name: 'Label positions…', exact: true }).click();
    await page.getByLabel('Label 1 X', { exact: true }).fill('-260'); await page.getByLabel('Label 1 Y', { exact: true }).fill('-170');
    await page.getByLabel('Label 2 X', { exact: true }).fill('15'); await page.getByLabel('Label 2 Y', { exact: true }).fill('45'); await applyEditor(page);
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current); assert.deepEqual(current.settings.labelOffsets[ids[0]], [-260, -170]); assert.deepEqual(current.settings.labelOffsets[ids[1]], [15, 45]);

    await page.locator('[data-tool="glue"]').click(); await page.locator('#glueMode').selectOption('face'); await page.locator('#anchorTarget').selectOption('face');
    const click = await page.evaluate(id => {
      const view = window.manualStudio.view, mesh = view.meshes.get(id); if (!mesh) throw new Error('Missing fixture body.');
      const positions = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex(); if (!index) throw new Error('Missing fixture triangles.');
      const point = mesh.position.clone().set(0, 0, 0);
      for (let corner = 3; corner < 6; corner++) { const vertex = index.getX(corner); point.x += positions.getX(vertex) / 3; point.y += positions.getY(vertex) / 3; point.z += positions.getZ(vertex) / 3; }
      mesh.localToWorld(point); point.project(view.camera); const box = view.renderer.domElement.getBoundingClientRect();
      return { x: box.left + (point.x + 1) * box.width / 2, y: box.top + (1 - point.y) * box.height / 2 };
    }, ids[0]);
    await page.mouse.click(click.x, click.y); await page.locator('.note-editor').waitFor({ state: 'visible' });
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    const originalNote = current.steps[0].frames[0].notes[0], originalRegion = originalNote.anchors[0].region; assert.ok(originalRegion);
    assert.equal(originalNote.color, '#8c91b5', 'New glue must use the selected muted blue-violet color.');
    await page.locator('[data-edit-region="0"]').click();
    await page.getByLabel('Region type', { exact: true }).selectOption('band');
    const center: Vec3 = [1.23456789, 2.34567891, -3.45678912];
    await fillVector(page, 'Region center', center); await fillVector(page, 'Region axis', [.6, .8, 0]);
    await page.getByLabel('Band width', { exact: true }).fill('14.451965'); await page.getByLabel('Region radius', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Add clipping plane', exact: true }).click();
    await page.getByLabel('Clipping plane 1 axis', { exact: true }).selectOption('x');
    await page.getByLabel('Clipping plane 1 keep side', { exact: true }).selectOption('below');
    await page.getByLabel('Clipping plane 1 position', { exact: true }).fill('40.77787697315216'); await applyEditor(page);
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    let region = current.steps[0].frames[0].notes[0].anchors[0].region; assert.ok(region);
    assert.deepEqual(region.triangles, originalRegion.triangles); assert.deepEqual(region.center, center); assert.deepEqual(region.axis, [.6, .8, 0]);
    assert.equal(region.width, 14.451965); assert.equal(region.radius, 2); assert.deepEqual(region.clipPlanes, [{ normal: [1, 0, 0], constant: -40.77787697315216 }]);
    await page.locator('[data-edit-region="0"]').click(); await page.getByLabel('Clipping plane 1 keep side', { exact: true }).selectOption('above'); await applyEditor(page);
    await page.getByRole('button', { name: 'Placement…', exact: true }).click();
    await page.getByLabel('Offset X', { exact: true }).fill('20'); await page.getByLabel('Offset Y', { exact: true }).fill('-220'); await applyEditor(page);
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    region = current.steps[0].frames[0].notes[0].anchors[0].region; assert.ok(region);
    assert.deepEqual(region.clipPlanes, [{ normal: [-1, 0, 0], constant: 40.77787697315216 }]);
    assert.deepEqual(current.steps[0].frames[0].notes[0].offset, [20, -220]); assert.deepEqual(current.steps[0].frames[1], untouchedEnd);
    await page.route('**/api/projects/*/commands', async route => {
      const body: unknown = route.request().postDataJSON();
      if (body && typeof body === 'object' && 'commands' in body && Array.isArray(body.commands) && body.commands.some((command: unknown) => command && typeof command === 'object' && 'patch' in command && command.patch && typeof command.patch === 'object' && 'text' in command.patch)) await new Promise(resolve => setTimeout(resolve, 150));
      await route.continue();
    });
    await page.locator('#noteText').fill('Keep this instruction during rapid color and placement edits.'); await page.locator('#noteText').press('Tab');
    await page.locator('#editNoteColor').fill('#8791b6'); await page.locator('#editNoteBackground [data-preset-color="#292d34"]').click();
    assert.equal(await page.locator('#noteSize').count(), 0, 'Glue dimensions are edited per surface region.');
    await page.getByRole('button', { name: 'Placement…', exact: true }).click();
    await page.getByLabel('Offset X', { exact: true }).fill('100'); await page.getByLabel('Offset Y', { exact: true }).fill('-260'); await applyEditor(page);
    await page.waitForFunction(() => window.manualStudio.getProject()?.steps[0].frames[0].notes[0].text === 'Keep this instruction during rapid color and placement edits.');
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    const finalNote = current.steps[0].frames[0].notes[0];
    assert.equal(finalNote.color, '#8791b6'); assert.equal(finalNote.background, '#292d34'); assert.equal(finalNote.size, originalNote.size); assert.deepEqual(finalNote.offset, [100, -260]); assert.deepEqual(errors, []);

    await page.locator('#finishNote').click();
    await page.locator('#settingsButton').click();
    await page.locator('#optionSnap').check();
    await applyEditor(page);
    await page.locator('#settingsButton').click();
    assert.equal(await page.locator('#optionSnap').isChecked(), true);
    await page.locator('#optionAxes').check();
    await applyEditor(page);
    assert.equal(await page.evaluate(() => window.manualStudio.view.snapEnabled), true);

    await page.locator('#saveFrame').click();
    await page.waitForFunction(() => window.manualStudio.getProject()?.steps[0].frames[0].image?.startsWith('data:image/jpeg'));
    await page.locator('#labelSettings').click();
    await page.locator('#cameraMargin').fill('1.75');
    await applyEditor(page);
    current = await page.evaluate(() => window.manualStudio.getProject());
    assert.equal(current?.steps[0].frames[0].camera?.margin, 1.75);
    assert.equal(current?.steps[0].frames[0].image, undefined, 'A saved camera edit invalidates the previous capture over HTTP.');
    await page.locator('#labelSettings').click();
    assert.equal(await page.locator('#cameraMargin').inputValue(), '1.75');
    await page.locator('.modal-footer').getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.locator('#anchorTarget').selectOption('point');
    await page.locator('[data-tool="text"]').click();
    assert.equal(await page.locator('#noteColor').inputValue(), '#23a92e', 'New text-note leaders use the annotation green.');
    await page.locator('[data-tool="circle"]').click();
    const circleCenter = await page.evaluate(id => {
      const view = window.manualStudio.view, mesh = view.meshes.get(id); if (!mesh) throw new Error('Missing circle target.');
      const positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.getIndex(); if (!indices) throw new Error('Missing circle target triangles.');
      const point = mesh.position.clone().set(0, 0, 0);
      for (let corner = 3; corner < 6; corner++) { const vertex = indices.getX(corner); point.x += positions.getX(vertex) / 3; point.y += positions.getY(vertex) / 3; point.z += positions.getZ(vertex) / 3; }
      mesh.localToWorld(point).project(view.camera); const bounds = view.renderer.domElement.getBoundingClientRect();
      return { x: bounds.left + (point.x + 1) * bounds.width / 2, y: bounds.top + (1 - point.y) * bounds.height / 2 };
    }, ids[0]);
    await page.mouse.click(circleCenter.x, circleCenter.y);
    await page.locator('.note-editor').waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => window.manualStudio.getProject()))!.steps[0].frames[0].notes.at(-1)?.color, '#23a92e');
    await page.locator('#finishNote').click();
    const outline = await page.evaluate(id => {
      const api = window.manualStudio, view = api.view, session = api.getSession(), mesh = view.meshes.get(id);
      const note = api.getProject()?.steps[0].frames.find(frame => frame.id === session.frameId)?.notes.find(item => item.kind === 'circle');
      if (!mesh || !note) throw new Error('Missing saved Circle note.');
      const anchor = note.anchors[0], box = view.renderer.domElement.getBoundingClientRect();
      const center = mesh.localToWorld(mesh.position.clone().fromArray(anchor.point));
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        const point = center.clone().set(Math.cos(angle) * note.size, Math.sin(angle) * note.size, 0).applyQuaternion(view.camera.quaternion).add(center).project(view.camera);
        const x = box.left + (point.x + 1) * box.width / 2, y = box.top + (1 - point.y) * box.height / 2;
        if (document.elementFromPoint(x, y) === view.renderer.domElement) return { x, y, noteId: note.id };
      }
      throw new Error('No Circle outline point is visible on the canvas.');
    }, ids[0]);
    assert.equal(await page.locator('.surface-note[data-note-id="' + outline.noteId + '"]').count(), 0, 'This note only has an outline.');
    await page.mouse.click(outline.x, outline.y);
    await page.locator('.note-editor').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#noteSize').inputValue(), '5');
    await page.locator('#deleteNote').click();
    await page.waitForFunction(id => !window.manualStudio.getProject()?.steps[0].frames[0].notes.some(note => note.id === id), outline.noteId);

    const shapePresets = ['#d53d40', '#f09f13', '#23a92e', '#3f82f0', '#1d202d', '#7d7f86', '#ffffff'];
    const selectedColors = ['#d53d40', '#3f82f0', '#f09f13'];
    for (const [index, kind] of ['rectangle', 'circle', 'arrow'].entries()) {
      await page.locator(`[data-tool="${kind}"]`).click();
      assert.equal(await page.locator('#noteColor').getAttribute('role'), 'group');
      assert.deepEqual(await page.locator('#noteColor button').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-preset-color'))), shapePresets);
      await page.locator(`#noteColor [data-preset-color="${selectedColors[index]}"]`).click();
      await page.locator('#noteBackground [data-preset-color="#234679"]').click();
      await page.mouse.click(circleCenter.x, circleCenter.y);
      if (kind === 'arrow') await page.mouse.click(circleCenter.x + 4, circleCenter.y);
      await page.locator('.note-editor').waitFor({ state: 'visible' });
      current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
      const created = current.steps[0].frames[0].notes.at(-1)!;
      assert.equal(created.kind, kind); assert.equal(created.color, selectedColors[index]); assert.equal(created.background, '#234679');
      assert.equal(await page.locator('.note-editor input[type="color"]').count(), 0);
      await page.locator('#noteText').fill(`White ${kind} caption`);
      await page.locator('#editNoteColor [data-preset-color="#23a92e"]').click();
      await page.locator('#editNoteBackground [data-preset-color="#682b30"]').click();
      await page.waitForFunction(id => {
        const note = window.manualStudio.getProject()?.steps[0].frames[0].notes.find(note => note.id === id);
        return note?.color === '#23a92e' && note.background === '#682b30' && note.text.startsWith('White');
      }, created.id);
      assert.equal(await page.locator('#noteColor [data-preset-color="#23a92e"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#editNoteBackground [data-preset-color="#682b30"]').getAttribute('aria-pressed'), 'true');
      const revision = (await page.evaluate(() => window.manualStudio.getProject()))!.revision;
      await page.locator('#editNoteColor [data-preset-color="#23a92e"]').click();
      assert.equal((await page.evaluate(() => window.manualStudio.getProject()))!.revision, revision);
      const caption = page.locator(`.surface-note[data-note-id="${created.id}"]`);
      assert.deepEqual(await caption.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor })), { color: 'rgb(242, 242, 242)', background: 'rgb(104, 43, 48)' });
      const backgroundColors = await page.locator('#editNoteBackground button').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-preset-color')!));
      const luminance = (hex: string): number => {
        const linear = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      };
      for (const background of backgroundColors) assert.ok((luminance('#f2f2f2') + .05) / (luminance(background) + .05) >= 7, `${background} must keep white captions legible.`);
      await page.locator('#finishNote').click();
    }
    current = await page.evaluate(() => window.manualStudio.getProject()); assert.ok(current);
    assert.deepEqual(current.steps[0].frames[0].notes[0], finalNote, 'Shape presets retain the authored glue appearance and anchors.');
    assert.deepEqual(current.steps[0].frames[1], untouchedEnd);
    await page.locator('[data-tool="glue"]').click();
    assert.equal(await page.locator('#noteColor').inputValue(), '#8c91b5', 'Shape choices do not replace the default glue color.');
    await page.locator('[data-tool="select"]').click();
    await page.locator('#undoButton').click();
    await page.waitForFunction(() => window.manualStudio.getProject()?.steps[0].frames[0].notes.at(-1)?.background === '#234679');
    await page.locator('#redoButton').click();
    await page.waitForFunction(() => window.manualStudio.getProject()?.steps[0].frames[0].notes.at(-1)?.background === '#682b30');
    const savedNotes = (await page.evaluate(() => window.manualStudio.getProject()))!.steps[0].frames[0].notes;
    await page.reload(); await page.waitForFunction(() => window.manualStudio?.getProject() && !document.querySelector('.busy-overlay'));
    assert.deepEqual((await page.evaluate(() => window.manualStudio.getProject()))!.steps[0].frames[0].notes, savedNotes);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await frontend?.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-assembly-editors-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
