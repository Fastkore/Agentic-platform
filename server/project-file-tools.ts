import type { Project } from '../shared/types.js';
import type { CodexToolDefinition, CodexTools } from './codex-tools.js';
import { publicProjectFile, supportsDocumentText } from './documents.js';
import type { FileStorage } from './file-storage.js';
import { redact } from './store.js';

const list: CodexToolDefinition = {
  type: 'function', name: 'project_files_list', description: 'Показывает файлы, добавленные администратором в текущий проект.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 } } },
};
const read: CodexToolDefinition = {
  type: 'function', name: 'project_files_read', description: 'Извлекает краткую текстовую выдержку из файла текущего проекта по его ID.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
};

export function withProjectFiles(other: CodexTools | undefined, project: Project, storage: FileStorage, authorize: () => void, allowedFiles: ReadonlySet<string>): CodexTools {
  return {
    definitions: [...(other?.definitions ?? []), list, read],
    async call(name, args, signal) {
      const fail = (text: string) => ({ success: false, text });
      if (name !== list.name && name !== read.name) {
        return other ? other.call(name, args, signal) : fail('Инструмент недоступен.');
      }
      authorize();
      signal.throwIfAborted();
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('Укажите параметры инструмента.');
      const input = args as Record<string, unknown>;
      const files = project.attachments.filter(file => file.libraryUploadedAt && allowedFiles.has(file.id));
      if (name === list.name) {
        const offset = input.offset ?? 0;
        if (Object.keys(input).some(key => key !== 'offset') || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
          return fail('Укажите допустимое смещение списка.');
        }
        const pageSize = 40;
        return { success: true, text: redact(JSON.stringify({
          files: files.reverse().slice(offset, offset + pageSize).map(publicProjectFile),
          nextOffset: files.length > offset + pageSize ? offset + pageSize : null,
        })) };
      }
      if (typeof input.id !== 'string' || Object.keys(input).length !== 1) return fail('Укажите ID файла из списка.');
      const file = files.find(item => item.id === input.id);
      if (!file) return fail('Файл в этом проекте не найден.');
      if (!supportsDocumentText(file.name)) return fail('Текстовая выдержка для этого формата недоступна.');
      let text: string;
      try { text = await storage.excerpt(project, file, signal); }
      catch { return fail('Не удалось прочитать файл проекта.'); }
      authorize();
      signal.throwIfAborted();
      if (!project.attachments.includes(file)) return fail('Файл удалён из проекта.');
      return { success: true, text: redact(JSON.stringify({ name: file.name, excerpt: text })) };
    },
  };
}
