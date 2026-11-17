import { chromium } from 'playwright-core';
import { access } from 'node:fs/promises';
import path from 'node:path';

async function chromeExecutable(): Promise<string | undefined> {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  for (const candidate of candidates) { if (!candidate) continue; if (await access(candidate).then(() => true, () => false)) return candidate; }
  return undefined;
}
/** A separate renderer gives the CLI full exports without using or changing an author's browser. */
export async function renderInBrowser(base: string, projectId: string, jobId: string): Promise<void> {
  const executablePath = await chromeExecutable();
  if (!executablePath) throw new Error('Chrome or Edge was not found. Set MANUALSTUDIO_CHROME to its executable path.');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/?project=${encodeURIComponent(projectId)}&render=${encodeURIComponent(jobId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.renderComplete === 'true', undefined, { timeout: 600000 });
  } finally { await browser.close(); }
}
