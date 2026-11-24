import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright-core';
import { findBrowser, mediaCommand } from '../tools/dependencies.ts';
import { createServer, type ViteDevServer } from 'vite';
import { renderInBrowser } from '../server/render.ts';
import { easeMotion, playbackPlan } from '../shared/playback.ts';
import type { Camera, Command, MotionTrack, Note, Pose, Project, Vec3 } from '../shared/types.ts';
import { videoSegments } from '../src/video.ts';
import { transactionModel } from './fixtures/assembly-transaction.ts';

interface Box { x: number; y: number; width: number; height: number }
interface LabelBox extends Box { id: string; anchorX: number; anchorY: number }
interface Layout { labels: LabelBox[]; drawn: Box[]; strokes: number[] }
declare global {
  interface Window {
    labelLayout: () => Layout;
    exportedLabelLayouts: Layout[];
    recordLabelExport: boolean;
    labelClock: number;
    restoreLabelClock: () => void;
  }
}

test('moving labels avoid collisions and use the same eased positions in playback, seeking and MP4', { timeout: 120000 }, async () => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath);
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-label-motion-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); });
      api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk))));
    });
    const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const imported = await fetch(`${base}/api/import?name=Gauge%20Assembly.3mf`, { method: 'POST', body: Buffer.from(transactionModel(['Fixture', 'Guide pin', 'Gauge'])) });
    assert.equal(imported.status, 200);
    let project = await imported.json() as Project;
    const [fixture, pin, gauge] = project.model.parts, route = `${base}/api/projects/${project.id}`;
    const commands = async (...commands: Command[]): Promise<void> => {
      const response = await fetch(`${route}/commands`, post({ expectedRevision: project.revision, commands }));
      assert.equal(response.status, 200, await response.clone().text());
      project = (await response.json() as { project: Project }).project;
    };
    const baseLabels = { showLabels: true, labelMode: 'part' as const, labelFontSize: 18, labelOffsets: { [gauge.id]: [25, -75] as [number, number] }, hiddenLabels: [fixture.id] };
    await commands({ type: 'settings.update', patch: baseLabels },
      { type: 'step.add', name: 'Insert the guide pin', parts: [fixture.id, pin.id] }, { type: 'step.add', name: 'Check the gauge', parts: [gauge.id] },
      { type: 'step.add', name: 'Inspect the locating face', parts: [gauge.id] }, { type: 'step.add', name: 'Guide the gauge through the opening', parts: [gauge.id, fixture.id, pin.id] });
    const [collision, authored, reveal, through] = project.steps, [collisionStart, collisionEnd] = collision.frames, [authoredStart, authoredEnd] = authored.frames;
    const [revealStart, revealEnd] = reveal.frames, revealDuration = 2;
    const [throughStart, throughEnd] = through.frames, waypoint = 'gauge-waypoint', approach = .45, departure = .55;
    const camera: Camera = { eye: [0, -300, 0], target: [0, 0, 0], up: [0, 0, 1], margin: 1.25 }, motionDuration = 101 / 60;
    const pose = (position: Vec3): Pose => ({ position, quaternion: [0, 0, 0, 1] });
    const note = (id: string, partId: string, text: string, offset: [number, number]): Note => ({ id, kind: 'text', text, offset, anchors: [{ partId, target: 'point', point: [0, 0, 0], normal: [0, -1, 0], triangle: 0 }], size: 4, color: '#23a92e', background: '#314257' });
    const instruction = note('guide-note', fixture.id, 'Align with the guide bore', [-50, -30]);
    const gaugeNote: Note = { ...note('gauge-note', gauge.id, 'Check the gauge clearance', [-240, 15]), kind: 'circle' };
    const revealNote = note('locating-note', gauge.id, 'Check the locating face\nbefore tightening the clamp.', [-300, -500]);
    revealNote.color = '#e03ad1';
    revealNote.anchors[0].point = [10, 0, 0];
    const throughNote = note('travel-note', gauge.id, 'Keep the gauge aligned', [-90, -180]);
    const couplerNote = note('link-note', pin.id, 'Keep both pivots engaged', [32, 32]);
    const swing: MotionTrack = { kind: 'four-bar', angleDegrees: -30,
      input: { partIds: [fixture.id], axis: { origin: [95, 0, 80], direction: [0, 1, 0] }, joint: { point: [-140, 0, 20], partId: fixture.id } },
      output: { partIds: [gauge.id], axis: { origin: [0, 0, 80], direction: [0, 1, 0] }, joint: { point: [0, 0, 0], partId: gauge.id } },
      coupler: { partIds: [pin.id] },
    };
    const throughPoses = (position: Vec3) => ({ [gauge.id]: pose(position), [fixture.id]: pose([95, 0, 80]), [pin.id]: pose([-45, 0, 100]) });
    const throughLabels = { ...baseLabels, hiddenLabels: [fixture.id, pin.id] };
    const shiftedCamera = (z: number): Camera => ({ ...camera, eye: [0, -300, z], target: [0, 0, z] });
    await commands(
      { type: 'frame.update', stepId: collision.id, frameId: collisionStart.id, patch: { camera, duration: .1, poses: { [fixture.id]: pose([0, 0, 0]), [pin.id]: pose([-68, 0, 0]) } } },
      { type: 'frame.update', stepId: collision.id, frameId: collisionEnd.id, patch: { camera, duration: motionDuration, poses: { [fixture.id]: pose([0, 0, 0]), [pin.id]: pose([68, 0, 0]) } } },
      { type: 'note.put', stepId: collision.id, frameId: collisionStart.id, note: instruction }, { type: 'note.put', stepId: collision.id, frameId: collisionEnd.id, note: instruction },
      { type: 'frame.update', stepId: authored.id, frameId: authoredStart.id, patch: { camera, duration: .1, poses: { [gauge.id]: pose([0, 0, 0]) } } },
      { type: 'frame.update', stepId: authored.id, frameId: authoredEnd.id, patch: { camera, duration: motionDuration, poses: { [gauge.id]: pose([0, 0, 0]) }, labels: { ...baseLabels, labelOffsets: { [gauge.id]: [145, -115] } } } },
      { type: 'note.put', stepId: authored.id, frameId: authoredStart.id, note: gaugeNote }, { type: 'note.put', stepId: authored.id, frameId: authoredEnd.id, note: { ...gaugeNote, offset: [-300, 105] } },
      { type: 'frame.update', stepId: reveal.id, frameId: revealStart.id, patch: { camera: shiftedCamera(-60), duration: .1, poses: { [gauge.id]: pose([0, 0, 0]) } } },
      { type: 'frame.update', stepId: reveal.id, frameId: revealEnd.id, patch: { camera: shiftedCamera(60), duration: revealDuration, poses: { [gauge.id]: pose([0, 0, 0]) } } },
      { type: 'note.put', stepId: reveal.id, frameId: revealEnd.id, note: revealNote },
      { type: 'frame.add', stepId: through.id, afterId: throughStart.id, frameId: waypoint },
      { type: 'frame.update', stepId: through.id, frameId: throughStart.id, patch: { camera, duration: .1, poses: throughPoses([-40, 0, 80 - 40 * Math.sqrt(3)]), labels: throughLabels } },
      { type: 'frame.update', stepId: through.id, frameId: waypoint, patch: { camera: shiftedCamera(5), duration: approach, poses: throughPoses([0, 0, 0]), labels: throughLabels } },
      { type: 'frame.update', stepId: through.id, frameId: throughEnd.id, patch: { camera: shiftedCamera(14), duration: departure, poses: throughPoses([40, 0, 0]), labels: throughLabels } },
      { type: 'note.put', stepId: through.id, frameId: throughStart.id, note: throughNote },
      { type: 'note.put', stepId: through.id, frameId: waypoint, note: { ...throughNote, offset: [-60, -160] } },
      { type: 'note.put', stepId: through.id, frameId: throughEnd.id, note: { ...throughNote, offset: [-20, -150] } },
      ...[throughStart.id, waypoint, throughEnd.id].map((frameId): Command => ({ type: 'note.put', stepId: through.id, frameId, note: couplerNote })),
      { type: 'frame.motion', stepId: through.id, frameId: waypoint, motions: [swing] },
      { type: 'frame.motion', stepId: through.id, frameId: throughEnd.id, motions: [swing] },
    );
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base, '/exports': base } } });
    await frontend.listen();
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontend.resolvedUrls!.local[0]}?project=${project.id}`);
    await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await page.evaluate(() => {
      const view = window.manualStudio.view, draw = view.drawCapture.bind(view);
      const canvas = CanvasRenderingContext2D.prototype, { roundRect, stroke } = canvas;
      const read = (output: DOMMatrix): LabelBox[] => {
        const leaders = [...document.querySelectorAll<SVGLineElement>('.canvas-leaders:not(.annotation-outlines) line')];
        return [...document.querySelectorAll<HTMLElement>('.canvas-labels button:not([hidden])')].map((element, index) => {
          const matrix = new DOMMatrixReadOnly(element.style.transform), bounds = element.getBoundingClientRect();
          return { id: element.dataset.noteId!, x: matrix.e * output.a + output.e, y: matrix.f * output.d + output.f,
            width: bounds.width * output.a, height: bounds.height * output.d,
            anchorX: Number(leaders[index].getAttribute('x1')) * output.a + output.e, anchorY: Number(leaders[index].getAttribute('y1')) * output.d + output.f };
        });
      };
      window.exportedLabelLayouts = [];
      const captureLayout = (render: () => void) => {
        const drawn: Box[] = [], strokes: number[] = [];
        let coordinates = new DOMMatrix();
        canvas.roundRect = function (x, y, width, height, radii) {
          coordinates = this.getTransform();
          drawn.push({ x: x * coordinates.a + coordinates.e, y: y * coordinates.d + coordinates.f, width: width * coordinates.a, height: height * coordinates.d });
          return roundRect.call(this, x, y, width, height, radii);
        };
        canvas.stroke = function (path?: Path2D) {
          strokes.push(this.lineWidth * this.getTransform().a);
          if (path) stroke.call(this, path); else Reflect.apply(stroke, this, []);
        };
        try { render(); return { labels: read(coordinates), drawn, strokes }; }
        finally { canvas.roundRect = roundRect; canvas.stroke = stroke; }
      };
      window.labelLayout = () => captureLayout(() => view.capture());
      view.drawCapture = context => {
        if (!window.recordLabelExport) return draw(context);
        window.exportedLabelLayouts.push(captureLayout(() => draw(context)));
      };
    });
    const seek = (position: number, video = false): Promise<Layout> => page.evaluate(async ({ position, video }) => {
      const sample = async () => {
        const slider = document.querySelector<HTMLInputElement>('#playSlider')!; slider.value = String(position); slider.dispatchEvent(new Event('input', { bubbles: true }));
        return window.labelLayout();
      };
      return video ? window.manualStudio.view.withVideoSize(sample) : sample();
    }, { position, video });
    const close = (a: number, b: number, message?: string): void => assert.ok(Math.abs(a - b) < .002, message ?? `${a} differs from ${b}`);
    const equalLayouts = (first: Layout, second: Layout): void => {
      assert.deepEqual(first.labels.map(label => label.id), second.labels.map(label => label.id));
      for (const [index, label] of first.labels.entries()) {
        const other = second.labels[index];
        for (const key of ['x', 'y', 'anchorX', 'anchorY', 'width', 'height'] as const) close(label[key], other[key]);
        close(label.x, first.drawn[index].x); close(label.y, first.drawn[index].y);
        close(label.x, second.drawn[index].x); close(label.y, second.drawn[index].y);
      }
    };

    await page.locator(`[data-step="${collision.id}"] h3`).click();
    const staticStart = await page.evaluate(() => window.labelLayout());
    const samples = await page.evaluate(() => {
      const slider = document.querySelector<HTMLInputElement>('#playSlider')!;
      const layouts: Layout[] = [];
      for (let index = 0; index <= 100; index++) {
        slider.value = String(index / 100); slider.dispatchEvent(new Event('input', { bubbles: true }));
        layouts.push(window.labelLayout());
      }
      return layouts;
    });
    assert.equal(samples[0].drawn.length, staticStart.drawn.length);
    for (const [index, rect] of samples[0].drawn.entries()) {
      for (const key of ['x', 'y', 'width', 'height'] as const) close(rect[key], staticStart.drawn[index][key], 'The animation starts with the static keyframe layout.');
    }
    let maxDisplacement = 0, maxDetour = 0;
    samples.forEach((sample, index) => {
      const part = sample.labels.find(label => label.id === pin.id)!, text = sample.labels.find(label => label.id === instruction.id)!;
      assert.ok(part.x + part.width <= text.x + .002 || text.x + text.width <= part.x + .002 || part.y + part.height <= text.y + .002 || text.y + text.height <= part.y + .002, `Label boxes overlap at ${index}%`);
      maxDetour = Math.max(maxDetour, Math.abs(part.y - (part.anchorY - 30)));
      if (index) {
        const previous = samples[index - 1].labels.find(label => label.id === pin.id)!;
        maxDisplacement = Math.max(maxDisplacement, Math.hypot(part.x - previous.x, part.y - previous.y));
      }
    });
    assert.ok(maxDisplacement < 18 && maxDetour > 35, `Expected a smooth detour, got ${maxDisplacement}px per sample and ${maxDetour}px detour.`);
    const collisionSeek = await seek(.44);
    equalLayouts(collisionSeek, samples[44]);
    await page.locator(`[data-step="${collision.id}"] h3`).click();
    await page.evaluate(() => {
      const now = performance.now.bind(performance); window.labelClock = now(); performance.now = () => window.labelClock;
      window.restoreLabelClock = () => { performance.now = now; };
    });
    await page.locator('#playStep').click();
    const live = await page.evaluate(async amount => {
      window.labelClock += amount;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return window.labelLayout();
    }, motionDuration * .44 * 1000);
    equalLayouts(live, collisionSeek);
    await page.locator('#playButton').click();
    await page.evaluate(() => window.restoreLabelClock());

    const authoredSeek = await seek(2.24), fraction = easeMotion(.24);
    const gaugeLabel = authoredSeek.labels.find(label => label.id === gauge.id)!, noteLabel = authoredSeek.labels.find(label => label.id === gaugeNote.id)!;
    close(gaugeLabel.x - gaugeLabel.anchorX, 25 + 120 * fraction);
    close(gaugeLabel.y - gaugeLabel.anchorY, -75 - 40 * fraction);
    close(noteLabel.x - noteLabel.anchorX, -240 - 60 * fraction);
    close(noteLabel.y - noteLabel.anchorY, 15 + 90 * fraction);
    const afterMiddle = await seek(2.51), beforeMiddle = await seek(2.49);
    assert.ok(Math.abs(afterMiddle.labels[0].x - beforeMiddle.labels[0].x) < 3, 'A matched note offset must move continuously through the midpoint.');
    assert.ok(Math.abs(afterMiddle.labels[1].x - beforeMiddle.labels[1].x) < 5, 'A part offset must move continuously through the midpoint.');
    equalLayouts(await seek(2.24), authoredSeek);
    const videoCollision = await seek(.44, true), videoAuthored = await seek(2.24, true);
    const scale = 1080 / 938, inset = (1920 - 1600 * scale) / 2;
    for (const [index, previous] of authoredSeek.labels.entries()) {
      const label = videoAuthored.labels[index];
      assert.equal(label.id, previous.id);
      close(label.x, previous.x * scale + inset); close(label.y, previous.y * scale);
      close(label.width, previous.width * scale); close(label.height, previous.height * scale);
      close(label.anchorX, previous.anchorX * scale + inset); close(label.anchorY, previous.anchorY * scale);
    }
    assert.ok(authoredSeek.strokes.length > authoredSeek.labels.length * 2, 'The comparison includes the circle stroke.');
    authoredSeek.strokes.forEach((width, index) => close(videoAuthored.strokes[index], width * scale));

    interface RenderResult { layout?: { revision: number; samples: { progress: number; seconds: number; viewport: { width: number; height: number }; labels: LabelBox[] }[] }; error?: string; path?: string }
    const render = async (request: Record<string, unknown>): Promise<RenderResult> => {
      const response = await fetch(`${base}/api/render`, post({ projectId: project.id, renderer: 'external', ...request }));
      assert.equal(response.status, 200, await response.clone().text());
      const { id } = await response.json() as { id: string };
      await renderInBrowser(new URL(frontend!.resolvedUrls!.local[0]).origin, project.id, id);
      const { result } = await (await fetch(`${base}/api/render/${id}`)).json() as { result: RenderResult };
      assert.equal(result.error, undefined);
      return result;
    };
    const result = await render({ kind: 'label-layout', frameId: authoredStart.id, progress: [1, .24, 0] });
    assert.ok(result.layout, result.error);
    assert.equal(result.layout.revision, project.revision);
    assert.deepEqual(result.layout.samples.map(sample => sample.progress), [1, .24, 0]);
    assert.deepEqual(result.layout.samples[1].viewport, { width: 1920, height: 1080 });
    close(result.layout.samples[1].seconds, motionDuration * .24);
    for (const [index, label] of result.layout.samples[1].labels.entries()) {
      assert.equal(label.id, videoAuthored.labels[index].id);
      close(label.x, videoAuthored.labels[index].x); close(label.y, videoAuthored.labels[index].y);
    }

    const appearanceSample = 60, progress = appearanceSample / 119;
    const revealLayout = await render({ kind: 'label-layout', frameId: revealStart.id, progress: [.49, .5, progress, .51, .52, .55] });
    assert.ok(revealLayout.layout);
    const [beforeReveal, ...afterReveal] = revealLayout.layout.samples;
    assert.ok(!beforeReveal.labels.some(label => label.id === revealNote.id));
    const appearing = afterReveal.map(sample => sample.labels.find(label => label.id === revealNote.id)!);
    assert.ok(appearing.every(label => label.y >= 8 * scale && label.y + label.height <= 1080 - 8 * scale));
    close(appearing[0].y, 12 * scale);
    const scoped = await render({ kind: 'png', scope: { frameId: revealStart.id, progress } });
    assert.ok(scoped.path);

    await page.locator(`[data-step="${through.id}"] h3`).click();
    await page.locator(`[data-frame="${waypoint}"]`).click();
    await page.locator('#frameSettings').click();
    await page.getByLabel('Pass through this keyframe').check();
    const motionEditor = page.getByLabel('Motion tracks (JSON)');
    assert.deepEqual(JSON.parse(await motionEditor.inputValue()), [swing]);
    await motionEditor.fill(JSON.stringify([swing]));
    const marked = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/commands') && response.ok());
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    project = (await (await marked).json() as { project: Project }).project;
    assert.equal(project.steps[3].frames[1].passThrough, true);
    const afterWaypoint = await seek(7.2);
    await page.locator(`[data-frame="${throughStart.id}"]`).click();
    await page.evaluate(() => {
      const now = performance.now.bind(performance); window.labelClock = now(); performance.now = () => window.labelClock;
      window.restoreLabelClock = () => { performance.now = now; };
    });
    await page.locator('#playStep').click();
    const acrossBoundary = await page.evaluate(async milliseconds => {
      window.labelClock += milliseconds;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return window.labelLayout();
    }, (approach + .2 * departure) * 1000);
    equalLayouts(acrossBoundary, afterWaypoint);
    await page.locator('#playButton').click();
    await page.evaluate(() => window.restoreLabelClock());
    const waypointView = await seek(7, true);
    const afterWaypointView = await seek(7.2, true);
    const outgoingQuarter = await seek(7.25, true);
    const waypointLayout = await render({ kind: 'label-layout', frameId: waypoint, progress: [0, .2, .25] });
    assert.ok(waypointLayout.layout);
    for (const [index, layout] of [waypointView, afterWaypointView, outgoingQuarter].entries()) for (const id of [throughNote.id, couplerNote.id]) {
      const apiLabel = waypointLayout.layout.samples[index].labels.find(label => label.id === id)!;
      const label = layout.labels.find(label => label.id === id)!;
      for (const key of ['x', 'y', 'anchorX', 'anchorY'] as const) close(apiLabel[key], label[key]);
    }
    const fourBarStill = await render({ kind: 'png', scope: { frameId: waypoint, progress: .25 } });
    assert.ok(fourBarStill.path);
    const stillBytes = await readFile(fourBarStill.path);
    assert.equal(stillBytes.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([stillBytes.readUInt32BE(16), stillBytes.readUInt32BE(20)], [1920, 1080]);

    await page.evaluate(() => { window.recordLabelExport = true; });
    await page.locator('#exportButton').click();
    const [output] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export MP4', exact: true }).click()]);
    assert.match(output.suggestedFilename(), /\.mp4$/);
    const filename = await output.path();
    const file = await readFile(filename); assert.equal(file.subarray(4, 8).toString(), 'ftyp');
    const frames = videoSegments(playbackPlan(project).map(segment => segment.duration));
    const { stdout } = await promisify(execFile)(await mediaCommand('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames', '-of', 'json', filename], { windowsHide: true });
    const frameCount = frames.reduce((total, segment) => total + segment.count, 0);
    assert.deepEqual(JSON.parse(stdout).streams, [{ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '60/1', nb_frames: String(frameCount) }]);
    const recorded = await page.evaluate(() => window.exportedLabelLayouts);
    const revealDrawIndex = frames[2].count + frames[5].count + 2;
    const throughDrawIndex = revealDrawIndex + frames[8].count + 1, waypointDrawIndex = throughDrawIndex + frames[11].count;
    assert.equal(recorded.length, waypointDrawIndex + frames[12].count + 1);
    equalLayouts(recorded[44], videoCollision);
    equalLayouts(recorded[frames[2].count + 1 + 24], videoAuthored);
    const revealed = recorded[revealDrawIndex + appearanceSample].labels.find(label => label.id === revealNote.id)!;
    close(revealed.x, appearing[1].x); close(revealed.y, appearing[1].y);
    const revealFrames = recorded.slice(revealDrawIndex + appearanceSample, revealDrawIndex + frames[8].count)
      .map(frame => frame.labels.find(label => label.id === revealNote.id)!);
    revealFrames.forEach((label, index) => {
      assert.ok(label.y >= 8 * scale && label.y + label.height <= 1080 - 8 * scale);
      if (index > 0) assert.ok(Math.abs(label.y - revealFrames[index - 1].y) < 13, 'The label must move continuously away from the edge.');
    });
    const framePixels = (await promisify(execFile)(await mediaCommand('ffmpeg'), [
      '-v', 'error', '-i', filename, '-vf', `select='eq(n,${frames[8].firstFrame + appearanceSample})'`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
    ], { windowsHide: true, encoding: 'buffer' })).stdout;
    const pixels = await page.evaluate(async ({ images, point, pin }) => Promise.all(images.map(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const color = [...context.getImageData(point.x, point.y, 1, 1).data].slice(0, 3);
      const stripe = context.getImageData(pin.x - 12, pin.y, 25, 1).data;
      let diameter = 0;
      for (let i = 0; i < stripe.length; i += 4) {
        if (stripe[i] - stripe[i + 1] > 40 && stripe[i + 2] - stripe[i + 1] > 30) diameter++;
      }
      return { color, diameter };
    })), {
      images: [(await readFile(scoped.path)).toString('base64'), framePixels.toString('base64')],
      point: { x: Math.floor(revealed.x + revealed.width - 12), y: Math.floor(revealed.y + 4) },
      pin: { x: Math.floor(revealed.anchorX), y: Math.floor(revealed.anchorY) },
    });
    assert.deepEqual(pixels[0].color, [49, 66, 87], 'The scoped PNG includes the complete callout near the top edge.');
    assert.ok(pixels[1].color.every((channel, index) => Math.abs(channel - pixels[0].color[index]) < 8), `The MP4 frame matches the scoped PNG: ${JSON.stringify(pixels)}.`);
    assert.ok(Math.abs(pixels[0].diameter - 9.6) <= 1, `The scoped PNG includes the fixed-size pin: ${JSON.stringify(pixels)}.`);
    assert.ok(Math.abs(pixels[1].diameter - pixels[0].diameter) <= 2, `The decoded MP4 retains the same pin size: ${JSON.stringify(pixels)}.`);
    equalLayouts(recorded[waypointDrawIndex], waypointView);
    equalLayouts(recorded[waypointDrawIndex + (frames[12].count - 1) / 4], outgoingQuarter);
    const [beforePass, atPass, afterPass] = recorded.slice(waypointDrawIndex - 1, waypointDrawIndex + 2)
      .map(frame => frame.labels.find(label => label.id === throughNote.id)!);
    assert.ok(atPass.anchorX - beforePass.anchorX > 1 && afterPass.anchorX - atPass.anchorX > 1, 'MP4 advances on both sides of the waypoint without drawing it twice.');
    assert.deepEqual(await (await fetch(route)).json(), project);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await frontend?.close(); if (api.exitCode === null) { api.kill(); await once(api, 'close'); }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-label-motion-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
