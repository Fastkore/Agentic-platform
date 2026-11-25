import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { detectEncoding } from './text-index.js';

export const publicationCharacterLimit = 4 * 1024 * 1024;
const plainFormats = new Set(['.txt', '.md', '.csv', '.tsv', '.log', '.json', '.py', '.cs', '.js', '.ts', '.sql', '.yaml', '.yml']);

export async function inspectPublicationFile(name: string, input: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  const ext = path.extname(name).toLowerCase();
  if (plainFormats.has(ext)) {
    const detected = detectEncoding(input);
    if (detected === 'binary' || input.length > publicationCharacterLimit * 4) throw Error('Unsupported text');
    const text = new TextDecoder(detected.encoding.replace('-bom', ''), { fatal: true }).decode(input);
    if (text.length > publicationCharacterLimit || /[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw Error('Unsupported text');
    return { contents: input, text };
  }
  if (ext !== '.docx' && ext !== '.xlsx') throw Error('Unsupported publication format');
  const script = new URL(import.meta.url.endsWith('.ts') ? './extract-worker.ts' : './extract-worker.js', import.meta.url);
  const worker = new Worker(script, { workerData: { kind: ext.slice(1), input, publication: true },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
  const stop = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try {
    const result = await new Promise<{ text: string; contents: Uint8Array }>((resolve, reject) => {
      stop.onabort = () => reject(stop.reason);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', () => reject(Error('Extraction ended before returning a result')));
      stop.throwIfAborted();
    });
    return { text: result.text, contents: Buffer.from(result.contents) };
  } finally { stop.onabort = null; await worker.terminate(); }
}
