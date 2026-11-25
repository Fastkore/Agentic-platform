import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, idle } from './library-app.js';

test('a private ERP chat keeps its actual opening and replays published turns once across equivalent logins', async () => {
  const f = await fixture(async () => 'Опубликованный итог');
  try {
    const principal = f.workspace.store.state.security!.credentials.find(c => c.userId === f.employee.id && c.source === 'fastkore')!;
    const set = randomUUID(), tile = randomUUID();
    const context = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: set, entity_ids: [],
      chat_key: 'tile:' + tile, tile_id: tile, tile_name: 'Текущие заказы', filter_status: 'none', scope_reproducible: true };
    const created = await f.req('POST', '/api/fastkore/chats', f.token, { projectId: f.project.id, context });
    assert.equal(created.statusCode, 201, created.body);
    const chat = f.workspace.chat(f.project.id, created.json().chat.id);
    let cookie = f.token;
    async function send(text: string) {
      const sent = await f.req('POST', '/api/projects/' + f.project.id + '/chats/' + chat.id + '/messages', cookie, { text, fastkoreContext: context });
      assert.equal(sent.statusCode, 202, sent.body);
      await idle(f.workspace);
      const run = f.workspace.getRun(sent.json().id);
      assert.equal(run.status, 'complete', run.error);
      const call = f.calls.at(-1)!;
      const timeline = JSON.parse(call.prompt.split('<chat_timeline>\n').at(-1)!.split('\n</chat_timeline>')[0]);
      return { call, run, timeline };
    }
    const first = await send('Что на экране?');
    assert.equal(first.timeline.были_предыдущие_сообщения, false);
    const login = async (extraRole = false) => (await f.enter('Алиса', principal.externalUserId, [
      ...principal.externalRoles!, ...(extraRole ? [{ id: randomUUID(), name: 'Дополнительная роль' }] : []),
    ])).cookie;
    cookie = await login();
    const renewed = await send('Продолжай');
    assert.equal(renewed.call.sessionId, undefined);
    assert.match(renewed.call.prompt, /<chat_history>[\s\S]*Опубликованный итог/);
    assert.equal(renewed.timeline.первое_сообщение_UTC, first.run.createdAt);
    assert.ok(renewed.timeline.были_предыдущие_сообщения);
    const live = await send('Дальше');
    const again = await send('Ещё');
    assert.ok(live.call.sessionId);
    assert.doesNotMatch(live.call.prompt, /<chat_history>/);
    assert.equal(live.call.prompt.split('<chat_timeline>')[0], again.call.prompt.split('<chat_timeline>')[0]);
    cookie = await login(true);
    assert.doesNotMatch((await send('Новая роль')).call.prompt, /Опубликованный итог/);

    // Historical Nordmile shape: source-free opening, old profile revision, a new credential and an empty native thread.
    for (const message of chat.messages) { delete message.renewalScope; delete message.libraryHistory; }
    delete chat.verifiedOpeningRunId;
    chat.messages[0].attachments = [{ id: randomUUID(), name: 'private-original-image.png', size: 12 }];
    f.project.chatDefaults = { instructions: 'Проверяй единицы.', model: '', reasoningEffort: 'high', revision: 4 };
    cookie = await login();
    const recovered = await send('С чего и когда мы начали?');
    assert.equal(recovered.call.sessionId, undefined);
    assert.equal(recovered.timeline.первое_сообщение_UTC, first.run.createdAt);
    assert.equal(recovered.timeline.начало_первого_вопроса, 'Что на экране?');
    assert.doesNotMatch(recovered.call.prompt, /Опубликованный итог|private-original-image/);
    // Positive provenance for the original question never admits a restricted or different-selection question.
    chat.messages[1].libraryHistory = 'restricted:test';
    const bounded = await send('Когда начали?');
    assert.equal(bounded.timeline.первое_сообщение_UTC, first.run.createdAt);
    assert.equal(bounded.timeline.начало_первого_вопроса, undefined);
    assert.doesNotMatch(bounded.call.prompt, /Что на экране/);
  } finally { await f.app.close(); }
});
