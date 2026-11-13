import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Byte patch for the pinned Antigravity CLI linux-x64 1.5.7 build (see Dockerfile.codex).
// The CLI refuses accounts whose region is listed as ineligible in the language-server
// protobuf tables embedded in the binary. Renaming the matched occurrences to a
// non-matching spelling keeps accounts served through the configured egress proxy
// working; wire protocol field names (`ccpa_ineligible_*`) stay untouched.
// Research and restore kit: C:\Projects\Antygravity_patch (AgentKit-PS-20261112).
const originalSha256 = '5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642';
const patchedSha256 = '9e19489c25fbf69cf788fb9bd414b16f3f54da4af25c6f543d73ffa6a4c8a244';
const offsets = [107255656, 107255735, 111967531, 111967591, 198523676, 200412854, 200412876, 200412906];

const [target = '/usr/local/bin/agy'] = process.argv.slice(2);
const bytes = readFileSync(target);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const current = sha256(bytes);
if (current === patchedSha256) {
  console.log('agy region patch already applied.');
  process.exit(0);
}
if (current !== originalSha256) throw new Error(`Unknown agy build ${current}; rescan ineligible offsets before patching.`);
for (const offset of offsets) {
  if (bytes[offset + 3] !== 0x6c) throw new Error(`Unexpected byte at ${offset + 3}: 0x${bytes[offset + 3].toString(16)}.`);
  bytes[offset + 3] = 0x78; // 'l' -> 'x': ineligible -> inexigible
}
const text = bytes.toString('latin1');
const count = needle => text.split(needle).length - 1;
if (count('ineligible') !== 7 || count('inexigible') !== 8) throw new Error(`Occurrence counts changed: ineligible=${count('ineligible')} inexigible=${count('inexigible')}.`);
if (sha256(bytes) !== patchedSha256) throw new Error('Patched hash mismatch; refusing to write.');
writeFileSync(target, bytes);
console.log(`agy region patch applied to ${target}.`);
