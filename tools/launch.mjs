import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromePackage, findBrowser, installMediaTools, mediaDownload, mediaRequirement, mediaToolsReady, pythonPackage, pythonReady } from './dependencies.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const local = path.join(root, '.local');
const windows = process.platform === 'win32';
const args = process.argv.slice(2);
const testSetup = args.includes('--test-setup');
const port = Number(process.env.MANUALSTUDIO_PORT ?? 4189);
const url = `http://127.0.0.1:${port}`;

function whenMissing(error) {
  if (error.code !== 'ENOENT') throw error;
}

async function dependenciesReady() {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const required = Object.entries(lock.packages).filter(([name, entry]) => name && !entry.optional);
  const installed = await Promise.all(required.map(async ([name, entry]) => {
    const manifest = await readFile(path.join(root, name, 'package.json'), 'utf8').catch(whenMissing);
    try { return Boolean(manifest) && JSON.parse(manifest).version === entry.version; }
    catch { return false; }
  }));
  const suffix = windows ? '.cmd' : '';
  const tools = await Promise.all(['tsc', 'vite'].map(name => stat(path.join(root, 'node_modules', '.bin', name + suffix)).catch(whenMissing)));
  return installed.every(Boolean) && tools.every(tool => tool?.isFile());
}

async function readBuild() {
  const html = await readFile(path.join(dist, 'index.html'), 'utf8').catch(whenMissing);
  if (!html) return;
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1]);
  if (!assets.some(asset => asset.endsWith('.js'))) return;
  const files = await Promise.all(assets.map(asset => stat(path.join(dist, asset)).catch(whenMissing)));
  if (files.every(file => file?.isFile() && file.size > 0)) return { html, assets };
}

async function inputChanged(file, builtAt) {
  const info = await stat(file).catch(whenMissing);
  if (!info) return false;
  if (info.mtimeMs > builtAt) return true;
  if (!info.isDirectory()) return false;
  for (const name of await readdir(file)) {
    if (await inputChanged(path.join(file, name), builtAt)) return true;
  }
  return false;
}

async function confirmSetup() {
  if (args.includes('--yes')) return true;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('Continue with setup? [Y/n] ');
    for await (const line of input) {
      const answer = line.trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      process.stdout.write('Enter Y or N: ');
    }
    throw new Error('Setup requires confirmation. Run Open ManualStudio.cmd in a terminal or pass --yes.');
  } finally {
    input.close();
  }
}

async function runNpm(npmArgs, failure) {
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const commandArgs = windows ? ['/d', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
  console.log(`> npm ${npmArgs.join(' ')}`);
  const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit' });
  const [code, signal] = await once(child, 'close').catch(error => {
    throw new Error(`${failure} Could not run npm: ${error.message}`);
  });
  if (code !== 0) throw new Error(`${failure} npm exited with ${signal ?? `code ${code}`}. See the npm output above.`);
}

async function installWithWinGet(packageId, label, sourceUrl) {
  const manual = `Install ${label} from ${sourceUrl}, then run Open ManualStudio.cmd again.`;
  if (!windows) throw new Error(manual);
  const child = spawn('winget.exe', ['install', '--id', packageId, '--exact', '--source', 'winget'], { stdio: 'inherit' });
  const [code] = await once(child, 'close').catch(error => {
    throw new Error(`Could not run WinGet: ${error.message}. ${manual}`);
  });
  if (code !== 0) throw new Error(`WinGet could not install ${label}. ${manual}`);
}

async function prepareWorkspace() {
  const needsBrowser = testSetup || !args.includes('--no-browser');
  const [npmReady, build, mediaReady, browser, python] = await Promise.all([
    dependenciesReady(), readBuild(), mediaToolsReady(), needsBrowser ? findBrowser(testSetup) : undefined, testSetup ? pythonReady() : true,
  ]);
  const install = !npmReady;
  const installBrowser = needsBrowser && !browser;
  const installMedia = !mediaReady;
  if (installMedia && !mediaDownload.supported) {
    throw new Error(`Install ${mediaRequirement} on PATH. Automatic FFmpeg installation requires Windows x64.`);
  }
  let rebuild = install || !build;
  if (!install && build) {
    const { mtimeMs } = await stat(path.join(dist, 'index.html'));
    const inputs = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'src', 'shared', 'public'];
    rebuild = (await Promise.all(inputs.map(file => inputChanged(path.join(root, file), mtimeMs)))).some(Boolean);
  }
  if (!rebuild && !installMedia && !installBrowser && python) return build;
  console.log('ManualStudio setup');
  if (install) console.log('  Install the locked npm dependencies. This replaces node_modules.');
  if (rebuild) console.log(`  Build the browser interface. ${build ? 'The existing build needs updating.' : 'dist/index.html or its entry assets are missing.'}`);
  if (installMedia) console.log(`  Download FFmpeg ${mediaDownload.version} Essentials with ffprobe into .local/dependencies.`);
  if (installBrowser) console.log(`  Install Google Chrome Stable with WinGet (${chromePackage}).`);
  if (!python) console.log(`  Install CPython 3.14 with WinGet (${pythonPackage}).`);
  if (!await confirmSetup()) {
    console.log('Setup cancelled. Run Open ManualStudio.cmd to try again.');
    return;
  }
  if (install) {
    await runNpm(['ci', '--include=dev', '--include=optional', '--prefer-offline', '--no-audit', '--no-fund'],
      'Dependency installation failed. Check that npm is available and can reach the configured registry.');
  }
  if (installMedia) {
    console.log(`Downloading FFmpeg ${mediaDownload.version} from ${mediaDownload.url}`);
    await installMediaTools();
  }
  if (installBrowser) await installWithWinGet(chromePackage, 'Google Chrome Stable', 'https://www.google.com/chrome/');
  if (!python) {
    await installWithWinGet(pythonPackage, 'CPython 3.14', 'https://www.python.org/downloads/windows/');
    console.log('Open a new terminal to use the installed Python before running npm test.');
  }
  if (!rebuild) return build;
  await runNpm(['run', 'build'], 'The browser build failed.');
  const prepared = await readBuild();
  if (!prepared) throw new Error('The build completed without a usable dist/index.html and entry assets. Check the build output above.');
  return prepared;
}

