import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';
import { createServer } from 'vite';

test('anchored annotation outlines face the camera, retain pixel strokes and match capture at both pixel ratios', { timeout: 60000 }, async () => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath);
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    for (const deviceScaleFactor of [1, 2]) {
      const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/annotation-rendering.html`);
      await page.waitForFunction(() => document.documentElement.dataset.complete === 'true');
      assert.deepEqual(errors, []);
      const report = await page.evaluate(() => window.annotationRenderingReport);
      for (const state of [...report.orbit, report.moved, report.beforeZoom, report.afterZoom]) {
        for (const mark of state.measurements) {
          assert.ok(Math.abs(mark.width - mark.height) < .001, `${mark.id} remains square/circular after orbit or pose changes: ${JSON.stringify(mark)}`);
          assert.ok(Math.abs(mark.x + mark.width / 2 - mark.expected.x) < .001);
          assert.ok(Math.abs(mark.y + mark.height / 2 - mark.expected.y) < .001);
          assert.equal(mark.lineWidth, 2); assert.equal(mark.stroke, '#23a92e');
        }
      }
      const ratio = report.beforeZoom.measurements[0].width / report.afterZoom.measurements[0].width;
      assert.ok(Math.abs(ratio - 575 / 275) < .001, 'Millimeter dimensions continue to scale with zoom.');
      assert.equal(report.hiddenCount, 0); assert.equal(report.behindCameraCount, 0);
      assert.ok(report.clippedIds.includes('circle')); assert.ok(!report.clippedIds.includes('rectangle'));
      assert.ok(!report.hiddenNoteIds.includes('rectangle')); assert.ok(report.hiddenNoteIds.includes('circle'));
      assert.ok(report.samples > 300); assert.ok(report.matching / report.samples > .98, 'Exported strokes match the onscreen SVG coverage and raw preset color.');
      assert.ok(report.partialCoverage > 100, 'Outlines retain antialiased edge coverage.');
      assert.deepEqual(report.leaderStyle, { color: 'rgba(0,199,79,0.86)', lineWidth: 2, dotRadius: 4.8, text: 'rgb(238, 238, 238)' });
      for (const name of ['rectangle', 'circle', 'arrowhead', 'hollow'] as const) {
        await page.mouse.click(report.clicks[name].x, report.clicks[name].y);
        assert.equal(await page.locator('#viewport').getAttribute('data-selection'), name === 'arrowhead' ? 'arrow' : name === 'hollow' ? 'part' : name);
      }
      if (deviceScaleFactor === 1) {
        await mkdir(path.resolve('artifacts/Annotation Rendering'), { recursive: true });
        await page.screenshot({ path: path.resolve('artifacts/Annotation Rendering/Projection Verification.png') });
      }
      const smallShapes = await page.evaluate(() => window.zoomOutAnnotations());
      for (const shape of smallShapes) {
        assert.ok(shape.radius > 1 && shape.radius < 4, 'The regression must retain a visible hollow center after zooming out.');
        await page.mouse.click(shape.x, shape.y);
        assert.equal(await page.locator('#viewport').getAttribute('data-selection'), 'part');
      }
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
