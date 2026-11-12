import path from 'node:path';
import { lstat, realpath, mkdir } from 'node:fs/promises';

export function commandCatalog(commands) {
  const catalog = new Map();
  for (const entry of commands) {
    // Compound catalog entries describe several concrete subcommands.
    for (const suffix of entry.name.split(' ').at(-1).split('/')) {
      const words = entry.name.split(' ');
      words[words.length - 1] = suffix;
      const name = words.join(' ');
      if (/^[a-z][a-z-]*(?: [a-z][a-z-]*)*$/.test(name)) catalog.set(name, entry);
    }
  }
  return catalog;
}

const fileOptions = new Set(['--file', '--out', '--spec', '--input', '--workspace', '--plan', '--journal', '--selection-load']);
const transportOptions = new Set(['--server', '--user-ticket-stdin', '--json', '--agent-compact', '--agent-full', '--compare-profile']);

export async function commandArguments(catalog, command, args, directory) {
  const contract = catalog.get(command);
  if (!contract || !Array.isArray(args) || args.length > 160 ||
    args.some(value => typeof value !== 'string' || value.length > 32000 || /[\x00\r\n]/.test(value))) throw Error('Invalid CLI command');
  const options = new Set([...contract.required, ...contract.optional].flatMap(value => value.match(/--[a-z][a-z-]*/g) ?? []));
  const result = command.split(' ');
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!options.has(option) || transportOptions.has(option)) throw Error('Invalid CLI option');
    result.push(option);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) continue;
    index++;
    if (!fileOptions.has(option)) { result.push(value); continue; }
    if (value === '-' || !value || value.includes('\\') || value.split('/').includes('..')) throw Error('Invalid CLI file path');
    const target = path.resolve(directory, value);
    if (target !== directory && !target.startsWith(directory + path.sep)) throw Error('CLI file outside workspace');
    const relative = path.relative(directory, target);
    let current = directory;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info?.isSymbolicLink()) throw Error('CLI file links are unavailable');
    }
    result.push(target);
  }
  return [...result, '--user-ticket-stdin', '--json'];
}

export async function jobDirectory(root, id) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw Error('Invalid job directory');
  const base = await realpath(root);
  const job = path.join(base, id);
  if (await realpath(job) !== job) throw Error('Invalid job directory');
  const directory = path.join(job, 'cli');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw Error('Invalid CLI directory');
  return directory;
}
