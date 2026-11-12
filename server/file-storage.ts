import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment, FileStorageProvider, Project } from '../shared/types.js';
import { attachmentName, documentText, projectFilePath, uploadAttachment } from './documents.js';
import { BridgeError } from './store.js';

export const maxUploadBytes = 20 * 1024 * 1024;

export class FileStorage {
  private readonly s3?: { client: S3Client; bucket: string; createBucket: boolean };

  constructor(env: NodeJS.ProcessEnv = {}) {
    const bucket = env.BRIDGE_S3_BUCKET;
    if (!bucket) return;
    const accessKeyId = env.BRIDGE_S3_ACCESS_KEY;
    const secretAccessKey = env.BRIDGE_S3_SECRET_KEY_FILE
      ? readFileSync(env.BRIDGE_S3_SECRET_KEY_FILE, 'utf8').trim()
      : env.BRIDGE_S3_SECRET_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error('Для BRIDGE_S3_BUCKET нужны ключи доступа S3.');
    this.s3 = {
      bucket,
      createBucket: env.BRIDGE_S3_CREATE_BUCKET === '1',
      client: new S3Client({
        endpoint: env.BRIDGE_S3_ENDPOINT || undefined,
        region: env.BRIDGE_S3_REGION || 'us-east-1',
        forcePathStyle: !!env.BRIDGE_S3_ENDPOINT && env.BRIDGE_S3_FORCE_PATH_STYLE !== '0',
        credentials: { accessKeyId, secretAccessKey },
        maxAttempts: 2,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
    };
  }

  get s3Configured() { return !!this.s3; }

  private connection() {
    if (!this.s3) throw new BridgeError('Хранилище S3 не настроено на сервере.', 503);
    return this.s3;
  }

  private object(bucket: string, project: Project, file: Attachment) {
    return { Bucket: bucket, Key: `projects/${encodeURIComponent(project.id)}/${encodeURIComponent(file.id)}` };
  }

  async checkS3() {
    const { client, bucket, createBucket } = this.connection();
    const abortSignal = AbortSignal.timeout(15_000);
    try {
      try { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal }); }
      catch (error) {
        if (!createBucket || !(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal });
      }
    } catch { throw new BridgeError('Не удалось подключиться к бакету S3. Проверьте настройки и доступ.', 503); }
  }

  async upload(provider: FileStorageProvider, project: Project, name: string, data: Buffer): Promise<Attachment> {
    if (provider === 'local') return uploadAttachment(project.directory, name, data);
    const { client, bucket } = this.connection();
    const file: Attachment = { id: randomUUID(), name: attachmentName(name), storage: 's3', size: data.length };
    try {
      await client.send(new PutObjectCommand({ ...this.object(bucket, project, file), Body: data, ContentType: 'application/octet-stream' }),
        { abortSignal: AbortSignal.timeout(30_000) });
    } catch {
      await client.send(new DeleteObjectCommand(this.object(bucket, project, file)), { abortSignal: AbortSignal.timeout(3000) }).catch(() => {});
      throw new BridgeError('Не удалось загрузить файл в S3.', 503);
    }
    return file;
  }

  async read(project: Project, file: Attachment, signal?: AbortSignal): Promise<Buffer> {
    if (file.storage !== 's3') {
      const target = await projectFilePath(project, file);
      if ((await stat(target)).size > maxUploadBytes) throw new BridgeError('Файл превышает 20 МБ.', 413);
      return readFile(target, { signal });
    }
    const { client, bucket } = this.connection();
    const timeout = AbortSignal.timeout(30_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const { Body, ContentLength } = await client.send(new GetObjectCommand(this.object(bucket, project, file)), { abortSignal });
      if (!Body || ContentLength !== file.size || ContentLength > maxUploadBytes) {
        if (Body && 'destroy' in Body) Body.destroy();
        throw new BridgeError('Размер файла в S3 не совпадает с метаданными.', 502);
      }
      const data = await Body.transformToByteArray();
      if (data.length !== ContentLength) throw new BridgeError('Файл из S3 получен не полностью.', 502);
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BridgeError) throw error;
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) throw new BridgeError('Файл не найден в S3.', 404);
      throw new BridgeError('Не удалось прочитать файл из S3.', 503);
    }
  }

  async excerpt(project: Project, file: Attachment, signal?: AbortSignal) {
    return file.storage === 's3'
      ? documentText(file.name, await this.read(project, file, signal))
      : documentText(await projectFilePath(project, file));
  }

  async remove(project: Project, file: Attachment) {
    if (file.storage !== 's3') {
      const target = await projectFilePath(project, file);
      await unlink(target);
      await rmdir(path.dirname(target)).catch(() => {});
      return;
    }
    const { client, bucket } = this.connection();
    try {
      await client.send(new DeleteObjectCommand(this.object(bucket, project, file)), { abortSignal: AbortSignal.timeout(15_000) });
    } catch { throw new BridgeError('Не удалось удалить файл из S3.', 503); }
  }

  close() { this.s3?.client.destroy(); }
}
