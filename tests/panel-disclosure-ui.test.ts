import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { zipSync, strToU8 } from 'fflate';
import type { Project } from '../shared/types.ts';

const panels = [
  { id: 'structurePanel', button: 'collapseStructure', body: 'structureBody', name: 'Assembly Structure' },
  { id: 'listPanel', button: 'collapseList', body: 'listBody', name: 'Assembly list' },
  { id: 'guide', button: 'collapseGuide', body: 'guideBody', name: 'Assembly Guide' },
] as const;
type Panel = typeof panels[number];

async function panelState(page: Page, panel: Panel) {
  return page.evaluate(spec => {
    const element = document.getElementById(spec.id)!, body = document.getElementById(spec.body)!;
    const button = document.getElementById(spec.button)!, header = element.querySelector(':scope > .panel-header')!;
    const points = button.querySelector('svg.assembly-icon polyline')?.getAttribute('points')?.split(/\s+/).map(Number);
    const arrowDirection = points?.length === 6 ? Math.sign(points[3] - (points[1] + points[5]) / 2) : undefined;
    return { height: element.getBoundingClientRect().height, headerHeight: header.getBoundingClientRect().height,
      hidden: body.hidden, inert: body.inert, expanded: button.getAttribute('aria-expanded'), title: button.getAttribute('title'),
      controls: button.getAttribute('aria-controls'), arrowDirection };
  }, panel);
}
async function collapsed(page: Page, panel: Panel): Promise<void> {
  await page.waitForFunction(id => !document.getElementById(id)?.classList.contains('panel-animating'), panel.id);
  const state = await panelState(page, panel);
  assert.equal(state.expanded, 'false'); assert.equal(state.hidden, true); assert.equal(state.inert, true);
  assert.equal(state.title, `Expand ${panel.name}`); assert.equal(state.controls, panel.body);
  assert.equal(state.arrowDirection, 1);
  assert.ok(Math.abs(state.height - state.headerHeight) < 2, `${panel.name} must collapse to its header: ${JSON.stringify(state)}`);
}
async function expanded(page: Page, panel: Panel): Promise<void> {
  await page.waitForFunction(id => !document.getElementById(id)?.classList.contains('panel-animating'), panel.id);
  const state = await panelState(page, panel);
  assert.equal(state.expanded, 'true'); assert.equal(state.hidden, false); assert.equal(state.inert, false);
  assert.equal(state.title, `Collapse ${panel.name}`); assert.equal(state.controls, panel.body);
  assert.equal(state.arrowDirection, -1); assert.ok(state.height > state.headerHeight + 50);
}

