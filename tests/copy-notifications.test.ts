import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';

test('copy confirmations hold for 500 ms, fade for 200 ms, and stack independently without shortening status messages', { timeout: 20000 }, async context => {
  const executablePath = await findBrowser(true);
  assert.ok(executablePath, 'Copy confirmation checks require installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-copy-notifications-'));
  const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  let browser: Browser | undefined;
  try {
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 700 } }); page.setDefaultTimeout(3000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/copy-notifications.html`);
    await page.locator('#status').click();
    const timing = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('#copy')!.click();
      const node = document.querySelector<HTMLElement>('.copy-notification')!;
      const animation = node.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'copy-confirmation-fade')!;
      const settings = animation.effect!.getTiming(), start = performance.now();
      const samples: { milliseconds: number; connected: boolean; opacity: number; translateY: number }[] = [];
      while (performance.now() - start < 950) {
        const style = getComputedStyle(node);
        samples.push({ milliseconds: performance.now() - start, connected: node.isConnected, opacity: Number(style.opacity), translateY: node.isConnected ? new DOMMatrixReadOnly(style.transform).m42 : 0 });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return { delay: settings.delay, duration: settings.duration, samples };
    });
    assert.equal(timing.delay, 500); assert.equal(timing.duration, 200);
    assert.ok(timing.samples.some(sample => sample.milliseconds < 120 && sample.translateY > .5), 'New confirmations must enter vertically.');
    assert.ok(timing.samples.filter(sample => sample.connected && sample.milliseconds >= 180).every(sample => Math.abs(sample.translateY) < .1), 'The arrival must settle before the hold period finishes.');
    const held = timing.samples.filter(sample => sample.milliseconds >= 100 && sample.milliseconds <= 450);
    assert.ok(held.length >= 2); assert.ok(held.every(sample => sample.connected && sample.opacity === 1));
    assert.ok(timing.samples.some(sample => sample.connected && sample.milliseconds >= 500 && sample.milliseconds <= 740 && sample.opacity > 0 && sample.opacity < 1), 'The confirmation must visibly fade, not disappear abruptly.');
    const removedAt = timing.samples.find(sample => !sample.connected)?.milliseconds;
    assert.ok(removedAt !== undefined && removedAt >= 650 && removedAt < 900, `Expected removal after the 700 ms sequence, observed ${removedAt}.`);
    assert.equal(await page.locator('.copy-notifications').count(), 0);
    assert.equal(await page.locator('.toast').innerText(), 'Status remains visible.', 'The ordinary status toast must survive the copy lifecycle.');

    await page.locator('#copy').click();
    const first = await page.locator('.copy-notification').elementHandle(); assert.ok(first);
    await page.waitForTimeout(200); await page.locator('#copy').click();
    assert.equal(await page.locator('.copy-notification').count(), 2);
    assert.deepEqual(await page.locator('.copy-notification').allTextContents(), ['Name copied to clipboard.', 'Name copied to clipboard.']);
    const boxes = await page.locator('.copy-notification').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
    assert.ok(boxes[0].bottom < boxes[1].top, 'Successive confirmations must occupy separate vertical rows.');
    assert.equal(await first.evaluate(node => node.isConnected), true);
    const motion = await first.evaluate(node => {
      const animations = node.getAnimations(), move = animations.find(animation => animation.id === 'copy-notification-motion');
      const fade = animations.find(animation => animation instanceof CSSAnimation && animation.animationName === 'copy-confirmation-fade');
      node.dispatchEvent(new AnimationEvent('animationend', { animationName: 'copy-notification-motion', bubbles: true }));
      return { moveDuration: move?.effect?.getTiming().duration, fadeTime: Number(fade?.currentTime), connected: node.isConnected };
    });
    assert.equal(motion.moveDuration, 120, 'The earlier notification must smoothly make room.');
    assert.ok(motion.fadeTime >= 180 && motion.connected, 'Motion completion must neither remove the copy nor restart its fade clock.');
    await page.waitForTimeout(400);
    assert.ok(await first.evaluate(node => Number(getComputedStyle(node).opacity) < 1));
    assert.equal(await page.locator('.copy-notification').last().evaluate(node => getComputedStyle(node).opacity), '1', 'The later copy must retain its own complete hold period.');
    await page.waitForTimeout(200); assert.equal(await first.evaluate(node => node.isConnected), false);
    assert.equal(await page.locator('.copy-notification').count(), 1);
    await page.locator('.copy-notifications').waitFor({ state: 'detached' });

    await page.locator('#error').click();
    await page.evaluate(() => { for (let index = 0; index < 20; index++) document.querySelector<HTMLButtonElement>('#copy')!.click(); });
    await page.waitForTimeout(150);
    const overflow = await page.locator('.copy-notifications').evaluate(node => ({ position: getComputedStyle(node).position, height: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, entries: node.childElementCount }));
    assert.equal(overflow.position, 'fixed'); assert.equal(overflow.entries, 20);
    assert.ok(overflow.scrollHeight > overflow.height && overflow.height <= 200);
    assert.ok(overflow.scrollTop >= overflow.scrollHeight - overflow.height - 1, 'Overflow should scroll to the newest confirmation.');
    const regionBox = await page.locator('.copy-notifications').boundingBox(), errorBox = await page.locator('.toast').boundingBox();
    assert.ok(regionBox && errorBox && regionBox.y + regionBox.height < errorBox.y, 'Copy confirmations must not obscure an existing error message.');
    const artifacts = path.resolve('artifacts/Copy Notifications'); await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'Stacked Confirmations.png') });
    await page.locator('.copy-notifications').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.toast').innerText(), 'Detailed error remains visible.', 'The long error message must not be replaced or shortened by copies.');
    assert.deepEqual(errors, []);
    context.diagnostic(JSON.stringify({ motionMilliseconds: motion.moveDuration, holdMilliseconds: timing.delay, fadeMilliseconds: timing.duration, removedAtMilliseconds: removedAt, repeatedTextCreatesSeparateRows: true, overflowEntries: overflow.entries, statusAndErrorPreserved: true }));
  } finally {
    await browser?.close(); await server.close();
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-copy-notifications-')); await rm(resolved, { recursive: true, force: true });
  }
});
