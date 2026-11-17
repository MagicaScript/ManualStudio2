import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Locator } from 'playwright-core';

async function appearance(element: Locator) {
  return element.evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderTopColor, color: style.color, opacity: style.opacity, shadow: style.boxShadow, outline: style.outlineStyle };
  });
}

test('assembly panel actions highlight without changing selected greens or disabled controls', { timeout: 30000 }, async context => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath, 'The hover check requires installed Chrome.');
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, appType: 'mpa' });
  let browser: Browser | undefined;
  try {
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 980, height: 850 } }); page.setDefaultTimeout(4000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/assembly-hover.html`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#guide')!).getPropertyValue('--assembly-hover-background').trim() === '#46464b');
    const hoverActions = ['collapseStructure', 'structureHelp', 'copyStep', 'deleteStep', 'footerReturn', 'collapseGuide', 'clip', 'rectangle', 'playStep', 'deleteFrame', 'addFrame', 'saveFrame', 'cameraAll', 'partProperties'];
    for (const id of hoverActions) {
      await page.locator('#outside').hover(); const target = page.locator(`#${id}`); const idle = await appearance(target);
      await target.hover(); const hovered = await appearance(target);
      assert.notEqual(hovered.background, idle.background, `${id} needs a visible hover background`);
      assert.equal(hovered.background, 'rgb(70, 70, 75)');
    }
    for (const id of ['overview', 'stepTag', 'stepName', 'addObjects', 'transitionFrame', 'snap', 'radius', 'description']) {
      await page.locator('#outside').hover(); const target = page.locator(`#${id}`); const idle = await appearance(target);
      await target.hover(); assert.notEqual((await appearance(target)).background, idle.background, `${id} needs hover feedback`);
    }
    await page.locator('#outside').hover(); const chip = page.locator('#partChips .chip').first(); const idleChip = await appearance(chip);
    await page.locator('#partChips').hover(); assert.notEqual((await appearance(chip)).background, idleChip.background);
    await page.locator('#insertStep').hover();
    assert.equal((await appearance(page.locator('#insertStep'))).background, 'rgb(52, 85, 59)');
    await page.locator('#addStep').hover();
    assert.equal((await appearance(page.locator('#addStep'))).background, 'rgb(0, 191, 75)');
    await page.locator('#labels').hover();
    assert.equal((await appearance(page.locator('#labels'))).outline, 'solid');
    assert.equal(await page.locator('#labels').isChecked(), true);
    for (const id of ['glue', 'selectedNote', 'selectedStep', 'activeFrame']) {
      await page.locator('#outside').hover(); const target = page.locator(`#${id}`); const idle = await appearance(target);
      await target.hover(); const hovered = await appearance(target);
      assert.equal(hovered.border, 'rgb(0, 174, 66)', `${id} must retain its selection border`);
      assert.notEqual(hovered.background, idle.background, `${id} should still respond while selected`);
    }
    for (const id of ['disabledCopy', 'disabledConnection', 'disabledPrimary']) {
      await page.locator('#outside').hover(); const target = page.locator(`#${id}`); const idle = await appearance(target);
      await target.hover(); assert.deepEqual(await appearance(target), idle, `${id} must stay disabled visually`);
    }
    await page.locator('#outside').hover(); await page.keyboard.press('Tab'); await page.locator('#cameraAll').focus();
    assert.equal(await page.locator('#cameraAll').evaluate(node => node.matches(':focus-visible')), true);
    assert.equal((await appearance(page.locator('#cameraAll'))).outline, 'solid');
    assert.equal((await appearance(page.locator('#cameraAll'))).background, 'rgb(70, 70, 75)');
    await page.locator('#outside').focus(); await page.locator('#outside').hover();
    assert.equal((await appearance(page.locator('#outside'))).background, 'rgb(80, 81, 86)', 'Unrelated controls retain their existing styles');
    await page.locator('#staticHeading').hover();
    assert.equal((await appearance(page.locator('#staticHeading'))).background, 'rgba(0, 0, 0, 0)', 'Static headings must not look actionable');
    const directory = path.resolve('artifacts/Assembly Hover'); await mkdir(directory, { recursive: true });
    await page.locator('#copyStep').hover(); await page.screenshot({ path: path.join(directory, 'Structure Hover.png') });
    await page.locator('#clip').hover(); await page.screenshot({ path: path.join(directory, 'Guide Hover.png') });
    context.diagnostic(`${hoverActions.length} icon/action buttons, 8 cards/fields, chips, insertion/add actions, checkbox, 4 selected states, 3 disabled states and keyboard focus verified.`);
  } finally { await browser?.close(); await server.close(); }
});
