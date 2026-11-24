import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { ExternalProvider } from '../../shared/library.js';

/** Instance-local credentials in the persistent library volume. The existing key also opens earlier drive tokens. */
export class LibrarySettings {
  constructor(private root: string) {}
  private key() {
    const file = join(this.root, 'drive-oauth.key');
    try { return readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const key = randomBytes(32);
    try { writeFileSync(file, key, { flag: 'wx', mode: 0o600 }); return key; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return readFileSync(file); }
  }
  seal(value: object) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  unseal<T>(sealed: string): T {
    const data = Buffer.from(sealed, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0,12));
    decipher.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  }
  read<T>(service: ExternalProvider | 's3'): T | undefined {
    let source: string;
    try { source = readFileSync(join(this.root, service + '.env'), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    const sealed = parseEnv(source).LIBRARY_CREDENTIALS;
    if (!sealed) throw new Error('Повреждены сохранённые настройки библиотеки.');
    return this.unseal<T>(sealed);
  }
  write(service: ExternalProvider | 's3', value: object) {
    const target = join(this.root, service + '.env'), temp = target + '.' + randomUUID();
    try {
      writeFileSync(temp, 'LIBRARY_CREDENTIALS=' + this.seal(value) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
  }
}
