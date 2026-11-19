import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/dependencies.ts';
/** A separate renderer gives the CLI full exports without using or changing an author's browser. */
export async function renderInBrowser(base: string, projectId: string, jobId: string): Promise<void> {
  const executablePath = await findBrowser();
  if (!executablePath) throw new Error('Chrome or Edge was not found. Set MANUALSTUDIO_CHROME to its executable path.');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/?project=${encodeURIComponent(projectId)}&render=${encodeURIComponent(jobId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.renderComplete === 'true', undefined, { timeout: 600000 });
  } finally { await browser.close(); }
}
