import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright-core';
import { findBrowser, mediaCommand } from '../tools/dependencies.ts';
import { createServer, type ViteDevServer } from 'vite';
import { strFromU8, unzipSync } from 'fflate';
import { renderInBrowser } from '../server/render.ts';
import { DEFAULT_NOTE_COLOR } from '../shared/render-style.ts';
import type { Anchor, Camera, Command, DisplayMode, Note, Project } from '../shared/types.ts';
import { transactionModel } from './fixtures/assembly-transaction.ts';

const execute = promisify(execFile);
interface PdfLine { text: string; font: string; baseline: number }
interface Pixel { x: number; y: number }
interface PdfPage { lines: PdfLine[]; imageHeights: number[]; imageColors: number[][][] }
declare global { interface Window { manualStudioPdfPages: PdfPage[]; manualStudioPdfSamplePoints?: Pixel[] } }
interface RenderJob { id: string; display: DisplayMode; result?: { path?: string; url?: string; error?: string } }

test('GUI documents and isolated renders retain authored appearance and full PDF instructions', { timeout: 120000 }, async context => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'Chrome is required for the document export check.');
  const ffmpeg = await mediaCommand('ffmpeg');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-export-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); });
      api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk))));
    });
    const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const imported = await fetch(`${base}/api/import?name=Fixture%20Assembly.3mf`, { method: 'POST', body: Buffer.from(transactionModel(['Fixture', 'Pin', 'Cover', 'Support'])) });
    assert.equal(imported.status, 200);
    let project = await imported.json() as Project;
    const [reference, movingPart, covered, support] = project.model.parts;
    const route = `${base}/api/projects/${project.id}`;
    const edit = async (commands: Command[]): Promise<void> => {
      const response = await fetch(`${route}/commands`, post({ expectedRevision: project.revision, commands }));
      assert.equal(response.status, 200, await response.clone().text());
      project = (await response.json() as { project: Project }).project;
    };
    await edit([{ type: 'step.add', name: 'Fit locating pin', parts: [movingPart.id, support.id] }]);
    const [step] = project.steps, [start, end] = step.frames;
    const camera: Camera = { eye: [39, -210, 95], target: [39, 0, 0], up: [0, 0, 1], margin: 1.25 };
    const description = ['Align the pin with the fixture.', '', ...Array.from({ length: 65 }, (_, index) => `Inspection ${index + 1}: check the locating surface for debris.`), '', 'Final acceptance: verify that the locating pin is flush.'].join('\n');
    const anchor: Anchor = { partId: movingPart.id, point: movingPart.bounds[0], normal: [0, -1, 0], target: 'point', triangle: 0 };
    const notes: Note[] = (['rectangle', 'circle'] as const).map((kind, index) => ({
      id: kind, kind, text: index ? 'Check alignment' : 'Seat the pin', color: DEFAULT_NOTE_COLOR, background: '#30343c', size: 7.5 + index * 6,
      anchors: [{ ...anchor, point: index ? [anchor.point[0] + 6, anchor.point[1], anchor.point[2]] : anchor.point }], offset: [index ? 25 : -90, -52],
    }));
    await edit([
      { type: 'settings.update', patch: { partVisibility: { [covered.id]: false }, showLabels: true } },
      { type: 'step.description', stepId: step.id, text: description },
      { type: 'frame.update', stepId: step.id, frameId: start.id, patch: { camera, duration: .2 } },
      { type: 'frame.update', stepId: step.id, frameId: end.id, patch: { camera, duration: .3, hidden: [support.id] } },
      ...notes.map(note => ({ type: 'note.put' as const, stepId: step.id, frameId: end.id, note })),
    ]);
    const updateSession = async (display: DisplayMode): Promise<void> => {
      const response = await fetch(`${route}/session`, { ...post({ stepId: step.id, frameId: end.id, display }), method: 'PUT' });
      assert.equal(response.status, 200);
    };
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base, '/exports': base } } });
    await frontend.listen();
    const appUrl = new URL(frontend.resolvedUrls!.local[0]).origin;
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      window.manualStudioPdfPages = [];
      const pages = new WeakMap<HTMLCanvasElement, PdfPage>();
      const record = (canvas: HTMLCanvasElement): PdfPage => {
        const painted = pages.get(canvas) ?? { lines: [], imageHeights: [], imageColors: [] };
        pages.set(canvas, painted);
        return painted;
      };
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (value, x, y, maxWidth) {
        if (this.canvas.width === 1240 && this.canvas.height === 1754) {
          record(this.canvas).lines.push({ text: value, font: this.font, baseline: y });
        }
        if (maxWidth === undefined) fillText.call(this, value, x, y);
        else fillText.call(this, value, x, y, maxWidth);
      };
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...coordinates: number[]) {
        if (this.canvas.width === 1240 && this.canvas.height === 1754 && image instanceof HTMLCanvasElement && coordinates.length === 4) {
          record(this.canvas).imageHeights.push(coordinates[3]);
          const points = window.manualStudioPdfSamplePoints, source = image.getContext('2d');
          if (source && points) record(this.canvas).imageColors.push(points.map(point => [...source.getImageData(point.x, point.y, 1, 1).data].slice(0, 3)));
        }
        Reflect.apply(drawImage, this, [image, ...coordinates]);
      };
      const dataUrl = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
        const painted = pages.get(this);
        if (type === 'image/jpeg' && painted) window.manualStudioPdfPages.push(painted);
        return dataUrl.call(this, type, quality);
      };
    });
    await page.goto(`${appUrl}/?project=${project.id}`);
    await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await updateSession('xray');
    await page.waitForFunction(id => window.manualStudio.getSession().frameId === id, end.id);
    const previewAt = (video = false) => page.evaluate(async ({ ids, video }) => {
      const { view } = window.manualStudio;
      const capture = async () => {
        const image = view.capture();
        const centers = ids.map(id => {
          const mesh = view.meshes.get(id)!, positions = mesh.geometry.getAttribute('position'), point = mesh.position.clone().set(0, 0, 0), vertex = point.clone();
          for (let index = 0; index < positions.count; index++) point.add(vertex.fromBufferAttribute(positions, index));
          mesh.localToWorld(point.divideScalar(positions.count)).project(view.camera);
          return { x: (point.x + 1) * image.width / 2, y: (1 - point.y) * image.height / 2 };
        });
        const ctx = image.getContext('2d')!;
        return { url: video ? '' : image.toDataURL(), centers, colors: centers.map(({ x, y }) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)), background: [...ctx.getImageData(20, 20, 1, 1).data].slice(0, 3) };
      };
      return video ? view.withVideoSize(capture) : capture();
    }, { ids: [reference.id, movingPart.id, covered.id, support.id], video });
    const preview = await previewAt(), videoPreview = await previewAt(true);
    const [ghost, body, hiddenByEye, hiddenByFrame] = preview.colors;
    assert.notDeepEqual(ghost, preview.background, 'The preview must include a visible reference part.');
    assert.ok(ghost[0] < body[0], 'The reference part must be more transparent than the step part.');
    assert.deepEqual(hiddenByEye, preview.background);
    assert.deepEqual(hiddenByFrame, preview.background);

    const download = async (kind: 'Markdown' | 'PDF'): Promise<Buffer> => {
      await page.locator('#exportButton').click();
      const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Export ${kind}`, exact: true }).click()]);
      return readFile(await file.path());
    };
    const markdown = unzipSync(await download('Markdown'));
    assert.equal(strFromU8(markdown['Assembly Guide.md']).includes(description), true);
    assert.ok(Buffer.from(markdown['images/step-01-frame-2.png']).equals(Buffer.from(preview.url.split(',')[1], 'base64')), 'The saved frame must retain the camera, reference parts, and annotation rendering.');
    const pdf = await download('PDF');
    const painted = await page.evaluate(() => window.manualStudioPdfPages);
    assert.match(pdf.toString('latin1'), /%PDF-/);
    assert.equal(painted.length, 4, 'The cover, frame page, and two continuation pages must all be written.');
    assert.ok(painted.slice(2).every(sheet => sheet.lines.some(line => line.text.includes('continued'))));
    const instructions = painted.flatMap(sheet => sheet.lines.filter(line => line.font.startsWith('22px')));
    assert.deepEqual(instructions.map(line => line.text), description.split('\n'));
    assert.ok(instructions.every(line => line.baseline >= 180 && line.baseline <= 1650));

    const requested = await fetch(`${base}/api/render`, post({ projectId: project.id, kind: 'mp4', renderer: 'external' }));
    assert.equal(requested.status, 200);
    const job = await requested.json() as RenderJob;
    assert.equal(job.display, 'xray');
    await updateSession('current');
    await renderInBrowser(appUrl, project.id, job.id);
    const completed = await (await fetch(`${base}/api/render/${job.id}`)).json() as RenderJob;
    assert.equal(completed.display, 'xray');
    assert.ok(completed.result?.path, completed.result?.error);
    const mp4 = completed.result.path;
    const { stdout } = await execute(await mediaCommand('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration,nb_frames,r_frame_rate', '-of', 'json', mp4], { windowsHide: true });
    assert.deepEqual(JSON.parse(stdout).streams, [{ width: 1920, height: 1080, r_frame_rate: '60/1', duration: '4.000000', nb_frames: '240' }]);
    const videoFrameColors = async (filename: string, time: string, points: Pixel[]) => {
      const frame = (await execute(ffmpeg, ['-v', 'error', '-ss', time, '-i', filename, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { windowsHide: true, encoding: 'buffer' })).stdout;
      return page.evaluate(async ({ png, points }) => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        return points.map(({ x, y }) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
      }, { png: frame.toString('base64'), points });
    };
    const videoColors = await videoFrameColors(mp4, '3.9', videoPreview.centers);
    videoColors.forEach((color, index) => color.forEach((channel, component) => {
      assert.ok(Math.abs(channel - videoPreview.colors[index][component]) <= 8, `Video visibility must match the saved preview at sample ${index}.`);
    }));
    assert.deepEqual(await (await fetch(route)).json(), project, 'Exports must preserve all authored model, visibility, camera and annotation data.');

    const word = 'clearance';
    const fullLine = await page.evaluate(word => {
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = '22px Segoe UI';
      let line = word;
      while (context.measureText(`${line} ${word}`).width <= 1090) line += ` ${word}`;
      return line;
    }, word);
    const prefix = ['Clean the locating surfaces.', 'Align the pin with the fixture.', 'Seat the pin by hand.', 'Check the fit.', 'Inspect the joint.'];
    const exportDescription = async (text: string): Promise<PdfPage[]> => {
      await edit([{ type: 'step.description', stepId: step.id, text }]);
      await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, project.revision);
      await page.evaluate(() => { window.manualStudioPdfPages = []; });
      await download('PDF');
      return page.evaluate(() => window.manualStudioPdfPages);
    };
    const descriptionLines = (sheet: PdfPage): string[] => sheet.lines.filter(line => line.font.startsWith('22px')).map(line => line.text);
    const fitted = await exportDescription([...prefix, `${fullLine} ${word}`].join('\n'));
    assert.equal(fitted.length, 2, 'A one-word spill after two images should fit on the frame page.');
    assert.deepEqual(descriptionLines(fitted[1]), [...prefix, fullLine, word]);
    const [firstHeight, secondHeight] = fitted[1].imageHeights;
    assert.equal(firstHeight, 600);
    assert.ok(secondHeight < firstHeight && secondHeight >= firstHeight * .95);

    const split = await exportDescription([...prefix.slice(0, 3), `${fullLine} ${fullLine} ${fullLine} ${word}`, 'Confirm that the pin is flush.'].join('\n'));
    assert.equal(split.length, 3);
    assert.deepEqual(split[1].imageHeights, [600, 600]);
    assert.deepEqual(descriptionLines(split[1]), [...prefix.slice(0, 3), fullLine, fullLine]);
    assert.deepEqual(descriptionLines(split[2]), [fullLine, word, 'Confirm that the pin is flush.'], 'The last word should stay with another line of its paragraph.');

    await context.test('keyframe X-Ray exposes an obscured step part and survives play, export and archive reopen', async () => {
      const response = await fetch(`${base}/api/import?name=Service%20Fixture.3mf`, { method: 'POST', body: Buffer.from(transactionModel(['Working insert', 'Service cover', 'Unassigned reference'])) });
      assert.equal(response.status, 200);
      let fixture = await response.json() as Project;
      const [working, cover, outside] = fixture.model.parts;
      [working.color, cover.color, outside.color] = ['#16d72c', '#1b4ae9', '#f06bae'];
      const fixtureRoute = `${base}/api/projects/${fixture.id}`;
      const colored = await fetch(fixtureRoute, { ...post({ expectedRevision: fixture.revision, project: fixture }), method: 'PUT' });
      assert.equal(colored.status, 200); fixture = await colored.json() as Project;
      const frameCommands = async (commands: Command[]): Promise<void> => {
        const result = await fetch(`${fixtureRoute}/commands`, post({ expectedRevision: fixture.revision, commands }));
        assert.equal(result.status, 200, await result.clone().text());
        fixture = (await result.json() as { project: Project }).project;
      };
      const navigate = async (projectId: string): Promise<void> => {
        await page.goto(`${appUrl}/?project=${projectId}`);
        await page.waitForFunction(id => window.manualStudio.getProject()?.id === id && !document.querySelector('.busy-overlay'), projectId);
      };
      await frameCommands([{ type: 'step.add', name: 'Inspect the insert', parts: [working.id, cover.id] }]);
      const [fixtureStep] = fixture.steps, [first, last] = fixtureStep.frames;
      const poses = { [working.id]: working.home, [cover.id]: { ...cover.home, position: [working.home.position[0], working.home.position[1] - 12, working.home.position[2]] as [number, number, number] } };
      const viewCamera: Camera = { eye: [5, -195, 5], target: [5, 5, 5], up: [0, 0, 1], margin: 1.25 };
      await frameCommands([
        { type: 'frame.update', stepId: fixtureStep.id, frameId: first.id, patch: { poses, camera: viewCamera, duration: .2 } },
        { type: 'frame.update', stepId: fixtureStep.id, frameId: last.id, patch: { poses, camera: viewCamera, duration: .6 } },
      ]);
      await navigate(fixture.id);
      await page.locator(`[data-step="${fixtureStep.id}"] h3`).click();
      assert.equal(await page.locator('#displayMode').inputValue(), 'xray');
      await page.locator('#settingsButton').click();
      await page.getByLabel('Default assembly display').selectOption('current');
      await page.locator('.modal').getByRole('button', { name: 'Apply', exact: true }).click();
      await page.locator('.modal').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#displayMode').inputValue(), 'current');
      const sample = async (video = false) => page.evaluate(async ({ ids, video }) => {
        const { view } = window.manualStudio;
        const capture = async () => {
          const canvas = view.capture(), ctx = canvas.getContext('2d')!;
          const points = [ids[0], ids[2]].map(id => {
            const mesh = view.meshes.get(id)!, point = mesh.position.clone().set(-2.5, -2.5, -2.5);
            mesh.localToWorld(point).project(view.camera);
            return { x: (point.x + 1) * canvas.width / 2, y: (1 - point.y) * canvas.height / 2 };
          });
          const colors = points.map(({ x, y }) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
          const background = [...ctx.getImageData(20, 20, 1, 1).data].slice(0, 3);
          const parts = ids.map(id => { const mesh = view.meshes.get(id)!; return [mesh.visible, mesh.material.opacity]; });
          const bounds = view.renderer.domElement.getBoundingClientRect();
          return { points, colors, background, parts, screen: { x: bounds.x + points[0].x, y: bounds.y + points[0].y } };
        };
        return video ? view.withVideoSize(capture) : capture();
      }, { ids: [working.id, cover.id, outside.id], video });
      const opaque = await sample();
      const opaqueVideo = await sample(true);
      assert.deepEqual(opaque.parts, [[true, 1], [true, 1], [false, 1]]);
      assert.ok(opaque.colors[0][2] > opaque.colors[0][1] + 35, 'The opaque front cover must obscure the green insert.');

      await page.mouse.click(opaque.screen.x, opaque.screen.y, { button: 'right' });
      await page.getByRole('button', { name: 'X-Ray in this keyframe', exact: true }).click();
      await page.waitForFunction(id => window.manualStudio.getProject()?.steps[0].frames[0].xrayPartIds?.includes(id), cover.id);
      await page.evaluate(() => window.manualStudio.selectParts([]));
      const translucent = await sample();
      const translucentVideo = await sample(true);
      assert.deepEqual(translucent.parts, [[true, 1], [true, .15], [false, 1]]);
      assert.ok(translucent.colors[0][1] > translucent.colors[0][2] + 35, 'The insert must be visible through the translucent cover.');
      assert.deepEqual(translucent.colors[1], translucent.background, 'The same view must exclude the off-step reference.');

      const coverRow = page.locator(`#partTree [data-part="${cover.id}"]`);
      await coverRow.click({ button: 'right' });
      await page.getByRole('button', { name: 'Restore opacity in this keyframe', exact: true }).click();
      await page.waitForFunction(() => window.manualStudio.getProject()?.steps[0].frames[0].xrayPartIds?.length === 0);
      fixture = await page.evaluate(() => window.manualStudio.getProject()!);
      await frameCommands([{ type: 'frame.update', stepId: fixtureStep.id, frameId: first.id, patch: { xrayPartIds: [cover.id], hidden: [cover.id] } }]);
      await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, fixture.revision);
      await page.evaluate(() => window.manualStudio.selectParts([]));
      const uncovered = await sample();
      assert.equal(uncovered.parts[1][0], false, 'A frame-hidden cover stays hidden even when listed for X-Ray.');
      assert.notDeepEqual(uncovered.colors[0], translucent.colors[0], 'The X-Ray cover contributes to the color over the insert.');
      await frameCommands([{ type: 'frame.update', stepId: fixtureStep.id, frameId: first.id, patch: { hidden: [] } }]);
      await page.waitForFunction(revision => window.manualStudio.getProject()?.revision === revision, fixture.revision);

      await page.locator('#playSlider').fill('0.50');
      assert.deepEqual((await sample()).colors, translucent.colors, 'Scrubbing within the transition keeps the start frame X-Ray.');
      const playing = await page.evaluate(id => {
        document.querySelector<HTMLButtonElement>('#playStep')!.click();
        const { view, getSession } = window.manualStudio;
        return { playing: getSession().playing, opacity: view.meshes.get(id)?.material.opacity };
      }, cover.id);
      assert.deepEqual(playing, { playing: true, opacity: .15 });
      await page.waitForFunction(id => { const state = window.manualStudio.getSession(); return !state.playing && state.frameId === id; }, last.id);
      assert.deepEqual((await sample()).colors, opaque.colors, 'The next frame restores the opaque cover.');

      await page.evaluate(points => { window.manualStudioPdfSamplePoints = points; window.manualStudioPdfPages = []; }, translucent.points);
      assert.match((await download('PDF')).toString('latin1'), /%PDF-/);
      const pdfColors = await page.evaluate(() => window.manualStudioPdfPages.flatMap(sheet => sheet.imageColors));
      assert.deepEqual(pdfColors, [translucent.colors, opaque.colors], 'The PDF uses each keyframe X-Ray and excludes the outside part.');

      const archive = await (await fetch(`${fixtureRoute}/archive`)).arrayBuffer();
      const reopen = await fetch(`${base}/api/open-archive`, { method: 'POST', body: archive });
      assert.equal(reopen.status, 200);
      const restored = await reopen.json() as Project;
      assert.equal(restored.settings.defaultDisplayMode, 'current');
      assert.deepEqual(restored.steps, fixture.steps);
      const newJob = await fetch(`${base}/api/render`, post({ projectId: restored.id, kind: 'mp4', renderer: 'external' }));
      assert.equal(newJob.status, 200);
      const newJobInfo = await newJob.json() as RenderJob;
      assert.equal(newJobInfo.display, 'current', 'An archive with no session uses the saved project default for CLI exports.');
      await renderInBrowser(appUrl, restored.id, newJobInfo.id);
      const video = await (await fetch(`${base}/api/render/${newJobInfo.id}`)).json() as RenderJob;
      assert.ok(video.result?.path, video.result?.error);
      for (const [time, preview] of [['3.7', translucentVideo], ['4.2', opaqueVideo]] as const) {
        const colors = await videoFrameColors(video.result.path, time, preview.points);
        colors.forEach((color, index) => color.forEach((channel, component) => {
          assert.ok(Math.abs(channel - preview.colors[index][component]) <= 10, `MP4 pixels at ${time}s must match the preview.`);
        }));
      }
      await navigate(restored.id);
      await page.locator(`[data-step="${fixtureStep.id}"] h3`).click();
      assert.equal(await page.locator('#displayMode').inputValue(), 'current');
      assert.deepEqual((await sample()).colors, translucent.colors);
      assert.deepEqual(await (await fetch(fixtureRoute)).json(), fixture, 'Exports and archive reopen leave the source document intact.');

      await frameCommands([{ type: 'step.members', stepId: fixtureStep.id, partIds: [working.id] }]);
      assert.deepEqual(fixture.steps[0].frames[0].xrayPartIds, [], 'Removing a step member drops its saved X-Ray reference.');
    });
  } finally {
    await browser?.close(); await frontend?.close(); if (api.exitCode === null) { api.kill(); await once(api, 'close'); }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-export-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
