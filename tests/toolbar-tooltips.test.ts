import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';

test('toolbar help appears on all three controls, including disabled undo and redo', { timeout: 30000 }, async () => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath, 'The toolbar check requires installed Chrome.');
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  let browser: Browser | undefined;
  try {
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 520, height: 180 } });
    page.setDefaultTimeout(4000);
    page.setDefaultNavigationTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/toolbar-tooltips.html`);
    await page.locator('#saveButton-tooltip').waitFor({ state: 'attached' });
    for (const [id, expected] of [['saveButton', 'Save Project'], ['undoButton', 'Undo (Ctrl+Z)'], ['redoButton', 'Redo (Ctrl+Y)']]) {
      const button = page.locator(`#${id}`), target = button.locator('..'), tooltip = page.locator(`#${id}-tooltip`);
      const anchor = await button.boundingBox(); assert.ok(anchor);
      await target.hover(); await tooltip.waitFor({ state: 'visible' });
      assert.equal(await tooltip.textContent(), expected);
      assert.equal(await page.locator('.toolbar-tooltip:visible').count(), 1);
      assert.equal(await button.getAttribute('title'), null);
      assert.equal(await button.getAttribute('aria-describedby'), `${id}-tooltip`);
      const box = await tooltip.boundingBox(); assert.ok(box && box.y >= anchor.y + anchor.height && box.height >= 20 && box.width > 60);
      const style = await tooltip.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderTopWidth, color: getComputedStyle(element).color }));
      assert.deepEqual(style, { background: 'rgb(255, 255, 225)', border: '1px', color: 'rgb(28, 28, 28)' });
      if (id !== 'saveButton') assert.equal(await button.isDisabled(), true);
      await page.locator('#outside').hover(); await tooltip.waitFor({ state: 'hidden' });
      assert.equal(await button.getAttribute('aria-describedby'), null);
    }
    await page.locator('#saveButton').focus(); await page.locator('#saveButton-tooltip').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await page.locator('#saveButton-tooltip').waitFor({ state: 'hidden' });
    await page.locator('#outside').focus();
    await page.locator('#saveButton').hover(); await page.locator('#saveButton-tooltip').waitFor({ state: 'visible' });
    const directory = path.resolve('artifacts/Toolbar Tooltips'); await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, 'Save Tooltip.png') });
    await page.locator('#saveButton').click(); await page.locator('#saveButton-tooltip').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
