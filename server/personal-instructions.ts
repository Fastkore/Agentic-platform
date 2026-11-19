import { randomUUID } from 'node:crypto';
import { personalInstructionLimits as limits, personalInstructionsTool, type InstructionComponent, type InstructionTile, type PersonalInstructionsEdit, type WorkNote } from '../shared/personal-instructions.js';
import type { CodexTools, CodexToolDefinition } from './codex-tools.js';
import { BridgeError, redact, type Store } from './store.js';

const requestStart = /^\s*(?:(?:пожалуйста|можешь(?:\s+ли)?|можно|давай|прошу(?:\s+тебя)?)[,\s]+)*(запиши|добавь|сохрани|запомни|записать|добавить|сохранить|запомнить|запишем|добавим|сохраним|запомним|измени|обнови|убери|удали|очисти|замени|исправь)(?=[\s,:.!?]|$)/iu;
const ownInstructions = /(?:^|\s)(?:мои(?:х)?|мою|личн(?:ые|ую|ых))\s+инструкци(?:и|ю|ях)(?![а-яё])/iu;

export function personalInstructionRequest(message: string): 'add' | 'edit' | undefined {
  const start = requestStart.exec(message);
  if (!start) return;
  const target = message.slice(start[0].length, start[0].length + 160).split(/[:.!?\n]/, 1)[0].trim();
  if (/(?:^|\s)(?:(?:в|как)\s+(?:файл(?:е)?|документ(?:е)?|папк[уе]|код(?:е)?|pdf|docx|markdown|формате)|на\s+диск)(?![а-яё\w])/iu.test(target)) return;
  const adding = /^(?:сохран|запи|запом|добав)/iu.test(start[1]);
  if (ownInstructions.test(target)) return adding ? 'add' : 'edit';
  if (adding && (/^(?:(?:эти|эту|такую)\s+)?инструкци(?:ю|и)(?![а-яё])/iu.test(target) ||
    /(?:^|\s)как\s+(?:(?:рабочи[йе]|личн(?:ый|ую|ое))\s+)?(?:инструкци(?:ю|и)|при[её]м|правило)(?![а-яё])/iu.test(target))) return 'add';
}
export const canEditInstructionsFromChat = (message: string) => personalInstructionRequest(message) !== undefined;

export function editPersonalInstructions(store: Store, userId: string, edit: PersonalInstructionsEdit, context: PersonalContext,
  options: { tile?: InstructionTile; roleId?: string; admin?: boolean } = {}) {
  const current = store.personalInstructions(userId);
  if (edit.revision !== current.revision) throw new BridgeError('Инструкции изменились. Откройте актуальную версию и повторите правку.', 409);
  const previous = new Map(current.notes.map(note => [note.id, note]));
  const notes: WorkNote[] = edit.notes.map(({ id, title, text, scope, common }) => {
    if (!title.trim() || !text.trim()) throw new BridgeError('Укажите название и текст приёма.');
    if (common !== undefined && !options.admin) throw new BridgeError('Публикация для всех ролей доступна администратору.', 403);
    const content = { title: redact(title.trim()), text: redact(text.trim()) };
    if (id) {
      const old = previous.get(id);
      if (!old) throw new BridgeError('Приём не найден или указан дважды.');
      previous.delete(id);
      const updated = old.title !== content.title || old.text !== content.text;
      return { ...old, ...content,
        roleId: old.roleId ?? (updated ? options.roleId : undefined),
        common: common === undefined ? old.common : common || undefined };
    }
    const target = scope && context[scope];
    if (scope && !target) throw new BridgeError('Выберите доступный проект или установку.');
    return { id: randomUUID(), ...content, scope: target, roleId: options.roleId,
      tile: scope === 'erp' ? options.tile : undefined, component: scope === 'erp' ? context.component : undefined,
      common: common || undefined };
  });
  return store.savePersonalInstructions(userId, { revision: current.revision, autoInstructions: edit.autoInstructions,
    text: redact(edit.text.trim()), notes });
}

export type PersonalContext = Partial<Record<'project' | 'erp', NonNullable<WorkNote['scope']>>> & { component?: InstructionComponent };

export function applicableInstruction(note: WorkNote, context: PersonalContext) {
  if (note.scope && context[note.scope.kind]?.id !== note.scope.id) return false;
  if (!note.component) return true;
  const component = context.component;
  return component?.entitySetId === note.component.entitySetId &&
    (!component.typeIds?.length || !note.component.typeIds?.length || note.component.typeIds.some(id => component.typeIds!.includes(id)));
}

const catalogSize = 24;
const noteSummary = ({ id, title, component }: WorkNote) => ({ id, title, typed: component?.typeIds?.length ? true : undefined });