async function request(route, options) {
  return fetch(url + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(2000) });
}

async function serverIsRunning() {
  const response = await request('/api/health').catch(error => {
    if (error.cause?.code === 'ECONNREFUSED') return;
    throw new Error(`Could not check ${url}: ${error.cause?.code ?? error.message}. Check the process on port ${port} or set MANUALSTUDIO_PORT.`);
  });
  if (!response) return false;
  const state = await response.json().catch(() => undefined);
  if (response.ok && state?.ok === true && state.application === 'ManualStudio Assembly') return true;
  throw new Error(`Port ${port} is already in use by another application. Close it or set MANUALSTUDIO_PORT to a free port.`);
}

async function startServer() {
  await mkdir(local, { recursive: true });
  const output = await open(path.join(local, 'server.stdout.log'), 'a');
  let errors;
  let child;
  try {
    errors = await open(path.join(local, 'server.stderr.log'), 'a');
    child = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output.fd, errors.fd],
    });
    await once(child, 'spawn');
    child.unref();
  } finally {
    await Promise.all([output.close(), errors?.close()]);
  }
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt++) {
    if (await serverIsRunning()) {
      await writeFile(path.join(local, 'server.pid'), String(child.pid));
      return;
    }
    await delay(300);
  }
  throw new Error(`ManualStudio could not start on port ${port}. See .local/server.stderr.log.`);
}

async function verifyWorkspace(build) {
  const response = await request('/');
  if (!response.ok) throw new Error(`The server at ${url} cannot serve the workspace (HTTP ${response.status}). Check that it is running from this checkout.`);
  if (!response.headers.get('content-type')?.startsWith('text/html') || await response.text() !== build.html) {
    throw new Error(`The server at ${url} is serving a different workspace build. Stop that server or set MANUALSTUDIO_PORT to a free port.`);
  }
  const assets = await Promise.all(build.assets.map(asset => request(asset, { method: 'HEAD' })));
  const missing = assets.findIndex(response => !response.ok);
  if (missing !== -1) throw new Error(`The server at ${url} cannot serve ${build.assets[missing]}. Check that it is running from this checkout.`);
}

async function openBrowser() {
  const browser = await findBrowser();
  if (!browser) throw new Error(`Chrome or Edge was not found. Open ${url} in a browser or set MANUALSTUDIO_CHROME to its executable path.`);
  const child = spawn(browser, [url], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn').catch(error => {
    throw new Error(`Could not open the browser: ${error.message}. Open ${url} manually.`);
  });
  child.unref();
}

async function launch() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error(`Node.js 22.18 or newer is required. Found ${process.version}.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MANUALSTUDIO_PORT must be an integer from 1 to 65535.');
  const build = await prepareWorkspace();
  if (!build) return;
  if (testSetup) {
    console.log('ManualStudio test setup complete. Run npm test to validate the workspace.');
    return;
  }
  if (!await serverIsRunning()) await startServer();
  await verifyWorkspace(build);
  console.log(`ManualStudio Assembly: ${url}`);
  if (!args.includes('--no-browser')) await openBrowser();
}

await launch().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
