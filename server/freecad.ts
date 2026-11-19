import { request } from 'node:http';
import type { CodexToolDefinition, CodexToolResult, CodexTools } from './codex-tools.js';

const definition: CodexToolDefinition = {
  type: 'function', name: 'freecad_linkage',
  description: 'Собирает в FreeCAD шарнирную тягу с двумя вилками, болтами М12, гайками и проставками. create создаёт сборку. resize открывает последнюю доступную сборку этого чата и меняет межосевое расстояние. FCStd и GLB автоматически прикладываются к ответу.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'distanceMm'], properties: {
    action: { type: 'string', enum: ['create', 'resize'] },
    distanceMm: { type: 'number', minimum: 40, maximum: 2000, description: 'Межосевое расстояние в мм. Исходный вариант 86 мм.' },
  } },
};

async function requestModel(socketPath: string, distance: number, source: Buffer | undefined, signal: AbortSignal) {
  const body = JSON.stringify({ distance, source: source?.toString('base64') });
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request({ socketPath, path: '/linkage', method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, resolve);
    req.on('error', reject);
    req.end(body);
  });
  if (response.statusCode !== 200) {
    response.resume();
    if (response.statusCode === 503) return undefined;
    throw Error('FreeCAD response');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw Error('FreeCAD response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
}

export class FreecadJob {
  files: { name: string; contents: Buffer }[] = [];
  private busy = false;

  constructor(private socketPath: string, private previous: (signal: AbortSignal) => Promise<Buffer | undefined>,
    private authorize: () => void) {}

  withTools(other?: CodexTools): CodexTools {
    return { definitions: [...(other?.definitions ?? []), definition], call: (name, input, signal) =>
      name === definition.name ? this.render(input, signal) : other?.call(name, input, signal) ??
        Promise.resolve({ success: false, text: 'Инструмент недоступен.' }) };
  }

  private async render(input: unknown, signal: AbortSignal): Promise<CodexToolResult> {
    const args = input as Record<string, unknown> | null;
    const distance = args?.distanceMm;
    if (!args || Object.keys(args).length !== 2 || !['create','resize'].includes(String(args.action)) ||
      typeof distance !== 'number' || !Number.isFinite(distance) || distance < 40 || distance > 2000) {
      return { success: false, text: 'Укажите create или resize и расстояние от 40 до 2000 мм.' };
    }
    if (this.busy) return { success: false, text: 'Дождитесь завершения текущего построения.' };
    this.authorize();
    this.busy = true;
    try {
      const source = args.action === 'resize' ? this.files[0]?.contents ?? await this.previous(signal) : undefined;
      if (args.action === 'resize' && !source) return { success: false, text: 'Предыдущая сборка FreeCAD недоступна в этом чате.' };
      const data = await requestModel(this.socketPath, distance, source, AbortSignal.any([signal, AbortSignal.timeout(40_000)]));
      if (!data) return { success: false, text: 'FreeCAD занят. Повторите построение.' };
      const files = ['FCStd','glb'].map(ext => ({ name: 'linkage-' + distance + 'mm.' + ext, contents: Buffer.from(data[ext], 'base64') }));
      if (files[0].contents.readUInt32LE() !== 0x04034b50 || files[1].contents.readUInt32LE() !== 0x46546c67 ||
        files[1].contents.readUInt32LE(8) !== files[1].contents.length) throw Error('Invalid CAD files');
      this.authorize();
      signal.throwIfAborted();
      this.files = files;
      return { success: true, text: JSON.stringify({ action: args.action, distanceMm: distance, components: 11, attachments: files.map(f => f.name) }) };
    } catch {
      signal.throwIfAborted();
      this.authorize();
      return { success: false, text: 'FreeCAD не завершил построение или чтение модели. Проверьте доступность сервиса.' };
    } finally { this.busy = false; }
  }
}
