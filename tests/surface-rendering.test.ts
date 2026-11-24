import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';

interface RenderingReport {
  maxSamples: number; binaryCapEdgePixels: number; coveredCapEdgePixels: number; capChangedPixels: number;
  duplicatePaintDifference: number; longStrokeDifference: number; erasedRegionDifference: number; duplicateTriangleCount: number;
  holeCenter: number[]; singlePaintColor: number[]; overlappingPaintColor: number[]; latestPaintColor: number[]; latestOverlapColor: number[];
  clippedInsideColor: number[]; clippedOutsideColor: number[]; unpaintedColor: number[];
  smoothPaintEdgePixels: number; binaryPaintEdgePixels: number; nextFrameInsideColor: number[]; nextFrameOutsideColor: number[];
  clippedJoinDifference: number; triangleJoinDifference: number; dryOpening: number[]; paintNextToOpening: number[]; openingEdgePixels: number;
  depthPixels: number[]; nearPlanes: number[]; legacyDepthPixels: number; gaugePixels: number; gaugeNearPlane: number;
}
function isReport(value: unknown): value is RenderingReport {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return ['maxSamples', 'binaryCapEdgePixels', 'coveredCapEdgePixels', 'capChangedPixels', 'duplicatePaintDifference', 'longStrokeDifference', 'erasedRegionDifference', 'duplicateTriangleCount', 'smoothPaintEdgePixels', 'binaryPaintEdgePixels', 'clippedJoinDifference', 'triangleJoinDifference', 'openingEdgePixels', 'legacyDepthPixels', 'gaugePixels', 'gaugeNearPlane'].every(key => typeof result[key] === 'number')
    && ['holeCenter', 'singlePaintColor', 'overlappingPaintColor', 'latestPaintColor', 'latestOverlapColor', 'clippedInsideColor', 'clippedOutsideColor', 'unpaintedColor', 'nextFrameInsideColor', 'nextFrameOutsideColor', 'dryOpening', 'paintNextToOpening', 'depthPixels', 'nearPlanes'].every(key => Array.isArray(result[key]) && result[key].length === 3 && result[key].every(channel => typeof channel === 'number'));
}

test('painted surfaces stay continuous, section edges retain coverage, and close views preserve depth', { timeout: 45000 }, async context => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'The rendering check requires the installed Chrome executable.');
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  let browser: Browser | undefined;
  try {
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 560, height: 730 } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/surface-rendering.html`); assert.equal(response?.status(), 200);
    await page.waitForFunction(() => document.documentElement.dataset.renderingTestComplete === 'true');
    assert.deepEqual(errors, []); const raw = await page.locator('output').textContent(); const report: unknown = JSON.parse(raw ?? 'null'); assert.ok(isReport(report), raw ?? 'No rendering report');
    context.diagnostic(JSON.stringify(report));
    assert.ok(report.maxSamples >= 4);
    assert.equal(report.duplicatePaintDifference, 0, 'Repainting the same surface must not change its color.');
    assert.equal(report.longStrokeDifference, 0, 'A 256-sample stroke must render without shader-uniform overflow or overlap darkening.');
    assert.deepEqual(report.singlePaintColor, report.overlappingPaintColor, 'Overlapping regions must retain the same painted color.');
    assert.deepEqual(report.latestPaintColor, report.latestOverlapColor, 'A later color must replace the earlier surface color without mixing.');
    assert.notDeepEqual(report.latestPaintColor, report.singlePaintColor);
    assert.equal(report.erasedRegionDifference, 0, 'Removing a region must restore the remaining paint exactly.');
    assert.equal(report.duplicateTriangleCount, 2);
    assert.deepEqual(report.clippedInsideColor, report.singlePaintColor, 'The contact side of a clipped cylinder band must remain painted.');
    assert.deepEqual(report.clippedOutsideColor, report.unpaintedColor, 'The mating-plane cut must leave the non-contact side unpainted.');
    assert.deepEqual(report.nextFrameInsideColor, report.singlePaintColor, 'Changing frames must bind the current clipping plane, even with an unchanged shader layout.');
    assert.deepEqual(report.nextFrameOutsideColor, report.unpaintedColor);
    assert.deepEqual(report.holeCenter, [0, 0, 0], 'Section fill must not cover the actual torus opening.');
    assert.ok(report.coveredCapEdgePixels > report.binaryCapEdgePixels + 80, 'Clip boundaries need partial sample coverage rather than whole-pixel discard.');
    assert.ok(report.capChangedPixels > 80);
    assert.ok(report.smoothPaintEdgePixels > report.binaryPaintEdgePixels + 50, 'Paint masks must retain partial edge coverage as well as the clipped body.');
    assert.equal(report.clippedJoinDifference, 0, 'Adjacent clips of the same color must cover their shared edges within a triangle.');
    assert.equal(report.triangleJoinDifference, 0, 'The mesh rasterizer must cover the shared boundary of neighboring painted triangles.');
    assert.deepEqual(report.dryOpening, report.unpaintedColor, 'The dry opening in the joined regions must remain unpainted.');
    assert.deepEqual(report.paintNextToOpening, report.singlePaintColor);
    assert.ok(report.openingEdgePixels > 100, 'A dry opening must keep antialiased edges.');
    assert.ok(report.legacyDepthPixels > 100, 'The close reading must reproduce the depth conflict at the old near plane.');
    assert.deepEqual(report.depthPixels, [0, 0, 0], 'No part of the nearly coplanar insert should leak through the cover as the view moves.');
    assert.ok(report.nearPlanes.every(near => near > 400), 'Offscreen ends must not consume the near depth range.');
    assert.ok(report.gaugePixels > 100 && report.gaugeNearPlane < 40, 'Bringing a part near the camera must expand the depth range before it clips.');
    const directory = path.resolve('artifacts'); await mkdir(directory, { recursive: true });
    await page.locator('#sectionCoverage').screenshot({ path: path.join(directory, 'Section Coverage Verification.png') });
    await page.locator('#paintCoverage').screenshot({ path: path.join(directory, 'Surface Paint Verification.png') });
  } finally { await browser?.close(); await server.close(); }
});
