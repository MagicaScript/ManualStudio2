import { parentPort, workerData } from 'node:worker_threads';
import type { Project } from '../shared/types.ts';
import { queryGeometry } from './geometry-query.ts';
import { checkMotion } from './motion-check.ts';

export interface AnalysisInput { kind: 'geometry' | 'motion-check'; project: Project; directory: string; request: Record<string, unknown> }

const { kind, project, directory, request } = workerData as AnalysisInput;
try {
  const data = await (kind === 'geometry' ? queryGeometry(project, directory, request) : checkMotion(project, directory, request));
  parentPort?.postMessage({ data });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
