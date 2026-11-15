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

const fileOptions = new Set(['--file', '--out', '--spec', '--input', '--workspace', '--plan', '--journal', '--selection-load', '--context']);
const transportOptions = new Set(['--server', '--user-ticket-stdin', '--compare-profile', '--profile', '--user', '--username', '--password']);
const formatOptions = new Set(['--json', '--agent-compact', '--agent-full']);

export async function commandArguments(catalog, command, args, directory) {
  if (typeof command !== 'string' || !/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(command) || !Array.isArray(args) || args.length > 160 ||
    args.some(value => typeof value !== 'string' || value.length > 32000 || value.includes('\0'))) throw Error('Invalid CLI command');
  const result = command.split(' ');
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    const equal = raw.indexOf('=');
    const option = equal > 0 ? raw.slice(0, equal) : raw;
    if (formatOptions.has(option)) {
      if (option !== '--json') result.push(option);
      continue;
    }
    if (transportOptions.has(option)) throw Error('CLI connection and authentication are supplied by the executor');
    if (!fileOptions.has(option)) { result.push(raw); continue; }
    const value = equal > 0 ? raw.slice(equal + 1) : args[++index];
    if (value === undefined) throw Error('Missing CLI file path');
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
    result.push(option, target);
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
