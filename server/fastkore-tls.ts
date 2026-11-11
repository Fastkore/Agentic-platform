import { X509Certificate } from 'node:crypto';
import { connect as connectHttp2 } from 'node:http2';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as connectTls, type TLSSocket } from 'node:tls';
import type { FastkoreTlsTrust } from '../shared/types.js';
import { BridgeError } from './store.js';

const maxResponse = 64 * 1024;
const timeout = 6000;

function hostName(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function readCertificates(url: URL) {
  return new Promise<Buffer>((resolve, reject) => {
    // This discovery connection sends only an empty public RPC. Its CA is untrusted until confirmation.
    const session = connectHttp2(url.origin, { rejectUnauthorized: false });
    const timer = setTimeout(() => session.destroy(new Error('ERP TLS discovery timed out')), timeout);
    session.once('close', () => { clearTimeout(timer); reject(new Error('ERP TLS discovery connection closed')); });
    session.once('error', reject);
    session.once('connect', () => {
      const identityError = checkServerIdentity(hostName(url), (session.socket as TLSSocket).getPeerCertificate());
      if (identityError) { session.destroy(identityError); return; }

      const stream = session.request({
        ':method': 'POST', ':path': '/fastkore.ServerInfo/GetTlsCertificates',
        'content-type': 'application/grpc', te: 'trailers',
      });
      let size = 0, ok = false, grpcStatus: string | string[] | undefined;
      const chunks: Buffer[] = [];
      stream.on('response', headers => {
        ok = headers[':status'] === 200 && /^application\/grpc(?:[+;]|$)/i.test(String(headers['content-type']));
        grpcStatus = headers['grpc-status'];
      });
      stream.on('trailers', headers => { grpcStatus = headers['grpc-status']; });
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxResponse) session.destroy(new Error('ERP CA response is too large'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => {
        const frame = Buffer.concat(chunks);
        session.close();
        if (!ok || grpcStatus !== '0' || frame.length < 6 || frame[0] !== 0 || frame.readUInt32BE(1) !== frame.length - 5) {
          reject(new Error('Invalid ERP CA response'));
          return;
        }
        resolve(frame.subarray(5));
      });
      stream.end(Buffer.alloc(5));
    });
  });
}

export async function discoverFastkoreTls(ticketUrl: string): Promise<FastkoreTlsTrust> {
  const url = new URL(ticketUrl);
  try {
    const payload = (await readCertificates(url)).toString('utf8');
    const certificateBlock = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const blocks = payload.match(certificateBlock);
    if (!blocks?.length || blocks.length > 8 || payload.replace(certificateBlock, '').trim()) throw new Error('Invalid PEM');
    const roots = blocks.map(block => new X509Certificate(block)).filter(cert =>
      cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey));
    if (roots.length !== 1) throw new Error('Expected a single root CA');
    const [root] = roots;
    return { origin: url.origin, subject: root.subject, fingerprint: root.fingerprint256, expiresAt: root.validToDate.toISOString(), pem: root.toString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      throw new BridgeError('Имя сервера ERP отсутствует в его TLS-сертификате. Проверьте адрес установки.', 424);
    }
    throw new BridgeError('Не удалось получить публичный CA от Fastkore. Проверьте адрес и TLS-порт ERP.', 424);
  }
}

export async function verifyFastkoreTls(trust: FastkoreTlsTrust) {
  const url = new URL(trust.origin);
  const host = hostName(url);
  await new Promise<void>((resolve, reject) => {
    const socket = connectTls({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host,
      ca: trust.pem, rejectUnauthorized: true }, () => { socket.end(); resolve(); });
    const timer = setTimeout(() => socket.destroy(new Error('ERP TLS verification timed out')), timeout);
    socket.once('close', () => clearTimeout(timer));
    socket.once('error', () => reject(new BridgeError('Не удалось проверить TLS ERP с подтверждённым CA. Проверьте цепочку и имя сервера.', 424)));
  });
}
