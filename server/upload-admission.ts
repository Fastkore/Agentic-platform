import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { BridgeError } from './store.js';
import { maxUploadBytes } from './file-storage.js';

/** Reserve a slot (up to 20 MiB of temporary storage) before reading multipart data. */
export class UploadAdmission {
  private readonly active = new Set<string>();

  async receive<T>(request: FastifyRequest, actorId: string, use: (name: string, data: Buffer) => Promise<T>): Promise<T> {
    if (this.active.size >= 3 || this.active.has(actorId)) {
      throw new BridgeError('Загрузка уже выполняется. Попробуйте чуть позже.', 429);
    }
    this.active.add(actorId);
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    request.raw.once('aborted', disconnected);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const abortRequest = () => { if (!request.raw.complete) request.raw.destroy(); };
    signal.addEventListener('abort', abortRequest, { once: true });
    let directory: string | undefined;
    try {
      const file = await request.file();
      if (!file) throw new BridgeError('Выберите файл для загрузки.');
      directory = await mkdtemp(path.join(tmpdir(), 'bridge-upload-'));
      const target = path.join(directory, 'payload');
      await pipeline(file.file, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
      if (file.file.truncated) throw new BridgeError('Максимальный размер файла — 20 МБ.', 413);
      const data = await readFile(target, { signal });
      if (data.length > maxUploadBytes) throw new BridgeError('Максимальный размер файла — 20 МБ.', 413);
      return await use(file.filename, data);
    } catch (error) {
      if (signal.aborted) throw new BridgeError('Время загрузки истекло или соединение закрыто.', 408);
      throw error;
    } finally {
      request.raw.off('aborted', disconnected);
      signal.removeEventListener('abort', abortRequest);
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { this.active.delete(actorId); }
    }
  }
}
