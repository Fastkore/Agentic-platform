import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CliProcessPool } from '../deploy/cli-process-pool.mjs';

test('CLI processes overlap with isolated stdin/cwd and cancelling one does not cancel another', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-cli-pool-'));
  const pool = new CliProcessPool(2), a = pool.acquire()!, b = pool.acquire()!;
  await Promise.all(['a', 'b'].map(name => mkdir(path.join(root, name))));
  const run = (slot: typeof a, name: string) => new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, ['-e', `const f=require('fs'),input=f.readFileSync(0,'utf8');f.writeFileSync('started','1');setTimeout(()=>console.log(JSON.stringify({input,cwd:process.cwd()})),600);`],
      { cwd: path.join(root, name), signal: slot.controller.signal, windowsHide: true }, (error, stdout) => { slot.release(); if (error) reject(error); else resolve(stdout); });
    child.stdin!.end('ticket-' + name);
  });
  const first = run(a, 'a').then(() => 'completed', () => 'cancelled'), second = run(b, 'b');
  try {
    assert.equal(pool.active, 2); assert.equal(pool.acquire(), undefined);
    const deadline = Date.now() + 5000;
    for (;;) {
      if ((await Promise.allSettled(['a', 'b'].map(name => access(path.join(root, name, 'started'))))).every(item => item.status === 'fulfilled')) break;
      if (Date.now() > deadline) throw Error('Processes failed to overlap');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    a.controller.abort(); assert.equal(await first, 'cancelled');
    assert.equal(b.controller.signal.aborted, false);
    const result = JSON.parse(await second);
    assert.equal(result.input, 'ticket-b'); assert.equal(result.cwd, path.join(root, 'b')); assert.equal(pool.active, 0);
    const next = pool.acquire()!; next.release(); next.release(); assert.equal(pool.active, 0);
  } finally { pool.abortAll(); await Promise.allSettled([first, second]); await rm(root, { recursive: true, force: true }); }
});
