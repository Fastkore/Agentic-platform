import { spawn } from 'node:child_process';
import path from 'node:path';
import { killTree, workerJobConfig, type CodexRequest } from './codex.js';
import type { CodexToolDefinition, CodexToolResult } from './codex-tools.js';

const programs = { python: '/opt/bridge-office/bin/python', 'fk-office': '/usr/local/bin/fk-office' } as const;

function converterSandbox(job: string) {
  // LibreOffice needs a Unix socket for its own startup. The private mount and
  // network namespaces leave it with only its own /tmp and the current job.
  return ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/opt/bridge-office', '/opt/bridge-office',
    '--ro-bind', '/etc/fonts', '/etc/fonts', '--ro-bind', '/etc/libreoffice', '/etc/libreoffice',
    '--ro-bind', '/var/cache/fontconfig', '/var/cache/fontconfig',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', job, job, '--chdir', job,
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--'];
}

export const jobOfficeTool: CodexToolDefinition = {
  type: 'function', name: 'workspace_office',
  description: 'Запускает Python или fk-office без сети в песочнице задания. Python поддерживает python-docx, openpyxl, matplotlib и библиотеки PDF. Скрипты сохраняй через workspace_files. Пути относительны рабочей папке. Готовые документы сохрани в output.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['program', 'args'], properties: {
    program: { enum: Object.keys(programs) },
    args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 4096 } },
  } },
};

export async function runJobOffice(request: CodexRequest, input: unknown, signal: AbortSignal): Promise<CodexToolResult> {
  if (!request.workDirectoryId || !request.allowWrite || !input || typeof input !== 'object') {
    return { success: false, text: 'Инструменты документов доступны в задании с разрешённой записью.' };
  }
  const { program, args } = input as Record<string, unknown>;
  if ((program !== 'python' && program !== 'fk-office') || !Array.isArray(args) || args.length > 32 ||
    args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    return { success: false, text: 'Укажите python или fk-office и массив аргументов команды.' };
  }
  const stopSignal = AbortSignal.any([signal, AbortSignal.timeout(135_000)]);
  stopSignal.throwIfAborted();
  const job = request.workspace;
  const converter = program === 'fk-office';
  const sandbox = converter ? converterSandbox(job) : [...workerJobConfig(job), 'sandbox', '--', '/usr/bin/env',
    `HOME=${job}`, `TMPDIR=${job}`, `XDG_CACHE_HOME=${path.join(job, '.cache')}`, 'MPLBACKEND=Agg', 'PYTHONNOUSERSITE=1'];
  const child = spawn(converter ? '/opt/bridge-office/bwrap' : request.cliPath, [...sandbox, programs[program], ...args], {
    cwd: job, env: { PATH: process.env.PATH, HOME: '/home/node', CODEX_HOME: '/etc/codex', LANG: 'C.UTF-8' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
  });
  const stop = () => { void killTree(child).catch(() => child.kill('SIGKILL')); };
  stopSignal.addEventListener('abort', stop, { once: true });
  let stdout = '', stderr = '', failed = false;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-16_000); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4_000); });
  const code = await new Promise<number | null>(resolve => {
    child.once('error', () => { failed = true; });
    child.once('close', resolve);
  }).finally(() => stopSignal.removeEventListener('abort', stop));
  signal.throwIfAborted();
  if (stopSignal.aborted) return { success: false, text: 'Время выполнения команды истекло.' };
  if (failed) return { success: false, text: 'Не удалось запустить песочницу для документов.' };
  return { success: code === 0, text: [stdout, code && stderr].filter(Boolean).join('\n').trim() ||
    (code === 0 ? 'Команда выполнена.' : 'Команда завершилась с ошибкой.') };
}