test('assembly panels share animated disclosure and step search preserves source order and global insertion targets', { timeout: 60000 }, async context => {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  let executablePath: string | undefined;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  assert.ok(executablePath, 'Panel and step-search interactions require installed Chrome.');
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-panel-disclosure-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Browser | undefined, frontend: ViteDevServer | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => { api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); }); api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk)))); });
    const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const mesh = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh>';
    const xml = `<model unit="millimeter"><resources>${['Front shell', 'Carbon pivot', 'Actuator bracket'].map((name, index) => `<object id="${index + 1}" name="${name}">${mesh}</object>`).join('')}</resources><build>${[0, 1, 2].map(index => `<item objectid="${index + 1}" transform="1 0 0 0 1 0 0 0 1 ${index * 30} 0 0"/>`).join('')}</build></model>`;
    const imported = await fetch(`${base}/api/import?name=Panels.3mf`, { method: 'POST', body: zipSync({ '3D/3dmodel.model': strToU8(xml) }) }); assert.equal(imported.status, 200); let project = await imported.json() as Project;
    assert.equal(project.model.parts.length, 3);
    const materials = ['ABS Plastic', 'Carbon Fiber', 'Aluminum 6061'], paths = ['Housing:1/Front shell', 'Hinge:1/Pivot Rod', 'Mechanism:1/Actuator bracket'];
    project.model.parts.forEach((part, index) => { part.materialName = materials[index]; part.path = paths[index]; });
    const saved = await fetch(`${base}/api/projects/${project.id}`, { ...post({ project, expectedRevision: project.revision }), method: 'PUT' }); assert.equal(saved.status, 200); project = await saved.json() as Project;
    const names = ['Bond housing shells', 'Install drive shaft', 'Mount actuator bracket', 'Inspect pivot'];
    const added = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: names.map((name, index) => ({ type: 'step.add', name, parts: [project.model.parts[index === 3 ? 1 : index].id] })) })); assert.equal(added.status, 200); project = (await added.json() as { project: Project }).project;
    const descriptions = ['Apply Medium CA to the seam.', 'Press the joint until the stop seats.', 'Fasten the actuator screws.', 'Check the bond and remove excess glue.'];
    const described = await fetch(`${base}/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: project.steps.map((step, index) => ({ type: 'step.description', stepId: step.id, text: descriptions[index] })) })); assert.equal(described.status, 200); project = (await described.json() as { project: Project }).project;
    const original = structuredClone(project), order = project.steps.map(step => step.id);
    frontend = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base } } });
    await frontend.listen(); const frontendUrl = frontend.resolvedUrls?.local[0]; assert.ok(frontendUrl);
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'no-preference' }); page.setDefaultTimeout(6000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontendUrl}?project=${project.id}`); await page.waitForFunction(id => window.manualStudio?.getProject()?.id === id && !document.querySelector('.busy-overlay'), project.id);
    await page.locator(`[data-step="${order[0]}"] .step-tag`).click();

    const hoverStyles = [], animationChecks = [];
    for (const panel of panels) {
      await expanded(page, panel); const button = page.locator(`#${panel.button}`); await button.hover();
      await page.waitForFunction(id => getComputedStyle(document.getElementById(id)!).backgroundColor === 'rgb(70, 70, 75)', panel.button);
      hoverStyles.push(await button.evaluate(element => { const style = getComputedStyle(element), glyph = element.querySelector('svg.assembly-icon')!; return { background: style.backgroundColor, shadow: style.boxShadow, width: style.width, height: style.height, radius: style.borderRadius, iconWidth: getComputedStyle(glyph).width, iconHeight: getComputedStyle(glyph).height }; }));
      const from = (await panelState(page, panel)).height;
      const tracing = page.evaluate(id => new Promise<{ duration: number | undefined; samples: number[] }>(resolve => {
        const element = document.getElementById(id)!, toggle = element.querySelector('[data-panel-toggle]')!;
        const inspect = (event: MouseEvent): void => {
          if (!(event.target instanceof Node) || !toggle.contains(event.target)) return;
          document.removeEventListener('click', inspect);
          void (async () => {
            const duration = element.getAnimations()[0]?.effect?.getTiming().duration, samples: number[] = [], start = performance.now();
            while (performance.now() - start < 230) { samples.push(element.getBoundingClientRect().height); await new Promise<void>(paint => requestAnimationFrame(() => paint())); }
            resolve({ duration: typeof duration === 'number' ? duration : undefined, samples });
          })();
        };
        document.addEventListener('click', inspect);
      }), panel.id);
      await button.click(); const motion = await tracing;
      await collapsed(page, panel); const to = (await panelState(page, panel)).height;
      assert.equal(motion.duration, 180, `${panel.name} must animate its height.`);
      assert.ok(motion.samples.some(height => height > to + 1 && height < from - 1), `${panel.name} must pass through an intermediate height: ${JSON.stringify({ from, to, samples: motion.samples })}`);
      animationChecks.push({ panel: panel.name, from, to, duration: motion.duration });
      if (panel.id === 'guide') { assert.equal(await page.locator('#guide .timeline').count(), 1); assert.equal(await page.locator('#guide .timeline').isVisible(), false, 'Timeline belongs to the collapsed guide body.'); }
      await button.click(); await expanded(page, panel);
      if (panel.id === 'guide') assert.equal(await page.locator('#guide .timeline').isVisible(), true);
      await button.click({ clickCount: 2, delay: 40 }); await expanded(page, panel);
    }
    assert.deepEqual(hoverStyles[1], hoverStyles[0]); assert.deepEqual(hoverStyles[2], hoverStyles[0]);

    await page.locator('#structureSearchButton').click(); const search = page.locator('#structureSearch'); await search.fill('Carbon Fiber');
    assert.equal(await page.locator('#structureSearchButton').getAttribute('aria-expanded'), 'true');
    for (const panel of panels) { await page.locator(`#${panel.button}`).click(); await collapsed(page, panel); }
    await page.evaluate(id => window.manualStudio.openStep(id), order[1]);
    for (const panel of panels) await collapsed(page, panel);
    await page.locator('#nextFrame').click();
    await page.waitForFunction(id => window.manualStudio.getSession().frameId === id, project.steps[1].frames[1].id);
    for (const panel of panels) await collapsed(page, panel);
    await page.evaluate(() => window.manualStudio.openStep(null)); await collapsed(page, panels[0]); await collapsed(page, panels[1]);
    await page.evaluate(id => window.manualStudio.openStep(id), order[3]); for (const panel of panels) await collapsed(page, panel);
    await page.locator('#collapseStructure').click(); await expanded(page, panels[0]);
    assert.equal(await search.inputValue(), 'Carbon Fiber');

    const searchCases: [string, number[]][] = [['bOnD HOUSING', [0]], ['Medium CA', [0]], ['Carbon pivot', [1, 3]], ['  CARBON FIBER  ', [1, 3]], ['Hinge:1/Pivot Rod', [1, 3]], ['Step 3', [2]]];
    for (const [query, indexes] of searchCases) {
      await search.fill(query);
      assert.deepEqual(await page.locator('#structure [data-step]').evaluateAll(cards => cards.map(card => card.getAttribute('data-step'))), indexes.map(index => order[index]));
      assert.deepEqual(await page.locator('#structure [data-step] .step-tag').allTextContents(), indexes.map(index => `Step ${index + 1}`));
      assert.equal(await page.locator('#structureSearchCount').innerText(), `${indexes.length} / 4`);
      assert.ok((await page.locator('#structure [data-reorder]').evaluateAll(tags => tags.map(tag => tag.getAttribute('draggable')))).every(value => value === 'false'));
    }
    await search.fill('does-not-exist'); assert.equal(await page.locator('#structure [data-step]').count(), 0);
    assert.equal(await page.locator('.structure-empty').innerText(), 'No matching steps'); assert.equal(await page.locator('#structureSearchCount').innerText(), '0 / 4');
    await search.fill(''); assert.equal(await page.locator('#structure [data-step]').count(), 4); assert.equal(await page.locator('.structure-empty').count(), 0);
    await search.fill('Carbon Fiber'); await page.locator(`[data-step="${order[1]}"] .step-tag`).click();
    await page.waitForFunction(id => window.manualStudio.getSession().stepId === id, order[1]); assert.equal(await search.inputValue(), 'Carbon Fiber');
    assert.deepEqual(await page.locator('#structure [data-step] .step-tag').allTextContents(), ['Step 2', 'Step 4']);
    await page.locator('#structureSearchButton').click(); assert.equal(await search.isVisible(), false); assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('#structure [data-step]').count(), 4);
    assert.deepEqual(await (await fetch(`${base}/api/projects/${project.id}`)).json(), original, 'Disclosure, search and navigation must not mutate project data.');

    await page.locator('#structureSearchButton').click(); await search.fill('Carbon Fiber');
    const gap = page.locator(`[data-reorder-before="${order[3]}"]`); await gap.hover(); await page.locator(`[data-insert-before="${order[3]}"]`).click();
    await page.locator('#cancelPicker').waitFor({ state: 'visible' }); await page.locator('#cancelPicker').click();
    const inserted = await (await fetch(`${base}/api/projects/${project.id}`)).json() as Project;
    assert.equal(inserted.steps.length, 5); assert.equal(inserted.revision, original.revision + 1);
    assert.deepEqual(inserted.steps.filter(step => order.includes(step.id)), original.steps);
    assert.equal(inserted.steps[3].partIds.length, 0); assert.equal(inserted.steps[4].id, order[3]);
    assert.deepEqual(inserted.steps.slice(0, 3).map(step => step.id), order.slice(0, 3));
    assert.deepEqual(await page.locator('#structure [data-step] .step-tag').allTextContents(), ['Step 2', 'Step 5']);
    assert.deepEqual(errors, []);
    context.diagnostic(JSON.stringify({ disclosureAnimations: animationChecks, sharedHoverStyle: hoverStyles[0], collapsePersistsAcrossRenders: true, searchFieldsChecked: searchCases.length, searchDoesNotMutateProject: true, filteredInsertBeforeOriginalStep4: true }));
  } finally {
    await browser?.close(); await frontend?.close(); api.kill(); await new Promise<void>(resolve => api.once('close', () => resolve()));
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-panel-disclosure-')); await rm(resolved, { recursive: true, force: true });
  }
});
