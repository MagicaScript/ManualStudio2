import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2); const base = process.env.MANUALSTUDIO_URL ?? 'http://127.0.0.1:4189';
async function request(route: string, init?: RequestInit): Promise<unknown> { const response = await fetch(base + route, init); const data: unknown = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data; }
function asObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object response.'); return value as Record<string, unknown>; }
const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function readJson(input: string | undefined): Promise<unknown> {
  if (!input) throw new Error('Provide JSON or a path to a JSON file.');
  const first = input.trimStart()[0];
  return JSON.parse(first === '{' || first === '[' ? input : await readFile(input, 'utf8'));
}
async function main(): Promise<void> {
  const [command, projectId, input, display] = args;
  if (!command || command === 'help') { console.log(`ManualStudio CLI\n\nhealth\nfusion-status\nfusion-import [cloud-file-id]\nfusion-sync <project-id> [cloud-file-id]\nfusion-refresh-metadata <project-id>\nfusion-job <job-id>\nfusion-plan <sync-plan-id>\nimport-f3d <model.f3d>\nprojects\nget <project-id> [output.json]\nimport <model.3mf>\ncommand <project-id> <command.json or JSON> [--preview]\ngeometry <project-id> <query.json or JSON>\nmotion-check <project-id> <check.json or JSON>\nsync <project-id> <updated.3mf>\nsync-resolve <sync-id> <mapping.json>\nsync-apply <sync-id>\nselect <project-id> <part-id,...>\nopen-step <project-id> <step-id>\nrender <project-id> [png|pdf|markdown|mp4|json] [xray|current|all] [scope.json or JSON]\nrender-status <job-id>\nlabel-layout <project-id> <frame-id> [progress,...] [xray|current|all]\n\nSet MANUALSTUDIO_URL to change the local server. Commands use optimistic revision checks.`); return; }
  let result: unknown;
  switch (command) {
    case 'health': result = await request('/api/health'); break;
    case 'fusion-status': result = await request('/api/fusion/status'); break;
    case 'fusion-import': result = await request('/api/fusion/import', post({ fileId: projectId })); break;
    case 'fusion-sync': result = await request('/api/fusion/import', post({ projectId, fileId: input })); break;
    case 'fusion-refresh-metadata': result = await request('/api/fusion/import', post({ projectId, metadataOnly: true })); break;
    case 'fusion-job': result = await request(`/api/fusion/jobs/${projectId}`); break;
    case 'fusion-plan': result = await request(`/api/sync/${projectId}`); break;
    case 'import-f3d': { const bytes = await readFile(projectId); result = await request(`/api/fusion/import?name=${encodeURIComponent(path.basename(projectId))}`, { method: 'POST', body: bytes }); break; }
    case 'projects': result = await request('/api/projects'); break;
    case 'get': result = await request(`/api/projects/${projectId}`); if (input) { await writeFile(input, JSON.stringify(result, null, 2)); result = { saved: path.resolve(input) }; } break;
    case 'import': { const bytes = await readFile(projectId); result = await request(`/api/import?name=${encodeURIComponent(path.basename(projectId))}`, { method: 'POST', body: bytes }); break; }
    case 'command': {
      const commands = await readJson(input), project = asObject(await request(`/api/projects/${projectId}`));
      if (display !== undefined && display !== '--preview') throw new Error('Expected --preview after the command input.');
      result = await request(`/api/projects/${projectId}/commands`, post({ expectedRevision: project.revision, commands: Array.isArray(commands) ? commands : [commands], preview: display === '--preview' }));
      break;
    }
    case 'geometry':
    case 'motion-check': result = await request(`/api/projects/${projectId}/${command}`, post(await readJson(input))); break;
    case 'sync': { const bytes = await readFile(input); result = await request(`/api/projects/${projectId}/sync?name=${encodeURIComponent(path.basename(input))}`, { method: 'POST', body: bytes }); break; }
    case 'sync-resolve': result = await request(`/api/sync/${projectId}/resolve`, post({ mapping: JSON.parse(await readFile(input, 'utf8')) as unknown })); break;
    case 'sync-apply': result = await request(`/api/sync/${projectId}/apply`, post({})); break;
    case 'select': result = await request(`/api/projects/${projectId}/session`, { ...post({ selected: input.split(',') }), method: 'PUT' }); break;
    case 'open-step': result = await request(`/api/projects/${projectId}/session`, { ...post({ stepId: input, frameId: null }), method: 'PUT' }); break;
    case 'render': {
      const scope = args[4] === undefined ? undefined : await readJson(args[4]);
      result = await request('/api/render', post({ projectId, kind: input ?? 'png', display, scope })); break;
    }
    case 'render-status': result = await request(`/api/render/${projectId}`); break;
    case 'label-layout': {
      if (!projectId || !input) throw new Error('Usage: label-layout <project-id> <frame-id> [progress,...] [xray|current|all]');
      const progress = (args[3] ?? '0').split(',').map(value => value.trim() ? Number(value) : NaN);
      const job = asObject(await request('/api/render', post({ projectId, kind: 'label-layout', frameId: input, progress, display: args[4] })));
      if (typeof job.id !== 'string') throw new Error('Label layout job did not return an ID.');
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        const status = asObject(await request(`/api/render/${job.id}`));
        if (status.result) {
          const render = asObject(status.result);
          if (typeof render.error === 'string') throw new Error(render.error);
          result = render.layout; break;
        }
        await delay(200);
      }
      if (!result) throw new Error(`Label layout job ${job.id} did not return coordinates.`);
      break;
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
