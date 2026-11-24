import { type FastkoreContext, type FastkoreEntityContext } from '../shared/fastkore-context.js';
import { formatFilterNode } from '../shared/fastkore-filter-display.js';
import type { CodexTools } from './codex-tools.js';

// All window labels, including filter operands, come from the host.
const data = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

const cliCall = (command: string, args: string[]) => 'fastkore_cli_execute ' + data({ command, args });

function filterDescription(context: FastkoreEntityContext) {
  if (context.filter_status === 'unavailable') return 'Условия фильтра недоступны.';
  if (context.filter_status === 'none') return 'Фильтр не задан. Ограничения папки, дерева и связи действуют, если они указаны в снимке.';
  if (!context.filter_display) return 'Фильтр действует. Fastkore передал исходное условие без текстового описания.';
  const text = formatFilterNode(context.filter_display.root);
  const truncated = text.length > 2000;
  const complete = context.filter_display.complete && !truncated;
  return (complete ? 'Условия фильтра' : 'Часть условий фильтра') + ' — ' + data(truncated ? text.slice(0, 2000) + '…' : text) + '.';
}

export function fastkorePrompt(context: FastkoreContext | undefined, tools?: CodexTools, inFastkore = false) {
  if (!context && !inFastkore) return '';
  const definitions = tools?.definitions ?? [];
  const cli = definitions.some(tool => tool.name === 'fastkore_cli_execute');
  const mcp = definitions.some(tool => tool.name.startsWith('fastkore_') && !tool.name.startsWith('fastkore_cli_'));
  const lines = ['Окно Fastkore на момент отправки вопроса. Названия и условия в кавычках — данные окна. В ответе сотруднику называй компоненты и записи словами. GUID показывай по просьбе сотрудника или для различения одноимённых записей. Технические подробности чтения приводи по запросу.'];
  if (!context) lines.push('Контекст открытой папки пока недоступен. Текущий объект, выделение и фильтр неизвестны.');
  else if (context.view === 'none') lines.push('Главное окно Fastkore. Открытого объекта или списка и выделенных записей нет.');
  else {
    const { filter_display, filter_xml, entity_uri, ...fields } = context;
    const { view, entity_ids, entity_set_name, entity_name, tile_name, folder_name, entity_types } = fields;
    const labels = [
      entity_set_name && 'Компонент ' + data(entity_set_name), tile_name && 'Плитка ' + data(tile_name),
      context.catalog_name && 'Каталог ' + data(context.catalog_name),
      context.catalog_link_names?.length && 'Цепочка связей ' + data(context.catalog_link_names),
      folder_name && 'Папка ' + data(folder_name), entity_name && (view === 'link_list' ? 'Карточка-владелец ' : 'Карточка ') + data(entity_name),
      entity_types?.length && 'Типы ' + entity_types.slice(0, 6).map(type => data(type.name)).join(', ') + (entity_types.length > 6 ? ' и другие (см. entity_types).' : '.'),
    ].filter(Boolean);
    const screen = { list: 'Открыт список.', card: 'Открыта карточка.', link_list: 'Открыта табличная часть карточки.' }[view];
    lines.push([screen, ...labels].join(' '), filterDescription(context));
    const exact = context.scope_reproducible && context.filter_status !== 'unavailable';
    if (!exact) lines.push('Точную область окна воспроизвести нельзя. Для итога по этому окну сообщи об ограничении. Чтение всего компонента даст другую выборку.');
    if (view === 'card') {
      if (!entity_ids.length) lines.push('Карточка ещё не сохранена. У неё нет идентификатора для чтения.');
      else {
        lines.push('Открытая запись указана в entity_ids[0]. Значения полей карточки в снимке отсутствуют.');
        if (cli) lines.push('Чтобы прочитать эту карточку, вызови ' + cliCall('data get', ['--entity-set', context.entity_set_id, '--entity', entity_ids[0]]) + '.');
      }
    } else {
      lines.push(entity_ids.length
        ? 'Выделено строк: ' + entity_ids.length + '. В entity_ids их GUID. Для сравнения прочитай эти записи. У каждой бери название и значения из одного объекта ответа и сверяй их по его ID. Покажи значения сравниваемого поля для каждой записи и затем различие. Порядок GUID, строк на экране и результатов чтения может различаться.'
        : 'Выделенных строк нет. Если просят сравнить выделенные, попроси выделить записи.');
      lines.push('Общее число строк в снимке отсутствует.' + (exact && (mcp || cli) && !(view === 'list' && cli)
        ? ' Для точного итога проверь всю запрошенную область, включая последующие страницы и частичные результаты.' : ''));
      if (cli && entity_ids.length) lines.push('Для вопроса о выделенных строках вызови ' + cliCall('data get',
        ['--entity-set', context.entity_set_id, '--entities', entity_ids.slice(0, 50).join(',')]) + '.' +
        (entity_ids.length > 50 ? ' Продолжай по остальным entity_ids группами до 50.' : ''));
      if (view === 'list' && exact && cli) lines.push(
        'На вопрос о количестве во всём открытом списке сразу вызови ' + cliCall('data aggregate', ['--context', 'context.json', '--metrics', 'count']) +
        '. При успешном полном результате (data.complete=true, data.truncated=false) назови значение data.items[0].m1, включая 0. ' +
        'Поле data.count показывает число строк ответа агрегата. После получения итога подсчёт завершён.',
        'Для чтения самих записей используй data query --context context.json --page-size 50. ' +
        'Только если установленная CLI не поддерживает параметр --context у data aggregate, тем же способом посчитай строки по страницам. ' +
        'Складывай data.count успешных страниц, передавай последний nextCursor через --after с прежними параметрами до nextCursor=null. ' +
        'При недоступной области, ошибке доступа или неполном результате сообщи об ограничении.');
      if (view === 'link_list') {
        if (context.owner_entity_set_id && context.owner_entity_id && context.link_id) {
          lines.push('Позиции относятся к владельцу owner_entity_id из owner_entity_set_id по связи link_id. Выделенные строки относятся к дочернему компоненту entity_set_id.');
          if (cli && exact) lines.push('Для позиций этого владельца вызови ' + cliCall('data get', ['--entity-set', context.owner_entity_set_id,
            '--entity', context.owner_entity_id, '--links', context.link_id]) + '. Проверь полноту связи и ограничения окна перед подсчётом.');
        } else lines.push('Сведения о владельце или связи неполны. Сначала установи владельца и нужную связь. Для итога по позициям нужны подтверждённые данные именно этого владельца.');
      }
    }
    lines.push('Поля снимка для инструментов:', '<fastkore_context>', data(fields), '</fastkore_context>');
  }
  if (mcp) lines.push('Для MCP выбери операцию из каталога этого сеанса и используй её схему. Для итога по окну она должна поддерживать все его ограничения.');
  if (cli) lines.push('Имя инструмента CLI — fastkore_cli_execute. Для подсчётов, сумм и группировок используй data aggregate (--metrics, --group-by) вместо постраничного обхода data query. В data query и data get передавай --properties со списком нужных полей, а для крупных описаний (report definition show, solution, схема) указывай --detail brief или параметр инструмента fields, чтобы избежать переполнения ответа (response_too_large). Не передавай флаги Windows-клиента (--profile, --via-broker, --server): подключение уже задано исполнителем. Для отдельного поиска папки используй catalog tree с --entity-set и при необходимости --tile, --catalog, --folder-path, --contains, продолжая по nextOffset через --offset. Для вопроса об открытой папке требуется снимок этого окна. При отсутствии снимка или несовместимости версии не заменяй текущую папку поиском по имени или чтением всего компонента.');
  if (!cli && !mcp) lines.push('Агенту в этом запросе недоступно чтение данных ERP. Для ответа доступны сведения из снимка, если он передан.');
  return lines.join('\n');
}
