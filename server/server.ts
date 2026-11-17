import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rename, readdir, copyFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { applyCommand, emptyProject, refreshFinalAssembly, uid, validateProject } from '../shared/document.ts';
import type { Command, Model, Part, Project, SessionState, SyncPlan } from '../shared/types.ts';
import { applySync, planSync } from './sync.ts';
import { renderInBrowser } from './render.ts';
import { fusionStatus, queueFusion, fusionJob, setFusionOrigin } from './fusion.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.env.MANUALSTUDIO_DATA ?? path.join(root, 'data'));
const modelDirectory = path.join(directory, 'models'); const projectDirectory = path.join(directory, 'projects');
const clients = new Set<ServerResponse>(); const sessions = new Map<string, SessionState>();
const syncPlans = new Map<string, { projectId: string; plan: SyncPlan }>();
const jobs = new Map<string, { id: string; projectId: string; kind: string; result?: unknown }>();
let writeQueue = Promise.resolve();
class ApiError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const json = (res: ServerResponse, value: unknown, status = 200): void => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const notify = (type: string, value: unknown): void => { for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); };
function id(value: string): string { if (!/^[\w-]+$/.test(value)) throw new ApiError(400, 'Invalid ID.'); return value; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected a JSON object.'); return value as Record<string, unknown>; }
function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || typeof p.id !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.steps) || !p.model || typeof p.model !== 'object' || !p.settings || typeof p.settings !== 'object') return false;
  const model = p.model as Record<string, unknown>;
  return typeof model.id === 'string' && Array.isArray(model.parts) && Array.isArray(model.materials) && model.parts.every(part => part && typeof part === 'object' && typeof part.id === 'string' && part.geometry && part.home && Array.isArray(part.home.position)) && p.steps.every(step => step && typeof step === 'object' && typeof step.id === 'string' && Array.isArray(step.frames) && Array.isArray(step.partIds) && Array.isArray(step.groups) && Array.isArray(step.removePartIds));
}
async function body(req: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += buffer.length; if (size > 768 * 1024 * 1024) throw new ApiError(413, 'File exceeds 768 MiB.'); chunks.push(buffer); } return Buffer.concat(chunks); }
async function payload(req: IncomingMessage): Promise<Record<string, unknown>> { try { return object(JSON.parse((await body(req)).toString()) as unknown); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Invalid JSON.'); } }
async function load(projectId: string): Promise<Project> { return JSON.parse(await readFile(path.join(projectDirectory, `${id(projectId)}.json`), 'utf8')) as Project; }
async function save(project: Project, expected?: number): Promise<Project> {
  let previous: Project | undefined; try { previous = await load(project.id); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (previous && expected !== previous.revision) throw new ApiError(409, 'The project changed. Reload the current revision and retry.');
  try { refreshFinalAssembly(project); } catch (error) { throw new ApiError(400, error instanceof Error ? error.message : String(error)); }
  const errors = validateProject(project); if (errors.length) throw new ApiError(400, errors.join('\n'));
  project.revision = (previous?.revision ?? -1) + 1; project.updatedAt = new Date().toISOString();
  await mkdir(projectDirectory, { recursive: true }); const filename = path.join(projectDirectory, `${id(project.id)}.json`);
  if (previous) { await mkdir(path.join(directory, 'backups'), { recursive: true }); await copyFile(filename, path.join(directory, 'backups', `${project.id}.json`)); }
  await writeFile(`${filename}.pending`, JSON.stringify(project)); await rename(`${filename}.pending`, filename);
  notify('project', { projectId: project.id, revision: project.revision }); return project;
}
function serialized<T>(operation: () => Promise<T>): Promise<T> { const result = writeQueue.then(operation); writeQueue = result.then(() => {}, () => {}); return result; }
async function importModel(bytes: Buffer, filename: string): Promise<Model> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { workerData: { bytes, filename, directory: modelDirectory } });
    worker.once('message', (message: { model?: Model; error?: string }) => message.model ? resolve(message.model) : reject(new Error(message.error ?? '3MF import failed.')));
    worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(new Error(`3MF importer exited with code ${code}.`)); });
  });
}
function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== 'object') return false; const c = value as Record<string, unknown>; if (typeof c.type !== 'string') return false;
  const types = ['step.add', 'step.rename', 'step.delete', 'step.reorder', 'step.copy', 'step.merge', 'step.members', 'step.group', 'step.final', 'step.description', 'part.rename', 'object.rename', 'axis.rename', 'group.rename', 'part.initial', 'part.remove', 'frame.add', 'frame.delete', 'frame.update', 'frame.cameraAll', 'note.put', 'note.update', 'note.delete', 'settings.update'];
  if (c.type === 'model.pose') return !!c.poses && typeof c.poses === 'object';
  if (!types.includes(c.type)) return false;
  if ((c.type.startsWith('step.') && c.type !== 'step.add' && c.type !== 'step.merge' || c.type.startsWith('frame.') || c.type.startsWith('note.') || c.type === 'part.remove') && typeof c.stepId !== 'string') return false;
  if (c.type === 'step.merge' && (!Array.isArray(c.stepIds) || !c.stepIds.every(id => typeof id === 'string') || new Set(c.stepIds).size < 2)) return false;
  if (['frame.delete', 'frame.update', 'note.put', 'note.update', 'note.delete'].includes(c.type) && typeof c.frameId !== 'string') return false;
  if (['step.members', 'part.initial', 'part.remove'].includes(c.type) && (!Array.isArray(c.partIds) || !c.partIds.every(p => typeof p === 'string'))) return false;
  if (['step.rename', 'part.rename', 'object.rename', 'axis.rename', 'group.rename'].includes(c.type) && typeof c.name !== 'string') return false;
  if (c.type === 'part.rename' && typeof c.partId !== 'string') return false;
  if (c.type === 'object.rename' && typeof c.nodeId !== 'string') return false;
  if (c.type === 'axis.rename' && typeof c.axisId !== 'string') return false;
  if (c.type === 'group.rename' && (typeof c.stepId !== 'string' || typeof c.groupId !== 'string')) return false;
  if (['frame.update', 'settings.update'].includes(c.type) && (!c.patch || typeof c.patch !== 'object')) return false;
  if (c.type === 'frame.update' && c.patch && typeof c.patch === 'object' && 'image' in c.patch && c.patch.image !== null && typeof c.patch.image !== 'string') return false;
  if (c.type === 'note.put' && (!c.note || typeof c.note !== 'object')) return false;
  if (c.type === 'step.final' && typeof c.value !== 'boolean') return false;
  return true;
}
async function readerFor(parts: Part[]): Promise<(part: Part) => Uint8Array> {
  const buffers = new Map<string, Uint8Array>();
  for (const file of new Set(parts.map(p => p.geometry.file))) buffers.set(file, new Uint8Array(await readFile(path.join(directory, file.replace(/^\//, '')))));
  return part => buffers.get(part.geometry.file)!;
}
async function serve(res: ServerResponse, file: string): Promise<boolean> {
  const info = await stat(file).catch(() => undefined); if (!info?.isFile()) return false;
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bin': 'application/octet-stream', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' }); createReadStream(file).pipe(res); return true;
}
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1'); const pathname = decodeURIComponent(url.pathname); const method = req.method;
  if (pathname === '/api/health') { json(res, { ok: true, application: 'ManualStudio Assembly', reference: 'Bambu Studio v02.09.01.70', data: directory }); return; }
  if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
  if (pathname === '/api/fusion/status' && method === 'GET') { json(res, await fusionStatus(directory)); return; }
  if (pathname === '/api/fusion/import' && method === 'POST') {
    if (url.searchParams.has('name')) {
      if (!url.searchParams.get('name')!.toLowerCase().endsWith('.f3d')) throw new ApiError(400, 'Choose a native F3D archive.');
      const projectId = url.searchParams.get('project'); const project = projectId ? await load(projectId) : undefined;
      json(res, await queueFusion(directory, undefined, project, await body(req), url.searchParams.get('name')!)); return;
    }
    const p = await payload(req); const project = typeof p.projectId === 'string' ? await load(p.projectId) : undefined;
    if (p.metadataOnly === true && !project) throw new ApiError(400, 'Choose a project before refreshing Fusion metadata.');
    json(res, await queueFusion(directory, typeof p.fileId === 'string' ? p.fileId : project?.model.source?.fileId, project, undefined, undefined, p.metadataOnly === true)); return;
  }
  const fusionMatch = /^\/api\/fusion\/jobs\/([\w-]+)$/.exec(pathname);
  if (fusionMatch && method === 'GET') {
    const result = await serialized(async () => {
      const job = await fusionJob(directory, fusionMatch[1]); if (job.status.state !== 'complete' || job.status.projectId || job.status.syncPlanId) return job.status;
      const model = JSON.parse(await readFile(path.join(modelDirectory, id(job.request.modelId), 'model.json'), 'utf8')) as Model;
      if (!model.parts.length || !model.source || !model.constructionAxes) throw new ApiError(400, 'The native Fusion export is incomplete.');
      if (job.request.archiveName) { model.sourceFile = path.basename(job.request.archiveName); model.name = path.basename(model.sourceFile, path.extname(model.sourceFile)); model.source.documentName = model.name; await writeFile(path.join(modelDirectory, model.id, 'model.json'), JSON.stringify(model)); }
      let result: { projectId: string } | { syncPlanId: string };
      if (job.request.projectId) {
        const project = await load(job.request.projectId);
        if (project.model.source?.originOffset) { setFusionOrigin(model, project.model.source.originOffset); await writeFile(path.join(modelDirectory, model.id, 'model.json'), JSON.stringify(model)); }
        const read = await readerFor([...project.model.parts, ...model.parts]); const plan = planSync(project, model, read);
        syncPlans.set(plan.id, { projectId: project.id, plan }); result = { syncPlanId: plan.id };
      } else { const project = await save(emptyProject(model)); result = { projectId: project.id }; }
      const completed = { ...job.status, ...result, metrics: model.importMetrics };
      await writeFile(path.join(job.folder, 'result.json'), JSON.stringify(completed)); return completed;
    }); json(res, result); return;
  }
  if (pathname === '/api/projects' && method === 'GET') { await mkdir(projectDirectory, { recursive: true }); const projects = await Promise.all((await readdir(projectDirectory)).filter(f => f.endsWith('.json')).map(async f => { const p = await load(f.slice(0, -5)); return { id: p.id, name: p.name, revision: p.revision, parts: p.model.parts.length, steps: p.steps.length }; })); json(res, projects); return; }
  if (pathname === '/api/import' && method === 'POST') {
    const model = await importModel(await body(req), url.searchParams.get('name') ?? 'Model.3mf');
    const project = await serialized(() => save(emptyProject(model))); json(res, project); return;
  }
  const archiveMatch = /^\/api\/projects\/([\w-]+)\/archive$/.exec(pathname);
  if (archiveMatch && method === 'GET') {
    const project = await load(archiveMatch[1]); const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(project)) };
    for (const file of new Set([...project.model.parts.map(p => p.geometry.file), ...(project.model.source?.archiveFile ? [project.model.source.archiveFile] : [])])) files[file.slice(1)] = new Uint8Array(await readFile(path.join(directory, file.slice(1))));
    const bytes = zipSync(files, { level: 3 }); res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length }); res.end(bytes); return;
  }
  if (pathname === '/api/open-archive' && method === 'POST') {
    const archive = unzipSync(new Uint8Array(await body(req))); if (!archive['project.json']) throw new ApiError(400, 'Project archive has no project.json.');
    const project: unknown = JSON.parse(strFromU8(archive['project.json'])); if (!isProject(project)) throw new ApiError(400, 'Invalid project document.');
    for (const file of new Set([...project.model.parts.map(p => p.geometry.file), ...(project.model.source?.archiveFile ? [project.model.source.archiveFile] : [])])) {
      const relative = file.replace(/^\//, ''); const target = path.resolve(directory, relative); const within = path.relative(modelDirectory, target);
      if (within.startsWith('..') || path.isAbsolute(within) || !archive[relative]) throw new ApiError(400, `Invalid geometry entry ${relative}.`);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, archive[relative]);
    }
    project.id = uid('project'); json(res, await serialized(() => save(project))); return;
  }
  const match = /^\/api\/projects\/([\w-]+)(?:\/(commands|session|sync))?$/.exec(pathname);
  if (match) {
    const projectId = match[1]; const action = match[2];
    if (!action && method === 'GET') { json(res, await load(projectId)); return; }
    if (!action && method === 'PUT') { const p = await payload(req); const project = p.project; if (!isProject(project) || project.id !== projectId) throw new ApiError(400, 'Invalid project.'); json(res, await serialized(() => save(project, Number(p.expectedRevision)))); return; }
    if (action === 'commands' && method === 'POST') {
      const p = await payload(req); if (!Array.isArray(p.commands) || !p.commands.every(isCommand)) throw new ApiError(400, 'Invalid command.'); const commands = p.commands;
      const result = await serialized(async () => {
        const project = await load(projectId); if (p.expectedRevision !== project.revision) throw new ApiError(409, 'The project revision changed.');
        const order = project.steps.map(step => step.id), results = commands.map(command => applyCommand(project, command));
        const unchangedReorder = commands.every(command => command.type === 'step.reorder') && project.steps.every((step, index) => step.id === order[index]);
        return { project: unchangedReorder ? project : await save(project, project.revision), results };
      }); json(res, result); return;
    }
    if (action === 'session' && method === 'GET') { json(res, sessions.get(projectId) ?? null); return; }
    if (action === 'session' && method === 'PUT') {
      const p = await payload(req); const previous = sessions.get(projectId); const navigates = 'stepId' in p || 'frameId' in p || 'frameProgress' in p;
      if (p.frameProgress !== undefined && (typeof p.frameProgress !== 'number' || !Number.isFinite(p.frameProgress) || p.frameProgress < 0 || p.frameProgress >= 1)) throw new Error('Frame progress must be between 0 (inclusive) and 1 (exclusive).');
      const current = { ...previous, ...p, ...(navigates && p.playing === undefined ? { playing: false } : {}) } as SessionState;
      if (navigates && p.frameProgress === undefined) delete current.frameProgress;
      if ('stepId' in p && p.stepId !== previous?.stepId) {
        if (p.section === undefined) { current.section = 0; p.section = 0; }
        if (p.sectionNormal === undefined) delete current.sectionNormal;
        if (p.selected === undefined) { current.selected = []; p.selected = []; }
      }
      const origin = req.headers['x-manualstudio-session-origin']; sessions.set(projectId, current);
      notify('session', { projectId, state: current, changes: p, origin: typeof origin === 'string' ? origin : undefined }); json(res, current); return;
    }
    if (action === 'sync' && method === 'POST') {
      const model = await importModel(await body(req), url.searchParams.get('name') ?? 'Updated Model.3mf');
      const project = await load(projectId); const read = await readerFor([...project.model.parts, ...model.parts]);
      const plan = planSync(project, model, read); syncPlans.set(plan.id, { projectId, plan }); json(res, plan); return;
    }
  }
  const syncRead = /^\/api\/sync\/([\w-]+)$/.exec(pathname);
  if (syncRead && method === 'GET') { const entry = syncPlans.get(syncRead[1]); if (!entry) throw new ApiError(404, 'Sync preview expired. Import the update again.'); json(res, entry.plan); return; }
  const sync = /^\/api\/sync\/([\w-]+)\/(resolve|apply)$/.exec(pathname);
  if (sync && method === 'POST') {
    const entry = syncPlans.get(sync[1]); if (!entry) throw new ApiError(404, 'Sync preview expired. Import the update again.');
    const p = await payload(req);
    if (sync[2] === 'resolve') {
      const mapping = object(p.mapping); if (Object.values(mapping).some(v => typeof v !== 'string')) throw new ApiError(400, 'Mapping values must be part IDs or new.');
      const project = await load(entry.projectId); const read = await readerFor([...project.model.parts, ...entry.plan.model.parts]);
      const plan = planSync(project, entry.plan.model, read, mapping as Record<string, string>); syncPlans.set(plan.id, { projectId: project.id, plan }); json(res, plan); return;
    }
    const project = await serialized(async () => { const previous = await load(entry.projectId); const read = await readerFor([...previous.model.parts, ...entry.plan.model.parts]); return save(applySync(previous, entry.plan, read), previous.revision); }); syncPlans.delete(sync[1]); json(res, project); return;
  }
  if (pathname === '/api/render' && method === 'POST') {
    const p = await payload(req); const job: { id: string; projectId: string; kind: string; result?: unknown } = { id: uid('render'), projectId: String(p.projectId), kind: String(p.kind ?? 'png') };
    if (!['png', 'pdf', 'markdown', 'mp4', 'json'].includes(job.kind)) throw new ApiError(400, 'Unsupported export kind.');
    await load(job.projectId); jobs.set(job.id, job);
    if (p.renderer !== 'external') { const address = server.address(); const port = address && typeof address === 'object' ? address.port : 4189; void renderInBrowser(`http://127.0.0.1:${port}`, job.projectId, job.id).catch(error => { job.result = { error: error instanceof Error ? error.message : String(error) }; }); }
    json(res, job); return;
  }
  const jobMatch = /^\/api\/render\/([\w-]+)$/.exec(pathname);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]); if (!job) throw new ApiError(404, 'Render job not found.');
    if (method === 'POST') { const p = await payload(req); if (typeof p.data === 'string' && typeof p.filename === 'string') { const extension = path.extname(p.filename).replace(/[^.a-z0-9]/gi, '') || '.bin'; const exportDirectory = path.join(directory, 'exports'); await mkdir(exportDirectory, { recursive: true }); const filename = `${job.id}${extension}`; const bytes = Buffer.from(p.data, 'base64'); await writeFile(path.join(exportDirectory, filename), bytes); job.result = { filename: p.filename, url: `/exports/${filename}`, path: path.join(exportDirectory, filename), bytes: bytes.length }; } else job.result = p; }
    json(res, job); return;
  }
  if (pathname === '/api/export/video' && method === 'POST') {
    const exportDirectory = path.join(directory, 'exports'); await mkdir(exportDirectory, { recursive: true }); const name = uid('assembly'); const input = path.join(exportDirectory, `${name}${req.headers['content-type'] === 'video/x-ivf' ? '.ivf' : '.webm'}`); const output = path.join(exportDirectory, `${name}.mp4`); await writeFile(input, await body(req));
    await new Promise<void>((resolve, reject) => { const process = spawn('ffmpeg', ['-y', '-i', input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-r', '30', '-fps_mode', 'cfr', '-movflags', '+faststart', output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let errorText = ''; process.stderr.on('data', data => { errorText = (errorText + String(data)).slice(-3000); }); process.on('error', reject); process.on('exit', code => code === 0 ? resolve() : reject(new Error(errorText))); }); json(res, { url: `/exports/${name}.mp4` }); return;
  }
  if (pathname.startsWith('/api/')) throw new ApiError(404, 'Unknown API route.');
  const base = pathname.startsWith('/models/') || pathname.startsWith('/exports/') ? directory : path.join(root, 'dist');
  const file = path.resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`); const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError(400, 'Invalid file path.');
  if (await serve(res, file)) return;
  throw new ApiError(404, 'File not found. Build ManualStudio before opening the workspace.');
}
export const server = http.createServer((req, res) => { route(req, res).catch(error => { if (res.headersSent) { res.end(); return; } json(res, { error: error instanceof Error ? error.message : String(error) }, error instanceof ApiError ? error.status : 500); }); });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MANUALSTUDIO_PORT ?? 4189); server.listen(port, '127.0.0.1', () => { const address = server.address(); console.log(`ManualStudio Assembly: http://127.0.0.1:${address && typeof address === 'object' ? address.port : port}`); });
}