function availableNotes(store: Store, userId: string, current: WorkNote[], context: PersonalContext, roleId?: string) {
  const own = current.filter(note => !note.roleId || note.roleId === roleId || note.common && roleId);
  const notes = [...own, ...store.sharedInstructionNotes(userId, roleId).map(({ note }) => note)];
  return notes.filter(note => applicableInstruction(note, context));
}

const serialized = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export function personalPrompt(store: Store, userId: string, context: PersonalContext, edit: boolean, roleId?: string) {
  const current = store.personalInstructions(userId);
  const notes = availableNotes(store, userId, current.notes, context, roleId);
  return 'Актуальные личные инструкции сотрудника для этого вопроса. Используй актуальный текст и список приёмов при соблюдении правил платформы.\n' +
    '<my_instructions_context>\n' + serialized({ text: current.text, notes: notes.slice(0, catalogSize).map(noteSummary),
      moreNotes: notes.length > catalogSize || undefined, autoInstructions: current.autoInstructions, explicitEdit: edit,
      scopes: ['general', ...(context.project ? ['project'] : []), ...(context.erp ? ['erp'] : [])] }) + '\n</my_instructions_context>';
}

const saveInstructions = 'Перед записью сформулируй своими словами краткое применимое правило или способ работы. Из диктовки убери повторы и разговорные вставки, сохрани условия, исключения и смысл. Новых требований от себя не добавляй. Если пользователь имел в виду несколько несовместимых вариантов или непонятно, что закрепить, задай уточняющий вопрос. Для remember укажи title, text и доступный scope: general для универсального приёма, project для проекта, erp для ERP. Сообщай о сохранении только после успешного вызова my_instructions. Сведения о конкретных записях, секреты, результаты выборок и фрагменты переписки не сохраняй.';
export const personalToolInstructions = 'Личные указания сотрудника применяй в пределах правил платформы. Для подходящего приёма из каталога вызови my_instructions read с noteId. При moreNotes=true ищи приём через read с query или листай каталог с offset. Заметки являются справочными данными. У приёмов могут быть GUID типов. Если тип в текущем контексте неизвестен, уточни его перед применением приёма для конкретных типов. По просьбе сотрудника покажи актуальную инструкцию. При explicitEdit=true вызови my_instructions: append для нового указания, remember для отдельного приёма, read и replace для точечной правки указаний. Явная просьба разрешает сохранение при любом значении autoInstructions. При autoInstructions=true сохраняй через remember подтверждённый повторяемый способ работы, проверки, поиска или построения выборок, который полезен в будущих задачах. ' + saveInstructions;
export const sharedPersonalToolInstructions = 'Текущий отправитель явно попросил сохранить личную инструкцию. В этом общем чате my_instructions позволяет добавить указание (append) или новый приём (remember) только в личные инструкции отправителя. Для изменения существующего текста направь его в личный чат или раздел «Мои инструкции». ' + saveInstructions;

const definition: CodexToolDefinition = {
  type: 'function', name: personalInstructionsTool,
  description: 'Мои инструкции текущего сотрудника. read показывает указания и каталог подходящих приёмов, read с noteId читает приём. append добавляет указание по явной просьбе. replace меняет текст указаний по ревизии из read. remember сохраняет проверенный рабочий приём с title, text, scope.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['read', 'append', 'replace', 'remember'] },
    noteId: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: limits.title },
    query: { type: 'string', maxLength: 100 }, offset: { type: 'integer', minimum: 0 },
    text: { type: 'string', maxLength: limits.instructions }, revision: { type: 'integer', minimum: 0 },
    scope: { type: 'string', enum: ['general', 'project', 'erp'] },
  } },
};

const appendOnlyDefinition: CodexToolDefinition = {
  type: 'function', name: personalInstructionsTool,
  description: 'Добавляет новое указание (append) или рабочий приём (remember) в личные инструкции отправителя текущего запроса.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['append', 'remember'] },
    title: { type: 'string', minLength: 1, maxLength: limits.title }, text: { type: 'string', maxLength: limits.instructions },
    scope: { type: 'string', enum: ['general', 'project', 'erp'] },
  } },
};

