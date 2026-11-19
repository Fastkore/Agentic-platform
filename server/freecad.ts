import { createHash } from 'node:crypto';
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

const designTool: CodexToolDefinition = {
  type: 'function', name: 'freecad_design',
  description: 'Проектирование произвольных деталей и сборок в headless FreeCAD. inspect читает дерево, координаты и габариты последней модели чата либо вложенного FCStd. create создаёт пустой doc, edit открывает существующий doc. Напиши Python для FreeCAD: доступны App, Part, Sketcher, V=App.Vector, math, doc, input_files (словарь имя вложения → путь), bind_item(obj, ERP_GUID, артикул). Создавай геометрию и нативные операции в doc, скрывай промежуточные инструменты через Visibility=False. Для сочленения используй размеры и координаты отверстий. Можно копировать детали через App::Link. Не закрывай doc: сервис пересчитает и проверит файл после открытия, экспортирует видимые тела и приложит FCStd и GLB. Исправь код при ошибке.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['inspect','create','edit'] },
    code: { type: 'string', maxLength: 64000, description: 'Исполняемый скрипт построения для create/edit.' },
    sourceName: { type: 'string', description: 'Точное имя прикреплённого FCStd для inspect/edit. Без имени — результат текущего или предыдущего хода.' },
    referenceNames: { type: 'array', items: {type:'string'}, maxItems:8, description:'Имена приложенных FCStd, STEP, BREP или DXF для чтения через input_files.' },
    bomRoot: { type:'string', maxLength:100, description:'Имя корневой группы FreeCAD для выдачи дополнительного файла .bom.json. Иерархия берётся из Group, обозначения из PartNumber, тип из BOMCategory, внешние ссылки из ErpItemId.' },
    filename: { type:'string', description:'Базовое имя итоговых файлов без расширения.' },
  } },
};

type ModelResponse = { bom?: object; FCStd?: string; glb?: string; report?: { components: number } };
type Reference = { name: string; read: (signal: AbortSignal) => Promise<Buffer> };

async function requestModel(socketPath: string, path: string, payload: Record<string,unknown>, signal: AbortSignal) {
  const body = JSON.stringify(payload);
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, resolve);
    req.on('error', reject);
    req.end(body);
  });
  if (response.statusCode === 503) { response.resume(); throw Error('FreeCAD занят. Повторите построение.'); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 58 * 1024 * 1024) throw Error('FreeCAD response too large');
    chunks.push(chunk);
  }
  if (response.statusCode !== 200) {
    const error = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string };
    throw Error(error.error?.slice(-2400) || 'FreeCAD отклонил запрос.');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelResponse;
}

export class FreecadJob {
  static readonly catalogRevision = createHash('sha256').update(JSON.stringify([definition,designTool])).digest('hex').slice(0,12);
  files: { name: string; contents: Buffer }[] = [];
  private busy = false;
  private workingModel?: Buffer;

  constructor(private socketPath: string, private previous: (signal: AbortSignal) => Promise<Buffer | undefined>,
    private authorize: () => void, private references: Reference[] = []) {}

  withTools(other?: CodexTools): CodexTools {
    return { definitions: [...(other?.definitions ?? []), definition, designTool], call: (name, input, signal) =>
      name === definition.name || name === designTool.name ? this.render(name, input, signal) : other?.call(name, input, signal) ??
        Promise.resolve({ success: false, text: 'Инструмент недоступен.' }) };
  }

  private reference(name: unknown) {
    const matches = this.references.filter(r => r.name === name);
    if (matches.length !== 1) throw Error('Укажите уникальное имя CAD-вложения: ' + String(name).slice(0,160));
    return matches[0];
  }

  private async render(tool: string, input: unknown, signal: AbortSignal): Promise<CodexToolResult> {
    if (this.busy) return { success: false, text: 'Дождитесь завершения текущего построения.' };
    this.authorize();
    this.busy = true;
    try {
      const args = input as Record<string, unknown>;
      const legacy = tool === definition.name;
      const action = args?.action;
      const distance = args?.distanceMm;
      const actions = legacy ? ['create','resize'] : ['inspect','create','edit'];
      if (typeof action !== 'string' || !actions.includes(action)) throw Error('Некорректное действие FreeCAD.');
      // A failed final edit must not publish an intermediate assembly as the requested deliverable.
      if (action !== 'inspect') this.files = [];
      if (legacy && (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 40 || distance > 2000)) {
        throw Error('Для типовой тяги укажите расстояние от 40 до 2000 мм.');
      }
      const stem = legacy ? 'linkage-' + distance + 'mm' : args.filename ?? 'model';
      if (typeof stem !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(stem) || /[. ]$/.test(stem)) {
        throw Error('Укажите короткое имя файла без пути.');
      }
      const payload: Record<string,unknown> = legacy ? { distance } : { action };
      let bytes = 0;
      if (action !== 'create') {
        if (args.sourceName !== undefined && !String(args.sourceName).toLowerCase().endsWith('.fcstd')) throw Error('Нужен исходный FCStd.');
        const source = args.sourceName !== undefined ? await this.reference(args.sourceName).read(signal) :
          this.workingModel ?? await this.previous(signal);
        if (!source) throw Error('Предыдущая сборка FreeCAD недоступна. Прикрепите FCStd или создайте новую модель.');
        payload.source = source.toString('base64');
        bytes += source.length;
      }
      if (!legacy && action !== 'inspect') {
        if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > 64000) throw Error('Передайте скрипт FreeCAD в поле code.');
        payload.code = args.code;
        if (args.bomRoot !== undefined) payload.bomRoot = args.bomRoot;
        const names = args.referenceNames ?? [];
        if (!Array.isArray(names) || names.length > 8 || new Set(names).size !== names.length) throw Error('Укажите до восьми разных вложений.');
        const refs = [];
        for (const name of names) {
          const data = await this.reference(name).read(signal);
          bytes += data.length;
          if (bytes > 25 * 1024 * 1024) throw Error('Исходные CAD-файлы вместе превышают 25 МиБ.');
          refs.push({ name, data: data.toString('base64') });
        }
        payload.references = refs;
      }
      const data = await requestModel(this.socketPath, legacy ? '/linkage' : '/design', payload,
        AbortSignal.any([signal, AbortSignal.timeout(110_000)]));
      this.authorize();
      signal.throwIfAborted();
      if (action === 'inspect') return { success:true, text:JSON.stringify(data.report) };
      const files = (['FCStd','glb'] as const).map(ext => ({ name: stem + '.' + ext, contents: Buffer.from(data[ext] ?? '', 'base64') }));
      if (files.some(f => f.contents.length > 20 * 1024 * 1024) || files[0].contents.readUInt32LE() !== 0x04034b50 ||
        files[1].contents.readUInt32LE() !== 0x46546c67 || files[1].contents.readUInt32LE(8) !== files[1].contents.length) throw Error('Некорректные выходные файлы FreeCAD.');
      if (data.bom) files.push({name:stem + '.bom.json', contents:Buffer.from(JSON.stringify(data.bom,null,2))});
      this.workingModel = files[0].contents;
      this.files = files;
      return { success: true, text: JSON.stringify({ action, distanceMm: distance, components: data.report?.components ?? 11, attachments: files.map(f => f.name) }) };
    } catch (error) {
      signal.throwIfAborted();
      this.authorize();
      return { success: false, text: error instanceof Error ? error.message.slice(-2400) : 'FreeCAD не завершил построение.' };
    } finally { this.busy = false; }
  }
}
