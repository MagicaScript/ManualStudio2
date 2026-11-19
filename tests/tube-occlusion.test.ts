import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';
import { createServer } from 'vite';

interface TubeResult { angle: number; coveredPaintPixels: number; coveredInteriorPixels: number; biasedPaintPixels: number; exposedPaintPixels: number }
function isTubeResult(value: unknown): value is TubeResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return ['angle', 'coveredPaintPixels', 'coveredInteriorPixels', 'biasedPaintPixels', 'exposedPaintPixels'].every(key => typeof result[key] === 'number');
}

test('nested native tubes hide glue without slope-bias leakage at grazing views', { timeout: 60000 }, async context => {
  const fixturePath = path.resolve('tests/fixtures/private/tube-occlusion.json');
  if (!await access(fixturePath).then(() => true, () => false)) {
    context.skip('The private tube occlusion fixture is unavailable. See Validation.md.');
    return;
  }
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'The tube occlusion check requires installed Chrome.');
  const browser = await chromium.launch({ executablePath, headless: true });
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  try {
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    const page = await browser.newPage({ viewport: { width: 810, height: 1020 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/tube-occlusion.html`);
    await page.waitForFunction(() => document.documentElement.dataset.complete === 'true'); assert.deepEqual(errors, []);
    const report: unknown = JSON.parse(await page.locator('output').textContent() ?? 'null'); context.diagnostic(JSON.stringify(report));
    assert.ok(Array.isArray(report) && report.every(isTubeResult));
    for (const result of report) {
      assert.equal(result.coveredInteriorPixels, 0, 'No contact paint may leak through the outer sleeve wall; its open circular rims can expose the inner tube.');
      assert.ok(result.exposedPaintPixels > 1000, 'Removing the sleeve must reveal the contact band.');
    }
    assert.equal(report[0].coveredPaintPixels, 0, 'A side view must fully occlude the inserted contact band.');
    assert.ok(report.some(result => result.biasedPaintPixels > 20), 'The regression must reproduce the original depth-bias leakage.');
    await mkdir(path.resolve('artifacts/Surface Occlusion'), { recursive: true });
    await page.locator('main').screenshot({ path: path.resolve('artifacts/Surface Occlusion/Tube Paint Comparison.png') });
  } finally { await browser.close(); await server.close(); }
});
