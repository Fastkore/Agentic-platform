/** Reader worker for tools/sources-load.mts: exact search and line reads on its own connection, latency in ms. */
import { parentPort, workerData } from 'node:worker_threads';
import { sourceStorageFromEnv } from '../server/sources/blob-store.js';
import { SourceRegistry, sourceLimitsFromEnv } from '../server/sources/registry.js';
import { SourceReader } from '../server/sources/reader.js';

const { dataRoot, snapshotId, seed, files, rounds } = workerData as { dataRoot: string; snapshotId: string; seed: number; files: number; rounds: number };
const storage = sourceStorageFromEnv(process.env);
if (!storage.store) throw new Error(storage.problem);
const registry = new SourceRegistry(dataRoot, storage, sourceLimitsFromEnv());
const reader = new SourceReader(registry);
const snapshot = registry.snapshotRow(snapshotId)!;
const target = { snapshotId, generation: snapshot.index_generation };
const search: number[] = [], read: number[] = [];
for (let i = 0; i < rounds; i++) {
  const n = (seed * 7919 + i * 104729) % files;
  let t = performance.now();
  const hits = reader.search([target], `Calc${n}_1(`, { mode: 'exact' });
  search.push(performance.now() - t);
  const hit = hits.hits[0];
  if (hit) { t = performance.now(); await reader.readLines(snapshotId, hit.fileId, Math.max(1, hit.line - 20), 200); read.push(performance.now() - t); }
}
registry.close();
parentPort!.postMessage({ search, read });
