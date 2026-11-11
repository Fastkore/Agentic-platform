import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { createApp, AppOptions } from '../server/app.js';
import { audience, csrfFor } from '../server/fastkore.js';
import type { User } from '../shared/types.js';

type App = Awaited<ReturnType<typeof createApp>>;
const code = () => randomBytes(32).toString('base64url');

export function erpBrowser(publicOrigin = 'https://agents.example.test') {
  const headers = { host: new URL(publicOrigin).host, 'x-forwarded-proto': 'https', origin: publicOrigin };
  const tickets = new Map<string, { id: string; name: string; challenge: string }>();
  const options: AppOptions = {
    publicOrigin, trustedProxies: ['127.0.0.1'], ssoKey: randomBytes(32),
    pairingClient: async (_url, payload) => ({ version: 1, paired: true, installation_id: payload.installation_id }),
    ticketValidator: async (_url, _key, payload) => {
      const ticket = tickets.get(payload.ticket);
      if (!ticket || ticket.challenge !== payload.login_challenge) return { valid: false };
      tickets.delete(payload.ticket);
      return { version: 1, valid: true, installation_id: payload.installation_id, audience, user: { id: ticket.id, display_name: ticket.name } };
    },
  };

  function request(app: App) {
    return (method: any, url: string, session = '', payload?: unknown) => app.inject({
      method, url, headers: { ...headers, ...(session.startsWith('__Host-bridge_session=')
        ? { cookie: session, 'x-csrf-token': csrfFor(session.split('=')[1]) }
        : session ? { authorization: 'Bearer ' + session } : {}) },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function pair(app: App, admin: string) {
    const req = request(app);
    const installations = '/api/admin/fastkore/installations';
    const registration = await req('POST', installations, admin, { name: 'ERP', validateTicketUrl: 'https://erp.example.test/api/ai/validate-ticket', setup: 'pairing' });
    assert.equal(registration.statusCode, 201, registration.body);
    const id = registration.json().id;
    const linked = await req('POST', `${installations}/${id}/pair`, admin, { pairingCode: code() });
    assert.equal(linked.statusCode, 200, linked.body);

    return async (name: string, externalId = randomUUID()) => {
      const start = await app.inject({ url: '/auth/fastkore/start', headers });
      const prep = String(start.headers['set-cookie']).split(';')[0];
      const challenge = start.body.match(/name="fastkore-login-challenge" content="([A-Za-z0-9_-]{43})"/)?.[1];
      assert.ok(challenge, start.body);
      const ticket = code();
      tickets.set(ticket, { id: externalId, name, challenge });
      const exchanged = await app.inject({ method: 'POST', url: '/auth/fastkore/exchange',
        headers: { ...headers, cookie: prep, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ version: '1', installation_id: id, ticket, login_challenge: challenge }).toString(),
      });
      assert.equal(exchanged.statusCode, 303, exchanged.body);
      const responseCookies = exchanged.headers['set-cookie'];
      assert.ok(Array.isArray(responseCookies));
      const cookie = responseCookies.find(value => value.startsWith('__Host-bridge_session='))?.split(';')[0];
      assert.ok(cookie);
      const me = await req('GET', '/api/auth/me', cookie);
      assert.equal(me.statusCode, 200, me.body);
      return { user: me.json<{ user: User }>().user, cookie };
    };
  }

  return { options, request, pair };
}
