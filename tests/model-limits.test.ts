import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseGoogleLimits, limitsForModel, readGoogleLimits } from '../server/google-limits.js';
import { ExecutionAccountStore } from '../server/execution-accounts.js';
import { createCodexWorker } from '../server/codex-worker.js';

test('Google quota percentages retain zero, ignore missing values, and select only the matching model family', () => {
  const parsed = parseGoogleLimits({ quota: {
    'gemini-weekly': { remaining_fraction: 0.9378, reset_time: '2026-11-14T10:00:00Z' },
    'gemini-flash-five-hour': { remaining_fraction: 0 },
    'gemini-pro-five-hour': { remaining_fraction: 0.7 },
    'claude-weekly': { remaining_fraction: 0.4 },
    'claude-disabled': { remaining_fraction: 1, disabled: true },
    'gpt-unknown': { remaining_amount: 25 },
    'gpt-invalid': { remaining_fraction: 3 },
  } });
  assert.equal(parsed.buckets.length, 4);
  const gemini = limitsForModel(parsed, 'gemini-3.8-flash-high')!;
  assert.equal(gemini.buckets.length, 2);
  assert.ok(Math.abs(gemini.buckets[0].windows[0].usedPercent - 6.22) < 0.0001);
  assert.equal(gemini.buckets[0].windows[0].resetsAt, Date.parse('2026-11-14T10:00:00Z') / 1000);
  assert.equal(gemini.buckets[1].windows[0].usedPercent, 100);
  assert.equal(gemini.buckets[1].windows[0].windowDurationMins, 300);
  assert.deepEqual(limitsForModel(parsed, 'claude-sonnet-4.6-thinking')?.buckets.map(bucket => bucket.name), ['claude-weekly']);
  assert.equal(limitsForModel(parsed, 'gpt-unknown')?.buckets.length, 0);
  assert.match(limitsForModel(parsed, 'gpt-unknown')!.unavailableReason!, /не передал/);
});

test('grouped CLI quota payloads honor explicit model membership', () => {
  const parsed = parseGoogleLimits({ data: { groups: [{ name: 'Shared group', model_ids: ['gemini-a', 'gemini-b'], buckets: [
    { name: 'weekly', remaining_fraction: 0.5 },
  ] }] } });
  assert.equal(limitsForModel(parsed, 'gemini-b')?.buckets.length, 1);
  assert.equal(limitsForModel(parsed, 'gemini-c')?.buckets.length, 0);
  assert.ok(parseGoogleLimits({ usage: { input_tokens: 5000 } }).unavailableReason);
});

test('Google limit probes use a read-only slash command and return safe unavailability reasons', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-quota-'));
  try {
    const fake = path.join(root, 'fake.mjs');
    await writeFile(fake, `if(process.argv.slice(2).join(' ')!=='-p /usage --output-format json')throw Error('Wrong command');
console.log(JSON.stringify({quota:{'gemini-weekly':{remaining_fraction:0.8}}}));`);
    assert.equal((await readGoogleLimits(root, process.execPath, [fake])).buckets.length, 1);
    await writeFile(fake, `console.error('private-token: not currently available in your location');process.exit(1);`);
    const failed = await readGoogleLimits(root, process.execPath, [fake]);
    assert.equal(failed.buckets.length, 0);
    assert.match(failed.unavailableReason!, /регионе/);
    assert.ok(!JSON.stringify(failed).includes('private-token'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model limit requests route to the active account and share a single quota probe for Google models', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-quota-route-'));
  const accounts = new ExecutionAccountStore(root);
  const google = await accounts.create('Google', 'antigravity');
  await writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'secret' } }));
  await writeFile(path.join(accounts.home(google.id), '.antigravity-connected.json'), JSON.stringify({ session: 'test-session' }));
  // Only the Google executor stays active: the connected-but-inactive Codex must stay hidden.
  await accounts.deactivate('default');
  await accounts.activate(google.id);
  const calls = new Map<string, number>();
  accounts.runner = (id = accounts.active) => ({
    inspect: async () => ({ path: '', version: 'test', authentication: id === 'default' ? 'chatgpt' : 'google', status: '' }),
    run: async () => { throw Error('Quota checks must not start an agent turn'); },
    readLimits: async () => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      return id === 'default' ? { buckets: [{ name: 'Codex', windows: [{ usedPercent: 20, windowDurationMins: 300, resetsAt: null }] }], resetsAvailable: null }
        : parseGoogleLimits({ quota: { 'gemini-weekly': { remaining_fraction: 0.9 }, 'claude-weekly': { remaining_fraction: 0.3 } } });
    },
  });
  const worker = createCodexWorker(undefined, undefined, accounts);
  try {
    const [gemini, claude, codex] = await Promise.all(['antigravity/gemini-3.8-flash-high', 'antigravity/claude-sonnet-4.6', 'codex/gpt-test']
      .map(model => worker.inject('/limits?model=' + encodeURIComponent(model)).then(response => response.json().limits)));
    assert.equal(gemini.provider, 'antigravity');
    assert.equal(gemini.buckets[0].name, 'gemini-weekly');
    assert.equal(claude.buckets[0].name, 'claude-weekly');
    assert.equal(codex, null, 'a connected-but-inactive provider reports no limits');
    assert.equal(calls.get('default'), undefined);
    assert.equal(calls.get(google.id), 1);
    await worker.inject('/limits?model=antigravity/gemini-3.8-flash-low');
    assert.equal(calls.get(google.id), 1);
    await accounts.remove('default');
    assert.equal((await worker.inject('/limits?model=codex/gpt-test')).json().limits, null);
    await worker.inject({ method: 'POST', url: '/accounts/' + google.id + '/deactivate', payload: {} });
    assert.equal((await worker.inject('/limits?model=antigravity/gemini-3.8-flash-high')).json().limits, null);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});
