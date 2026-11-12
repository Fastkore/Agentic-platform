import test from 'node:test';
import assert from 'node:assert/strict';
import type { Credential, State } from '../shared/types.js';
import { erpRoleCatalog, erpRolesForUser, observeErpRoles, restoreErpRoles } from '../server/erp-roles.js';

test('ERP role migration keeps the newest name across users and preserves catalog deletion on restart', () => {
  const session = (userId: string, createdAt: string, name: string) => ({
    id: userId, userId, kind: 'session', hash: '', name: '', createdAt, source: 'fastkore',
    installationId: 'erp-a', externalUserId: userId, externalRoles: [{ id: 'role', name }],
  } as Credential);
  const state = {
    security: { users: [], audit: [], credentials: [
      session('alice', '2026-11-12T12:00:00Z', 'Новое название'),
      session('boris', '2026-11-11T12:00:00Z', 'Старое название'),
    ] },
    externalIdentities: ['alice', 'boris'].map(userId => ({ installationId: 'erp-a', externalUserId: userId, userId })),
  } as State;
  restoreErpRoles(state);
  assert.equal(erpRoleCatalog(state)[0].name, 'Новое название');
  assert.equal(erpRoleCatalog(state)[0].userCount, 2);
  assert.equal(erpRolesForUser(state, 'boris')[0].roles![0].name, 'Новое название');
  state.sso!.roles = [];
  restoreErpRoles(state);
  assert.equal(erpRoleCatalog(state).length, 0);
  observeErpRoles(state, 'erp-a', 'alice', [{ id: 'role', name: 'Руководитель' }], '2026-11-12T13:00:00Z');
  assert.equal(erpRoleCatalog(state)[0].name, 'Руководитель');
});
