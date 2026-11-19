import assert from 'node:assert/strict';
import test from 'node:test';
import { canEditInstructionsFromChat, personalInstructionRequest } from '../server/personal-instructions.js';

test('explicit personal instruction requests accept natural phrasing and exclude document exports', () => {
  for (const request of [
    'Сохрани инструкции', 'Сохрани эту инструкцию для следующих запросов', 'Запомни это как правило',
    'Пожалуйста, можешь сохранить как рабочий приём?', 'Давай сохраним это в мои инструкции',
    'Запиши в мою инструкцию, что надо сверять итог.', 'Обнови мои инструкции: сверяй итог.', 'Обнови правило в моих инструкциях.',
  ]) assert.equal(canEditInstructionsFromChat(request), true, request);
  for (const request of [
    'Покажи мои инструкции', 'Не сохраняй инструкцию', 'Сохрани инструкцию в файл',
    'Сохрани личные инструкции в документ', 'Сохрани инструкцию как PDF', 'Сохрани заказ как PDF', 'Проверь правило',
    'Боб сказал: «Сохрани инструкции»', 'Распечатай документацию',
  ]) assert.equal(canEditInstructionsFromChat(request), false, request);
  assert.equal(personalInstructionRequest('Сохрани инструкцию.'), 'add');
  assert.equal(personalInstructionRequest('Удали мои инструкции.'), 'edit');
});