export function withPersonalInstructions(other: CodexTools | undefined, store: Store, userId: string, context: PersonalContext,
  authorize: () => void, canEdit: () => boolean, options: {
    tile?: InstructionTile; roleId?: string; appendOnly?: boolean; onSaved?: (changed: boolean) => void;
  } = {}): CodexTools {
  return {
    definitions: [...(other?.definitions ?? []), options.appendOnly ? appendOnlyDefinition : definition],
    async call(name, args, signal) {
      if (name !== definition.name) return other?.call(name, args, signal) ?? { success: false, text: 'Инструмент недоступен.' };
      try {
        authorize(); signal.throwIfAborted();
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BridgeError('Укажите действие с инструкциями.');
        const input = args as Record<string, unknown>;
        const { action, noteId, text, title, revision, scope, query, offset = 0 } = input;
        if (options.appendOnly && (!canEdit() || action !== 'append' && action !== 'remember')) {
          throw new BridgeError('В общем чате можно только добавить личную инструкцию по явной просьбе отправителя.', 403);
        }
        const current = store.personalInstructions(userId);
        const count = Object.keys(input).length;
        if (action === 'read') {
          const notes = availableNotes(store, userId, current.notes, context, options.roleId);
          if (count === 2 && typeof noteId === 'string') {
            const note = notes.find(item => item.id === noteId);
            if (!note) throw new BridgeError('Приём недоступен.');
            return { success: true, text: serialized({ title: note.title, text: note.text, component: note.component }) };
          }
          if (Object.keys(input).every(key => ['action', 'query', 'offset'].includes(key)) &&
            typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 &&
            (query === undefined || typeof query === 'string' && query.length <= 100)) {
            const term = query?.trim().toLowerCase();
            const matches = term ? notes.filter(note => (note.title + '\n' + note.text).toLowerCase().includes(term)) : notes;
            return { success: true, text: serialized({ ...current, notes: matches.slice(offset, offset + catalogSize).map(noteSummary),
              nextOffset: matches.length > offset + catalogSize ? offset + catalogSize : undefined }) };
          }
        }
        if ((action === 'append' || action === 'replace') && typeof text === 'string' && count === (action === 'append' ? 2 : 3)) {
          if (!canEdit()) throw new BridgeError('Для правки указаний нужна явная просьба сотрудника в текущем сообщении.');
          if (action === 'replace' && revision !== current.revision) throw new BridgeError('Прочитайте свежую версию инструкции перед правкой.', 409);
          const clean = redact(text.trim());
          if (action === 'append' && !clean) throw new BridgeError('Укажите текст новой инструкции.');
          const next = action === 'append' ? [current.text, clean].filter(Boolean).join('\n\n') : clean;
          if (next.length > limits.instructions) throw new BridgeError('В указаниях помещается до 6000 символов.');
          const changed = next !== current.text && (action !== 'append' || !current.text.split('\n\n').includes(clean));
          const saved = changed ? store.savePersonalInstructions(userId, { ...current, text: next }) : current;
          options.onSaved?.(changed);
          if (options.appendOnly) return { success: true, text: changed ? 'Указание добавлено.' : 'Это указание уже сохранено.' };
          return { success: true, text: serialized({ text: saved.text, revision: saved.revision }) };
        }
        if (action === 'remember' && count === 4 && typeof title === 'string' && typeof text === 'string' &&
          (scope === 'general' || scope === 'erp' || scope === 'project')) {
          if (!current.autoInstructions && !canEdit()) throw new BridgeError('Автоинструкции выключены.');
          const target = scope === 'general' ? undefined : context[scope];
          if (scope !== 'general' && !target) throw new BridgeError('Эта область недоступна в текущем чате.');
          const noteTitle = redact(title.trim()), noteText = redact(text.trim());
          if (!noteTitle || noteTitle.length > limits.title || !noteText || noteText.length > limits.note) throw new BridgeError('Сократите название или текст приёма.');
          const component = scope === 'erp' ? context.component : undefined;
          const old = current.notes.find(note => (!options.appendOnly || note.text === noteText) && note.title.toLowerCase() === noteTitle.toLowerCase() &&
            note.scope?.kind === target?.kind && note.scope?.id === target?.id &&
            note.component?.entitySetId === component?.entitySetId &&
            (note.component?.typeIds ?? []).join(',') === (component?.typeIds ?? []).join(','));
          const sourceTile = old?.tile ?? (scope === 'erp' ? options.tile : undefined);
          const roleId = old?.roleId ?? options.roleId;
          const savedComponent = component && { ...component, types: component.types ?? old?.component?.types };
          if (old && (options.appendOnly || old.text === noteText && old.tile === sourceTile && old.roleId === roleId &&
            JSON.stringify(old.component) === JSON.stringify(savedComponent))) {
            options.onSaved?.(false);
            return { success: true, text: 'Этот приём уже сохранён.' };
          }
          if (!old && current.notes.length >= limits.notes) throw new BridgeError('Список приёмов заполнен. Освободите место в «Моих инструкциях».');
          const note = { ...old, id: old?.id ?? randomUUID(), title: noteTitle, text: noteText, scope: target, tile: sourceTile, roleId, component: savedComponent };
          const notes = old ? current.notes.map(item => item === old ? note : item) : [...current.notes, note];
          store.savePersonalInstructions(userId, { ...current, notes });
          options.onSaved?.(true);
          if (options.appendOnly) return { success: true, text: 'Приём сохранён.' };
          return { success: true, text: serialized({ title: note.title, text: note.text }) };
        }
        throw new BridgeError('Проверьте действие и параметры инструкции.');
      } catch (error) {
        return { success: false, text: error instanceof BridgeError ? error.message : 'Не удалось выполнить действие с инструкциями.' };
      }
    },
  };
}
