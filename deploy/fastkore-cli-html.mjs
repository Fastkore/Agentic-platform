import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const maxHtmlImageBytes = 20 * 1024 * 1024;
const fieldName = /^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,199}$/u;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function htmlArguments(operation, args) {
  const { entitySet, entity, property, offset, index, sha256: hash, mimeType } = args;
  if (![entitySet, entity, property].every(value => typeof value === 'string') ||
    !fieldName.test(entitySet) || !guid.test(entity) || !fieldName.test(property) ||
    index !== undefined && (!Number.isSafeInteger(index) || index < 1 || index > 2147483647)) return;
  const fields = ['--entity-set', entitySet, '--entity', entity, '--property', property];
  if (operation === 'html-image') {
    if (Object.keys(args).some(key => !['entitySet', 'entity', 'property', 'index', 'sha256', 'mimeType'].includes(key)) ||
      index === undefined || typeof hash !== 'string' || !sha256.test(hash) || !mimeTypes.has(mimeType)) return;
    return ['data', 'html', 'export', ...fields, '--index', String(index), '--expected-hash', hash];
  }
  if (Object.keys(args).some(key => !['entitySet', 'entity', 'property', 'offset', 'index'].includes(key)) ||
    offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647)) return;
  return ['data', 'html', 'show', ...fields, ...(offset === undefined ? [] : ['--offset', String(offset)]),
    ...(index === undefined ? [] : ['--index', String(index)])];
}

export async function readHtmlImage(filename, metadata, expected) {
  if (metadata?.sha256 !== expected.sha256 || metadata.mimeType !== expected.mimeType ||
    !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1) throw Error('Invalid HTML image metadata');
  if (metadata.byteLength > maxHtmlImageBytes) return;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== metadata.byteLength) throw Error('Invalid HTML image length');
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.byteLength || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw Error('Invalid HTML image hash');
    }
    return 'data:' + metadata.mimeType + ';base64,' + bytes.toString('base64');
  } finally { await handle.close(); }
}
