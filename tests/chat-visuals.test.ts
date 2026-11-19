import assert from 'node:assert/strict';
import test from 'node:test';
import { splitChatVisuals } from '../server/chat-visuals.js';

const reply = (blocks: unknown) => 'Итог\n\n```fastkore-visual\n' + JSON.stringify({ version: 1, blocks }) + '\n```';

test('visual output is split from Markdown and validated as typed data', () => {
  const blocks = [
    { type: 'metrics', items: [{ label: 'Заказы', value: 42 }, { label: 'Загрузка', value: 75.5, unit: '%' }] },
    { type: 'chart', title: 'Разница по неделям', points: [{ label: 'Первая', value: -3 }, { label: 'Вторая', value: 0 }] },
    { type: 'table', title: 'Заказы', columns: ['Номер', 'Закрыт', 'Цена'], rows: [['0042', true, null]] },
  ];
  const markdown = reply(blocks) + '\n\nПосле графика.';
  assert.deepEqual(splitChatVisuals(markdown), { text: 'Итог\n\n\nПосле графика.', visuals: blocks });
  assert.equal(splitChatVisuals(markdown, true).text, 'Итог\n\n\nПосле графика.');
  const plain = 'Пример\n````md\n```fastkore-visual\n{}\n```\n````\n';
  assert.deepEqual(splitChatVisuals(plain), { text: plain });
});

test('invalid or incomplete visual output never leaks into the displayed text', () => {
  const unsupported = { type: 'html', html: '<script>window.invalid = true</script>' };
  const wrongWidth = { type: 'table', title: 'Продажи', columns: ['Сумма'], rows: [[5, 6]] };
  const tooManyPoints = { type: 'chart', title: 'График', points: Array.from({ length: 33 }, () => ({ label: 'A', value: 1 })) };
  for (const invalid of [unsupported, wrongWidth, tooManyPoints]) {
    const response = splitChatVisuals(reply([invalid]));
    assert.equal(response.text, 'Итог');
    assert.equal(response.visuals, undefined);
  }
  const unsafeNumber = '```fastkore-visual\n{"version":1,"blocks":[{"type":"chart","title":"A","points":[{"label":"A","value":1e500}]}]}\n```';
  assert.equal(splitChatVisuals(unsafeNumber).visuals, undefined);
  assert.equal(splitChatVisuals('Итог\n```fastkore-visual\n{"version":1', true).text, 'Итог');
});
