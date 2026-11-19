import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const windows = process.platform === 'win32';
const ffmpegVersion = '9.0.2';
const ffmpegPackage = `ffmpeg-${ffmpegVersion}-essentials_build`;
const dependenciesDirectory = fileURLToPath(new URL('../.local/dependencies/', import.meta.url));
const mediaDirectory = path.join(dependenciesDirectory, ffmpegPackage);
export const mediaDownload = {
  version: ffmpegVersion,
  url: `https://github.com/GyanD/codexffmpeg/releases/download/${ffmpegVersion}/${ffmpegPackage}.zip`,
  supported: windows && process.arch === 'x64',
};
export const mediaRequirement = 'FFmpeg 5.1 or newer with libx264 and ffprobe';
export const chromePackage = 'Google.Chrome';
export const pythonPackage = 'Python.Python.3.14';

type MediaTool = 'ffmpeg' | 'ffprobe';

function mediaBinary(directory: string, tool: MediaTool): string {
  return path.join(directory, 'bin', `${tool}.exe`);
}

async function isFile(filename: string): Promise<boolean> {
  return stat(filename).then(info => info.isFile(), () => false);
}

export async function mediaCommand(tool: MediaTool): Promise<string> {
  const binary = mediaBinary(mediaDirectory, tool);
  return windows && await isFile(binary) ? binary : tool;
}

async function mediaAvailable(encoder: string, probe: string, version?: string): Promise<boolean> {
  try {
    const options = { windowsHide: true, timeout: 5000 };
    const [{ stdout }, { stdout: encoders }, { stdout: probeVersion }] = await Promise.all([
      execute(encoder, ['-version'], options),
      execute(encoder, ['-hide_banner', '-encoders'], options),
      execute(probe, ['-version'], options),
    ]);
    const release = /^ffmpeg version (?:n)?(\d+)\.(\d+)(?:\.(\d+))?/m.exec(stdout);
    const probeRelease = /^ffprobe version (?:n)?(\d+)\.(\d+)(?:\.(\d+))?/m.exec(probeVersion);
    if (!release || !probeRelease || !/\blibx264\b/.test(encoders)) return false;
    if (version) return release.slice(1, 4).join('.') === version && probeRelease.slice(1, 4).join('.') === version;
    const major = Number(release[1]), minor = Number(release[2]);
    return major > 5 || (major === 5 && minor >= 1);
  } catch { return false; }
}

export async function mediaToolsReady(): Promise<boolean> {
  return mediaAvailable(await mediaCommand('ffmpeg'), await mediaCommand('ffprobe'));
}

export async function installMediaTools(): Promise<void> {
  await mkdir(dependenciesDirectory, { recursive: true });
  const staging = await mkdtemp(path.join(dependenciesDirectory, 'ffmpeg-download-'));
  try {
    const archive = path.join(staging, `${ffmpegPackage}.zip`);
    await execute('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '300', '--output', archive, mediaDownload.url], { windowsHide: true });
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:MANUALSTUDIO_MEDIA_ZIP -DestinationPath $env:MANUALSTUDIO_MEDIA_STAGING'], {
      env: { ...process.env, MANUALSTUDIO_MEDIA_ZIP: archive, MANUALSTUDIO_MEDIA_STAGING: staging }, windowsHide: true,
    });
    const extracted = path.join(staging, ffmpegPackage);
    if (!await mediaAvailable(mediaBinary(extracted, 'ffmpeg'), mediaBinary(extracted, 'ffprobe'), mediaDownload.version)) {
      throw new Error('The package is missing the expected FFmpeg, libx264, or ffprobe.');
    }
    await rename(extracted, mediaDirectory).catch(async error => {
      if (!await mediaAvailable(mediaBinary(mediaDirectory, 'ffmpeg'), mediaBinary(mediaDirectory, 'ffprobe'), mediaDownload.version)) throw error;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not install FFmpeg ${mediaDownload.version}. ${detail} Download source: ${mediaDownload.url}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function findBrowser(chromeOnly = false): Promise<string | undefined> {
  const candidates = [process.env.MANUALSTUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    chromeOnly ? undefined : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  for (const candidate of candidates) if (candidate && await isFile(candidate)) return candidate;
  return undefined;
}

export async function pythonReady(): Promise<boolean> {
  return execute('python', ['-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { windowsHide: true, timeout: 5000 })
    .then(() => true, () => false);
}
