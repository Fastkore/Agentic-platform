import type { CodexTools, CodexToolDefinition } from './codex-tools.js';
import type { KnowledgeBase } from './knowledge.js';
import type { KnowledgeSection } from '../shared/knowledge.js';
import { BridgeError, redact } from './store.js';

const definition: CodexToolDefinition = {
  type: 'function', name: 'knowledge',
  description: 'Общая база знаний. index — файлы или оглавление файла. search — до 5 коротких результатов по словам. read — один фрагмент до 4000 символов по id, revision и part из поиска или оглавления. Используй уже прочитанные актуальные фрагменты из истории. После сокращения контекста можно прочитать нужный фрагмент повторно.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'section'], properties: {
    action: { enum: ['index', 'search', 'read'] }, section: { enum: ['fastkore', 'company'] },
    id: { type: 'string' }, revision: { type: 'string' }, query: { type: 'string', maxLength: 300 },
    part: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 },
  } },
};
export function withKnowledge(other: CodexTools | undefined, knowledge: KnowledgeBase, authorize: () => void): CodexTools {
  return {
    definitions: [...(other?.definitions ?? []), definition],
    async call(name, args, signal) {
      if (name !== definition.name) return other ? other.call(name, args, signal) : { success: false, text: 'Инструмент недоступен.' };
      authorize(); signal.throwIfAborted();
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { success: false, text: 'Укажите параметры базы знаний.' };
      const { action, section, id, revision, query, part = 0, offset = 0 } = args as Record<string, unknown>;
      if ((section !== 'fastkore' && section !== 'company') || !Number.isSafeInteger(part) || Number(part) < 0 || !Number.isSafeInteger(offset) || Number(offset) < 0) {
        return { success: false, text: 'Проверьте раздел и номер фрагмента.' };
      }
      try {
        let result: unknown;
        if (action === 'index' && (id === undefined || typeof id === 'string')) result = knowledge.index(section as KnowledgeSection, id, Number(offset));
        else if (action === 'search' && typeof query === 'string' && query.length <= 300) result = knowledge.search(section, query);
        else if (action === 'read' && typeof id === 'string' && typeof revision === 'string') result = knowledge.read(section, id, revision, Number(part));
        else return { success: false, text: 'Для поиска нужен query, для чтения — id, revision и part.' };
        return { success: true, text: redact(JSON.stringify(result)) };
      } catch (error) {
        return { success: false, text: error instanceof BridgeError ? error.message : 'Не удалось прочитать базу знаний.' };
      }
    },
  };
}
