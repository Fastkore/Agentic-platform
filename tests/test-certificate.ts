import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
// Ephemeral localhost CA/certificate for actual TLS tests; no private keys are kept in the repository.
export function testCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag: number, ...values: Buffer[]): Buffer => {
    const body = Buffer.concat(values), n = body.length, length = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const seq = (...v: Buffer[]) => der(0x30, ...v), oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
  const alg = seq(oid('2a864886f70d01010b'), der(5));
  const name = seq(der(0x31, seq(oid('550403'), der(12, Buffer.from('localhost')))));
  const date = (offset: number) => der(24, Buffer.from(new Date(Date.now() + offset).toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z')));
  const serial = randomBytes(16); serial[0] = (serial[0] & 127) || 1;
  const extensions = der(0xa3, seq(
    seq(oid('551d13'), der(1, Buffer.from([255])), der(4, seq(der(1, Buffer.from([255]))))),
    seq(oid('551d11'), der(4, seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))))
  ));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), alg, name, seq(date(-86400_000), date(86400_000)), name, publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const cert = seq(tbs, alg, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n` };
}
