import type { ChatVisual, VisualCell } from '../shared/chat-visuals.js';
import { redact } from './store.js';

const fenceName = 'fastkore-visual';
const limits = { payload: 32_000, blocks: 6, metrics: 8, points: 32, columns: 12, rows: 100 };

export const chatVisualInstructions = [
  'Если нужен график, набор показателей или таблица, кратко объясни вывод обычным текстом и добавь один блок ```fastkore-visual в конце ответа. Закрой его строкой ```. Внутри только JSON без комментариев.',
  'Формат: {"version":1,"blocks":[{"type":"metrics","items":[{"label":"Заказы","value":42}]},{"type":"chart","title":"Заказы по неделям","unit":"шт.","points":[{"label":"1-я неделя","value":42}]},{"type":"table","title":"Заказы","columns":["Номер","Сумма"],"rows":[["A-123",12000]]}]}.',
  'Выбирай нужные блоки. График столбчатый. Числа передавай числами без форматирования, единицу измерения передавай отдельно в unit. Ячейки таблицы — строки, числа, true/false или null. Число ячеек строки должно точно совпадать с числом колонок.',
  `Лимиты: до ${limits.blocks} блоков, ${limits.metrics} показателей, ${limits.points} точек графика, ${limits.columns} колонок и ${limits.rows} строк таблицы. Это формат передачи данных интерфейсу. Данные визуализации подчиняются тем же правилам публикации, что и текст ответа. Укажи источник и период, когда они известны. Если данных не хватает для фактических показателей, объясни, каких данных не хватает.`,
].join('\n');

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length > 0 && value.length <= max;
const number = (value: unknown): value is number => typeof value === 'number' && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const label = (value: unknown, max = 120) => typeof value === 'string' && value.length <= max && value.trim() ? redact(value.trim()) : undefined;

function decodeBlock(value: unknown): ChatVisual | undefined {
  if (!record(value)) return;
  switch (value.type) {
    case 'metrics': {
      if (!list(value.items, limits.metrics)) return;
      const items: Extract<ChatVisual, { type: 'metrics' }>['items'] = [];
      for (const item of value.items) {
        if (!record(item)) return;
        const name = label(item.label), amount = number(item.value) ? item.value : label(item.value, 64), unit = label(item.unit, 24);
        if (!name || amount === undefined || item.unit !== undefined && !unit) return;
        items.push({ label: name, value: amount, ...(unit && { unit }) });
      }
      return { type: 'metrics', items };
    }
    case 'chart': {
      const title = label(value.title), unit = label(value.unit, 24);
      if (!title || value.unit !== undefined && !unit || !list(value.points, limits.points)) return;
      const points: Extract<ChatVisual, { type: 'chart' }>['points'] = [];
      for (const point of value.points) {
        if (!record(point)) return;
        const name = label(point.label);
        if (!name || !number(point.value)) return;
        points.push({ label: name, value: point.value });
      }
      return { type: 'chart', title, ...(unit && { unit }), points };
    }
    case 'table': {
      const title = label(value.title);
      if (!title || !list(value.columns, limits.columns) || !list(value.rows, limits.rows)) return;
      const columns = value.columns.map(column => label(column));
      if (!columns.every(column => column !== undefined)) return;
      const rows: VisualCell[][] = [];
      for (const row of value.rows) {
        if (!Array.isArray(row) || row.length !== columns.length) return;
        const cells: VisualCell[] = [];
        for (const cell of row) {
          if (typeof cell === 'string' && cell.length <= 240) cells.push(redact(cell));
          else if (cell === null || typeof cell === 'boolean' || number(cell)) cells.push(cell);
          else return;
        }
        rows.push(cells);
      }
      return { type: 'table', title, columns, rows };
    }
  }
}

function decodeVisuals(payload: string[]) {
  const raw = payload.join('\n');
  if (raw.length > limits.payload) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  if (!record(value) || value.version !== 1 || !list(value.blocks, limits.blocks)) return;
  const blocks = value.blocks.map(decodeBlock);
  if (blocks.every(block => block !== undefined)) return blocks;
}

export function splitChatVisuals(reply: string, streaming = false): { text: string; visuals?: ChatVisual[] } {
  if (!reply.includes(fenceName)) return { text: reply };
  const visible: string[] = [];
  let opened: string | undefined, payload: string[] | undefined, visuals: ChatVisual[] | undefined, found = false;
  for (const line of reply.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (opened) {
      const closes = fence && fence[1][0] === opened[0] && fence[1].length >= opened.length && !fence[2].trim();
      if (closes) {
        if (payload && !streaming && !visuals) visuals = decodeVisuals(payload);
        if (!payload) visible.push(line);
        opened = payload = undefined;
      } else if (payload) {
        if (!streaming && !visuals) payload.push(line);
      } else visible.push(line);
    } else if (fence) {
      opened = fence[1];
      if (fence[2].trim() === fenceName) { found = true; payload = []; }
      else visible.push(line);
    } else visible.push(line);
  }
  if (!found) return { text: reply };
  const text = visible.join('\n').trim();
  return { text: text || (!streaming && !visuals ? 'Не удалось показать визуализацию.' : ''), visuals };
}

export function chatVisualPublicationText(visuals: ChatVisual[]) {
  return visuals.flatMap(visual => {
    switch (visual.type) {
      case 'metrics': return visual.items.map(item => [item.label, item.value, item.unit].join(' '));
      case 'chart': return [visual.title, visual.unit ?? '', ...visual.points.map(point => `${point.label} ${point.value}`)];
      case 'table': return [visual.title, visual.columns.join(' '), ...visual.rows.map(row => row.join(' '))];
    }
  }).join('\n');
}
