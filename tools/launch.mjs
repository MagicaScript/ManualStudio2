import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.MANUALSTUDIO_PORT ?? 4189);
const url = `http://127.0.0.1:${port}`;
async function health() { try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }); return await response.json(); } catch { return undefined; } }
let state = await health();
if (state && state.application !== 'ManualStudio Assembly') throw new Error(`Port ${port} is already in use by another application.`);
if (!state) {
  await mkdir(path.join(root, '.local'), { recursive: true });
  const output = await open(path.join(root, '.local/server.stdout.log'), 'a'); const errors = await open(path.join(root, '.local/server.stderr.log'), 'a');
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], { cwd: root, env: { ...process.env, MANUALSTUDIO_PORT: String(port) }, detached: true, windowsHide: true, stdio: ['ignore', output.fd, errors.fd] });
  child.unref(); await output.close(); await errors.close();
  await writeFile(path.join(root, '.local/server.pid'), String(child.pid));
  for (let attempt = 0; attempt < 30 && !state; attempt++) { await new Promise(resolve => setTimeout(resolve, 300)); state = await health(); }
  if (!state) throw new Error('ManualStudio could not start. See .local/server.stderr.log.');
}
console.log(`ManualStudio Assembly: ${url}`);
if (!process.argv.includes('--no-browser')) {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  const { access } = await import('node:fs/promises'); let browser;
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true, () => false)) { browser = candidate; break; }
  if (!browser) throw new Error(`Chrome was not found. Open ${url} in your browser.`);
  spawn(browser, [url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
