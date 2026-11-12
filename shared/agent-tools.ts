export const agentTools = [
  { id: 'project-files', name: 'Файлы проекта', description: 'Поиск и чтение материалов из библиотеки проекта.' },
  { id: 'chat-files', name: 'Вложения и файлы ответа', description: 'Чтение вложений из чата и создание файлов, если включена запись.' },
  { id: 'fastkore', name: 'Fastkore ERP', description: 'Чтение данных Fastkore в пределах прав сотрудника.' },
] as const;

export type AgentToolId = typeof agentTools[number]['id'];
export const agentToolIds = agentTools.map(tool => tool.id);
