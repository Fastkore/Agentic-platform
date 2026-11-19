import type { RunToolContext } from '../shared/types';

export function runToolLabel(tool: string, context?: RunToolContext) {
  const area = context?.scope === 'erp' ? 'ERP' : 'текущий список';
  if (tool === 'fastkore_cli_data_query') {
    const page = context?.pageSize !== undefined ? (context.continuation ? 'следующая страница' : 'страница') + ` до ${context.pageSize}` : undefined;
    return ['Fastkore CLI', 'data query', context?.scope && area, page].filter(Boolean).join(' · ');
  }
  if (tool === 'fastkore_cli_data_get') {
    const target = context?.selection ? 'выделенные строки' : context?.scope === 'current' ? 'текущая карточка' : undefined;
    return ['Fastkore CLI', 'data get', target].filter(Boolean).join(' · ');
  }
  if (tool === 'fastkore_cli_auth_info') return 'Fastkore CLI · проверка входа';
  if (tool === 'fastkore_cli_catalog') return 'Fastkore CLI · каталог команд';
  if (tool === 'fastkore_cli_command_describe' || tool === 'fastkore_cli_describe') {
    return ['Fastkore CLI', 'описание команды', context?.operation].filter(Boolean).join(' · ');
  }
  if (tool.startsWith('fastkore_cli_')) return `Fastkore CLI · ${context?.operation ?? 'выполнение команды'}`;
  if (tool.startsWith('fastkore_')) return `Fastkore MCP · ${tool.slice('fastkore_'.length)}`;
  if (tool.startsWith('freecad_')) return 'FreeCAD · моделирование';
  if (tool === 'knowledge') return 'База знаний';
  if (tool === 'my_instructions') return 'Мои инструкции';
  if (tool === 'internet_search') return 'Поиск в интернете';
  if (tool === 'internet_read') return 'Чтение страницы';
  if (tool === 'internet_request') return 'Внешний запрос';
  if (tool === 'consult_specialist') return 'Консультация агента';
  return 'Инструмент';
}
