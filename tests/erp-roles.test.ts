import test from 'node:test';
import assert from 'node:assert/strict';
import type { Credential, State } from '../shared/types.js';
import { erpRoleCatalog, erpRolesForUser, observeErpRoles, restoreErpRoles, erpCredentialPermissions, erpRolePermissions } from '../server/erp-roles.js';

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

test('ERP role MCP and CLI permissions are scoped to installation/GUID and combine as grants', () => {
  const state = { sso: { rolePermissions: [
    { installationId: 'a', roleId: 'leader', mcp: false, cli: true, revision: 1 },
    { installationId: 'a', roleId: 'admin', mcp: true, cli: false, revision: 1 },
  ] } } as State;
  const credential = { source: 'fastkore', installationId: 'a', externalRoles: [{ id: 'leader', name: 'Руководитель' }] } as Credential;
  assert.deepEqual(erpCredentialPermissions(state, credential), { mcp: false, cli: true });
  credential.externalRoles!.push({ id: 'admin', name: 'Администратор' });
  assert.deepEqual(erpCredentialPermissions(state, credential), { mcp: true, cli: true });
  credential.installationId = 'b';
  assert.deepEqual(erpCredentialPermissions(state, credential), { mcp: true, cli: true });
  credential.installationId = 'a'; credential.externalRoles = [{ id: 'leader', name: 'Новое имя' }];
  observeErpRoles(state, 'a', 'user', credential.externalRoles, '2026-11-13T10:00:00Z');
  assert.equal(erpRoleCatalog(state)[0].permissions.mcp, false);
  state.sso!.roles = []; // Catalog removal must not silently reset an existing deny.
  assert.equal(erpRolePermissions(state, 'a', 'leader').mcp, false);
  credential.externalRoles = undefined;
  assert.deepEqual(erpCredentialPermissions(state, credential), { mcp: true, cli: true });
  credential.source = 'local';
  assert.deepEqual(erpCredentialPermissions(state, credential), { mcp: false, cli: false });
});
