import test from 'node:test';
import assert from 'node:assert/strict';
import { codeStatement, publicationProblems } from '../server/library/tools.js';

const source = [
  '12: Каждая попытка отправки содержит заголовок Idempotency-Key: <GUID задания>, одинаковый для всех повторов.',
  '13: Поле linkListPlacement: null означает все связанные списки, пустой массив — ни одного.',
  '14: Обновление: fastkore command update --progress-name=Ожидание --placement LinkList',
  '15: Файл настроек Fastkore.Command.Settings.json лежит рядом с приложением.',
  '16:     var job = queue.Enqueue(message, idempotencyKey);',
  '17:     return job.Id;',
  '18: Повтор выполняется планировщиком по расписанию с нарастающей паузой между попытками доставки сообщения.',
].join('\n');

test('names of fields, headers, commands and files in inline code are published in explanation-only mode', () => {
  for (const answer of [
    'Получатель должен учитывать дубли по заголовку `Idempotency-Key: <GUID задания>` (Outgoing-HTTP-Queue-Spec.md:12).',
    'Для всех списков оставьте `linkListPlacement: null` (Guide.md:13).',
    'Обновите команду через `fastkore command update --progress-name=Ожидание` (Guide.md:14).',
    'Настройки — в `Fastkore.Command.Settings.json` (Guide.md:15).',
    'Задание ставит метод `queue.Enqueue` (Spec.md:16).',
  ]) assert.deepEqual(publicationProblems(answer, [source], 'explanation_only'), [], answer);
});

test('copied code, long quotations, listings and encoded copies are still blocked', () => {
  const cases: [string, string][] = [
    ['Задание создаёт `var job = queue.Enqueue(message, idempotencyKey);`', 'цитата исходного текста'],
    ['Дальше вычисление возвращает `return job.Id;`', 'цитата исходного текста'],
    ['Код:\n```\nreturn job.Id;\n```', 'блок кода'],
    ['Повтор выполняется планировщиком по расписанию с нарастающей паузой между попытками доставки сообщения.', 'дословный фрагмент источника'],
    ['QUJD'.repeat(40), 'длинная закодированная строка'],
  ];
  for (const [answer, problem] of cases) assert.ok(publicationProblems(answer, [source], 'explanation_only').includes(problem), answer);
  const listing = 'Поле linkListPlacement: null означает все связанные списки, пустой массив — ни одного.\n'
    + 'Обновление: fastkore command update --progress-name=Ожидание --placement LinkList\nФайл настроек Fastkore.Command.Settings.json лежит рядом с приложением.';
  assert.ok(publicationProblems(listing, [source], 'excerpts_allowed').includes('несколько строк исходного текста подряд'));
});

test('a code statement is recognised by its form, not by punctuation in a name', () => {
  for (const name of ['Idempotency-Key: <GUID задания>', 'Source/Business/Docs/readme.md', 'dotnet build -c Release --no-restore', 'PropertiesToolbar | LinkList',
    'SplitMethod.Auto', 'FindEntitiesWithLinks(entityIds)']) assert.equal(codeStatement(name), false, name);
  for (const code of ['var job = queue.Enqueue(message);', 'if (x > 0) { total += x; }', 'items.Where(i => i.Active).ToList()', 'return cost * markup + delivery;',
    'Calculate(order, region, discount)']) assert.equal(codeStatement(code), true, code);
});
