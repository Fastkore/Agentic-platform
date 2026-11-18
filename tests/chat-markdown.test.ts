import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hideAttachedOutputLinks } from '../client/chat-markdown.js';

const origin = 'https://agents.example.test';
const output = '/runner/jobs/00112233-4455-6677-8899-aabbccddeeff/output/';
const files = [{ name: 'draft.eml' }, { name: 'Счёт 1.pdf' }];

function render(markdown: string, embedded = true) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: markdown,
    remarkPlugins: [remarkGfm],
    rehypePlugins: embedded ? [[hideAttachedOutputLinks, { origin, files }]] : undefined,
  }));
}

test('the Fastkore view removes a list of links for attached files from the rendered answer', () => {
  const markdown = `Готово.\n\n- [Письмо](${output}draft.eml)\n- **[Счёт](${output}${encodeURIComponent(files[1].name)})**`;
  assert.match(render(markdown, false), /<ul>[\s\S]*href=/);
  assert.equal(render(markdown).trim(), '<p>Готово.</p>');
});

test('the Fastkore view keeps contextual text and links to other files or websites', () => {
  const markdown = `Проверьте [письмо](output/draft.eml) перед отправкой.\n\n` +
    `- [Дубль](${origin}${output}draft.eml)\n` +
    `- [Другой результат](${output}notes.txt)\n` +
    `- [Внешний файл](https://other.example.test${output}draft.eml)\n` +
    `- [Инструкция](/manual/draft.eml)`;
  const html = render(markdown);
  assert.match(html, /<p>Проверьте письмо перед отправкой\.<\/p>/);
  assert.doesNotMatch(html, /href="output\/draft\.eml"|Дубль/);
  assert.match(html, /href="[^"]+\/notes\.txt"/);
  assert.match(html, /href="https:\/\/other\.example\.test\//);
  assert.match(html, /href="\/manual\/draft\.eml"/);
});
