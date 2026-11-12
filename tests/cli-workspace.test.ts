import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliWorkspace } from '../server/cli-workspace.js';
import { commandArguments, commandCatalog, jobDirectory } from '../deploy/fastkore-cli-commands.mjs';
import { randomUUID } from 'node:crypto';

test('CLI chat folders survive turns and isolate employees, projects and chats', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cli-workspaces-'));
  try {
    const first = path.join(root, 'first'), second = path.join(root, 'second'), other = path.join(root, 'other');
    await Promise.all([first, second, other].map(directory => mkdir(directory)));
    const workspace = new CliWorkspace(root, ['installation', 'alice', 'project', 'chat']);
    await workspace.restore(first);
    await writeFile(path.join(first, 'cli', 'source', 'macro.cs'), 'version one');
    await writeFile(path.join(first, 'cli', 'backups', 'macro.cs'), 'original');
    await workspace.save(first);
    await workspace.restore(second);
    assert.equal(await readFile(path.join(second, 'cli', 'source', 'macro.cs'), 'utf8'), 'version one');
    assert.equal(await readFile(path.join(second, 'cli', 'backups', 'macro.cs'), 'utf8'), 'original');
    await new CliWorkspace(root, ['installation', 'boris', 'project', 'chat']).restore(other);
    await assert.rejects(readFile(path.join(other, 'cli', 'source', 'macro.cs')), { code: 'ENOENT' });
    await symlink(root, path.join(second, 'cli', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(workspace.save(second), /тип файла/);
    await rm(path.join(second, 'cli', 'escape'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI catalog accepts command parameters and keeps file paths inside its job', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cli-command-'));
  try {
    const id = randomUUID();
    await mkdir(path.join(root, id));
    const directory = await jobDirectory(root, id);
    const catalog = commandCatalog([
      { name: 'macro apply', required: ['--file', '--element'], optional: ['--warnings-as-errors', '--json'] },
      { name: 'subject list/show', required: ['--server', '--user-ticket-stdin'], optional: ['--kind'] },
    ]);
    assert.ok(catalog.has('subject list') && catalog.has('subject show'));
    assert.deepEqual(await commandArguments(catalog, 'macro apply', ['--file', 'source/macro.cs', '--element', 'id', '--warnings-as-errors'], directory),
      ['macro', 'apply', '--file', path.join(directory, 'source', 'macro.cs'), '--element', 'id', '--warnings-as-errors', '--user-ticket-stdin', '--json']);
    for (const args of [['--server', 'other'], ['--file', '../escape'], ['--file', '-'], ['--password', 'secret'], ['--file=/tmp/escape']]) {
      await assert.rejects(commandArguments(catalog, 'macro apply', args, directory));
    }
    await assert.rejects(jobDirectory(root, '../other'));
    await symlink(root, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(commandArguments(catalog, 'macro apply', ['--file', 'linked/secret'], directory));
    await rm(path.join(directory, 'linked'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
