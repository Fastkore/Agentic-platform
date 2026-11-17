import { parentPort } from 'node:worker_threads';
import { indexBytes, type TextIndexInput } from './text-index.js';

/** Persistent worker for CPU-bound text indexing. The parent enforces a time budget per file and terminates the worker on overrun. */
parentPort!.on('message', (message: { id: number; input: TextIndexInput }) => {
  try {
    const result = indexBytes(message.input);
    parentPort!.postMessage({ id: message.id, result }, result.derived ? [result.derived.buffer as ArrayBuffer] : []);
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort!.postMessage({ ready: true });
