import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliWorkspace } from '../server/cli-workspace.js';
import { commandArguments, commandCatalog, jobDirectory } from '../deploy/fastkore-cli-commands.mjs';
import { createHash, randomUUID } from 'node:crypto';

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

test('CLI storage migrates a legacy backup and ignores unpublished snapshots after an interruption', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cli-revision-'));
  try {
    const identity = ['installation', 'alice', 'project', 'chat'];
    const saved = path.join(root, 'cli-workspaces', createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
    const legacy = path.join(saved + '.previous', 'source');
    const versions = saved + '.revisions';
    const incomplete = path.join(versions, `${Date.now() + 1000}-${randomUUID()}`, 'files', 'source');
    await Promise.all([legacy, incomplete].map(directory => mkdir(directory, { recursive: true })));
    await writeFile(path.join(legacy, 'record.txt'), 'last good copy');
    await writeFile(path.join(incomplete, 'record.txt'), 'interrupted copy');
    const first = path.join(root, 'first'), next = path.join(root, 'next');
    await Promise.all([first, next].map(directory => mkdir(directory)));

    const workspace = new CliWorkspace(root, identity);
    await workspace.restore(first);
    const file = path.join(first, 'cli', 'source', 'record.txt');
    assert.equal(await readFile(file, 'utf8'), 'last good copy');
    await writeFile(file, 'updated copy');
    await workspace.save(first);

    const [published, ...old] = await readdir(versions);
    assert.deepEqual(old, []);
    assert.equal(await readFile(path.join(versions, published, 'ready'), 'utf8'), '');
    assert.notEqual(path.join(versions, published, 'files', 'source'), incomplete);
    await new CliWorkspace(root, identity).restore(next);
    assert.equal(await readFile(path.join(next, 'cli', 'source', 'record.txt'), 'utf8'), 'updated copy');

    // Unchanged turns do not rewrite published revisions, and empty workspaces do not create unnecessary revisions.
    const unchangedJob = path.join(root, 'unchanged');
    await mkdir(unchangedJob);
    const unchangedWorkspace = new CliWorkspace(root, identity);
    await unchangedWorkspace.restore(unchangedJob);
    await unchangedWorkspace.save(unchangedJob);
    assert.deepEqual(await readdir(versions), [published]);

    const emptyJob = path.join(root, 'empty-job');
    await mkdir(emptyJob);
    const emptyIdentity = ['installation', 'carol', 'project', 'chat'];
    const emptySaved = path.join(root, 'cli-workspaces', createHash('sha256').update(JSON.stringify(emptyIdentity)).digest('hex'));
    const emptyWorkspace = new CliWorkspace(root, emptyIdentity);
    await emptyWorkspace.restore(emptyJob);
    await emptyWorkspace.save(emptyJob);
    await assert.rejects(readdir(emptySaved + '.revisions'), { code: 'ENOENT' });
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
    assert.deepEqual(await commandArguments(catalog, 'data aggregate', ['--context', 'context.json', '--metrics', 'count'], directory),
      ['data', 'aggregate', '--context', path.join(directory, 'context.json'), '--metrics', 'count', '--user-ticket-stdin', '--json']);
    assert.deepEqual(await commandArguments(catalog, 'subject list', ['--kind', 'user', '--json'], directory),
      ['subject', 'list', '--kind', 'user', '--user-ticket-stdin', '--json']);
    assert.deepEqual(await commandArguments(catalog, 'macro apply', ['--file', 'source/macro.cs', '--element', 'id', '--warnings-as-errors'], directory),
      ['macro', 'apply', '--file', path.join(directory, 'source', 'macro.cs'), '--element', 'id', '--warnings-as-errors', '--user-ticket-stdin', '--json']);
    assert.deepEqual(await commandArguments(catalog, 'data query', ['--context=context.json', '--after', id, '--page-size', '1000', '--order-by', '$Modified', '--descending'], directory),
      ['data', 'query', '--context', path.join(directory, 'context.json'), '--after', id, '--page-size', '1000', '--order-by', '$Modified', '--descending', '--user-ticket-stdin', '--json']);
    assert.deepEqual(await commandArguments(catalog, 'agent describe', ['data query', '--future-parameter', 'value'], directory),
      ['agent', 'describe', 'data query', '--future-parameter', 'value', '--user-ticket-stdin', '--json']);
    for (const args of [['--server', 'other'], ['--file', '../escape'], ['--file', '-'], ['--password', 'secret'], ['--file=/tmp/escape']]) {
      await assert.rejects(commandArguments(catalog, 'macro apply', args, directory));
    }
    await assert.rejects(jobDirectory(root, '../other'));
    await symlink(root, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(commandArguments(catalog, 'macro apply', ['--file', 'linked/secret'], directory));
    await rm(path.join(directory, 'linked'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
