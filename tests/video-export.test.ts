import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
import { videoSegments } from '../src/video.ts';

const execute = promisify(execFile);

test('video sampling retains cumulative duration without dropping short segments', () => {
  assert.deepEqual(videoSegments([2, 2, 2, 2, 2, 2]), Array.from({ length: 6 }, (_, index) => ({ firstFrame: index * 60, count: 60 })));
  assert.equal(videoSegments([.05, .05, .05, .05]).reduce((sum, segment) => sum + segment.count, 0), 6);
  assert.deepEqual(videoSegments([.001]), [{ firstFrame: 0, count: 1 }]);
});

interface VideoReport { samples: [number, number][]; endpoints: { hidden: string[]; position: number[] }[]; bytes: number[] }
function isVideoReport(value: unknown): value is VideoReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  return Array.isArray(report.samples) && report.samples.every(sample => Array.isArray(sample) && sample.length === 2 && sample.every(item => typeof item === 'number'))
    && Array.isArray(report.endpoints) && report.endpoints.every(endpoint => endpoint && typeof endpoint === 'object' && Array.isArray(endpoint.hidden) && Array.isArray(endpoint.position))
    && Array.isArray(report.bytes) && report.bytes.every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255);
}

test('Chrome video export records all exact removal endpoints and produces twelve seconds at thirty fps', { timeout: 45000 }, async context => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath, 'The video check requires installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-video-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  let browser: Browser | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/video-export.html`);
    await page.waitForFunction(() => document.documentElement.dataset.videoTestComplete === 'true'); assert.deepEqual(errors, []);
    const report: unknown = JSON.parse(await page.locator('output').textContent() ?? 'null'); assert.ok(isVideoReport(report));
    assert.equal(report.samples.length, 360); assert.equal(report.endpoints.length, 6);
    for (let segment = 0; segment < 6; segment++) {
      assert.deepEqual(report.samples[segment * 60], [segment, 0]); assert.deepEqual(report.samples[segment * 60 + 59], [segment, 1]);
      assert.deepEqual(report.endpoints[segment], { hidden: ['support'], position: [0, 0, 10] });
    }
    const response = await fetch(`${base}/api/export/video`, { method: 'POST', headers: { 'Content-Type': 'video/x-ivf' }, body: Uint8Array.from(report.bytes) }); assert.equal(response.status, 200);
    const result: unknown = await response.json(); assert.ok(result && typeof result === 'object' && 'url' in result && typeof result.url === 'string');
    const filename = path.join(directory, result.url.replace(/^\//, ''));
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration,nb_frames,r_frame_rate', '-of', 'json', filename], { windowsHide: true });
    const parsed: unknown = JSON.parse(stdout); assert.ok(parsed && typeof parsed === 'object' && 'streams' in parsed && Array.isArray(parsed.streams));
    assert.deepEqual(parsed.streams[0], { r_frame_rate: '30/1', duration: '12.000000', nb_frames: '360' });
    const pixels = (await execute('ffmpeg', ['-v', 'error', '-i', filename, '-vf', "select='gte(mod(n,60),58)',scale=1:1", '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, encoding: 'buffer' })).stdout;
    assert.equal(pixels.length, 36);
    context.diagnostic(JSON.stringify({ endpointPixels: Array.from(pixels) }));
    for (let segment = 0; segment < 6; segment++) { const offset = segment * 6; assert.ok(pixels[offset] > 240 && pixels[offset + 1] < 15, 'The penultimate frame must still show the support.'); assert.ok(pixels[offset + 3] < 15 && pixels[offset + 4] > 240, 'The final encoded frame must hide the support.'); }
    context.diagnostic(JSON.stringify({ frames: 360, seconds: 12, fps: 30, exactRemovalEndpoints: 6 }));
  } finally {
    await browser?.close(); await server.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-video-')); await rm(resolved, { recursive: true, force: true });
  }
});
