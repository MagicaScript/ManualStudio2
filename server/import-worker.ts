import { parentPort, workerData } from 'node:worker_threads';
import { parse3mf, persistModel } from './import-3mf.ts';
const input = workerData as { bytes: Uint8Array; filename: string; directory: string };
try { const imported = parse3mf(input.bytes, input.filename); await persistModel(imported, input.directory); parentPort?.postMessage({ model: imported.model }); }
catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
