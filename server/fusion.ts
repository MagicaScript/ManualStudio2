import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uid } from '../shared/document.ts';
import type { FusionImportMetrics, Model, Project, Vec3 } from '../shared/types.ts';

export interface FusionBridgeState { connected: boolean; updatedAt?: string; documentName?: string; fileId?: string; version?: number; latestVersion?: number; modified?: boolean }
export interface FusionJobState { id: string; state: 'queued' | 'running' | 'complete' | 'failed'; phase?: string; progress?: number; completed?: number; total?: number; error?: string; projectId?: string; syncPlanId?: string; modelId?: string; unchanged?: boolean; metrics?: FusionImportMetrics }
interface FusionRequest { modelId: string; fileId?: string; archivePath?: string; archiveName?: string; projectId?: string; metadataOnly?: boolean; knownParts: Pick<Model['parts'][number], 'sourceKey' | 'nativeToken' | 'occurrenceToken' | 'nativeRevision' | 'nativeTransform' | 'geometry' | 'home' | 'bounds' | 'explosionOffset'>[]; knownAxes: Model['constructionAxes']; knownTree?: Model['browserTree']; source?: Model['source'] }
/** Preserve the authored project origin when replacing an earlier mesh source with native Fusion data. */
export function setFusionOrigin(model: Model, offset: Vec3): void {
  if (!model.source) throw new Error('The model is not a native Fusion source.');
  const previous = model.source.originOffset ?? [0, 0, 0]; const delta = offset.map((value, i) => value - previous[i]);
  model.parts.forEach(part => { part.home.position = part.home.position.map((value, i) => value + delta[i]) as Vec3; part.bounds = part.bounds.map(point => point.map((value, i) => value + delta[i]) as Vec3) as [Vec3, Vec3]; });
  model.constructionAxes?.forEach(axis => { axis.origin = axis.origin.map((value, i) => value + delta[i]) as Vec3; });
  model.source.originOffset = [...offset];
}
export async function fusionStatus(directory: string): Promise<FusionBridgeState> {
  const data = await readFile(path.join(directory, 'fusion/bridge.json'), 'utf8').catch(() => undefined);
  if (!data) return { connected: false }; const state = JSON.parse(data) as FusionBridgeState;
  return { ...state, connected: !!state.updatedAt && Date.now() - Date.parse(state.updatedAt) < 15000 };
}
export async function queueFusion(directory: string, fileId?: string, project?: Project, archive?: Uint8Array, archiveName?: string, metadataOnly = false): Promise<FusionJobState> {
  if (!(await fusionStatus(directory)).connected) throw new Error('Start ManualStudio Bridge in Fusion Scripts and Add-ins before importing native models.');
  if (metadataOnly && (!project?.model.source?.versionId || archive)) throw new Error('Reference metadata refresh requires an imported saved Fusion cloud version.');
  if (metadataOnly && project?.model.source?.contentScope !== 'brep-bodies-and-axes') throw new Error('Sync the complete Fusion model before refreshing reference metadata.');
  const jobId = uid('fusion'), modelId = uid('model'); const folder = path.join(directory, 'fusion/jobs', jobId); await mkdir(folder, { recursive: true });
  const archivePath = archive ? path.join(folder, 'input.f3d') : undefined; if (archivePath) await writeFile(archivePath, archive!);
  const request: FusionRequest = { modelId, fileId, archivePath, archiveName, metadataOnly, projectId: project?.id, source: project?.model.source, knownTree: project?.model.browserTree,
    knownParts: project?.model.parts.filter(p => p.nativeToken).map(p => ({ sourceKey: p.sourceKey, nativeToken: p.nativeToken, occurrenceToken: p.occurrenceToken, nativeRevision: p.nativeRevision, nativeTransform: p.nativeTransform, geometry: p.geometry, home: p.home, bounds: p.bounds, explosionOffset: p.explosionOffset })) ?? [], knownAxes: project?.model.constructionAxes ?? [] };
  await writeFile(path.join(folder, 'request.json'), JSON.stringify(request)); return { id: jobId, state: 'queued', phase: 'Waiting for Fusion', progress: 0 };
}
export async function fusionJob(directory: string, jobId: string): Promise<{ status: FusionJobState; request: FusionRequest; folder: string }> {
  const folder = path.join(directory, 'fusion/jobs', jobId); const request = JSON.parse(await readFile(path.join(folder, 'request.json'), 'utf8')) as FusionRequest;
  const saved = await readFile(path.join(folder, 'result.json'), 'utf8').catch(() => undefined);
  if (saved) return { status: { id: jobId, state: 'complete', ...JSON.parse(saved) as object }, request, folder };
  const status = await readFile(path.join(folder, 'status.json'), 'utf8').catch(() => undefined);
  return { status: { id: jobId, ...(status ? JSON.parse(status) as Omit<FusionJobState, 'id'> : { state: 'queued', phase: 'Waiting for Fusion', progress: 0 }) }, request, folder };
}
