import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BridgeError } from './store.js';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  // Only global unicast; exclude transition and documentation ranges as well.
  const first = parseInt(lower.split(':')[0], 16);
  const second = parseInt(lower.split(':')[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

export async function publicTarget(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096 ||
    url.port && !['80', '443'].includes(url.port)) throw new BridgeError('Разрешены публичные HTTP/HTTPS-адреса на портах 80 и 443.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new BridgeError('Внутренние и служебные адреса недоступны через интернет-инструменты.', 403);
  return { url, address: addresses[0] };
}

export interface PublicHttpResult { status: number; url: string; contentType: string; location?: string; text: string }
export async function publicHttp(input: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  signal: AbortSignal, authorize: () => void): Promise<PublicHttpResult> {
  const { url, address } = await publicTarget(input.url);
  authorize(); signal.throwIfAborted();
  const method = input.method ?? 'GET';
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) ||
    input.body !== undefined && (['GET', 'HEAD'].includes(method) || Buffer.byteLength(input.body) > 64000)) throw new BridgeError('Проверьте HTTP-метод и размер тела запроса.');
  const headers: Record<string, string> = { 'user-agent': 'Agent-Platform/1.0', 'accept-encoding': 'identity' };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!/^[a-z0-9-]{1,64}$/i.test(name) || /[\r\n]/.test(value) || value.length > 4096 ||
      /^(host|connection|content-length|transfer-encoding|upgrade|accept-encoding|proxy-.+)$/i.test(name)) throw new BridgeError('Недопустимый HTTP-заголовок.');
    headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    // Pin the validated address so a second DNS lookup cannot redirect into the private network.
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      let bytes = 0; const parts: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) { response.destroy(new BridgeError('Ответ сайта превышает 2 МБ.')); return; }
        parts.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          authorize(); signal.throwIfAborted();
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new BridgeError('Сайт вернул сжатый ответ вместо запрошенного текста.');
          resolve({ status: response.statusCode ?? 0, url: url.href, contentType: response.headers['content-type'] ?? '',
            location: response.headers.location, text: Buffer.concat(parts).toString('utf8') });
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject); request.end(input.body);
  });
}
