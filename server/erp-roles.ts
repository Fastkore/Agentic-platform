import type { Credential, FastkoreRole, FastkoreRoleSummary, Project, ProjectRoleLabel, State, TeamUser, User } from '../shared/types.js';

type RoleState = Pick<State, 'sso' | 'externalIdentities' | 'security'>;
const projectCreationRoles = new Set(['руководитель', 'системный администратор']);

export function canAccessProject(user: User, project: Project, credential?: Credential) {
  if (user.disabled) return false;
  if (user.role === 'admin') return true;
  return credential?.source === 'fastkore' && credential.userId === user.id &&
    projectAllowsRoles(project, credential.installationId, credential.externalRoles);
}

export function projectAllowsRoles(project: Project, installationId?: string, roles?: FastkoreRole[]) {
  return project.rolePolicy?.roles.some(role => role.installationId === installationId &&
    roles?.some(current => current.id === role.roleId)) ?? false;
}

export function canRenameProject(state: RoleState, user: User, project: Project, credential: Credential) {
  if (user.disabled) return false;
  if (user.role === 'admin') return true;
  const { installationId, externalRoles } = credential;
  if (credential.source !== 'fastkore' || credential.userId !== user.id || !installationId) return false;
  const roles = externalRoles?.filter(role => erpRolePermissions(state, installationId, role.id).renameProjects);
  return projectAllowsRoles(project, installationId, roles);
}

export function projectRoleOptions(state: RoleState): ProjectRoleLabel[] {
  const names = new Map(state.sso?.installations?.map(({ id, name }) => [id, name]));
  return (state.sso?.roles ?? []).map(({ id, name, installationId }) => ({
    roleId: id, name, installationId, installationName: names.get(installationId) ?? installationId,
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.installationName.localeCompare(b.installationName, 'ru'));
}

export function erpRolePermissions(state: RoleState, installationId: string, roleId: string) {
  const saved = state.sso?.rolePermissions?.find(item => item.installationId === installationId && item.roleId === roleId);
  const roleName = state.sso?.roles?.find(item => item.installationId === installationId && item.id === roleId)?.name;
  return { mcp: saved?.mcp ?? true, cli: saved?.cli ?? true, webRead: saved?.webRead ?? false,
    webSearch: saved?.webSearch ?? saved?.webRead ?? false,
    webRequests: saved?.webRequests ?? false, readOnly: saved?.readOnly ?? false,
    createProjects: saved?.createProjects ?? projectCreationRoles.has(roleName?.trim().toLocaleLowerCase('ru-RU') ?? ''),
    renameProjects: saved?.renameProjects ?? false,
    revision: saved?.revision ?? 0 };
}

export const erpReadOnlyMessage = 'Роль Fastkore разрешает только чтение. Эта операция заблокирована.';
export const fastkoreReadCommands = new Set([
  'auth info', 'data get', 'data query', 'schema entity-set list', 'schema entity-set show', 'schema property show',
]);

export function isErpReadOnly(state: RoleState, credential: Credential) {
  const { installationId, source, externalRoles } = credential;
  return source === 'fastkore' && !!installationId &&
    (externalRoles?.some(role => erpRolePermissions(state, installationId, role.id).readOnly) ?? false);
}

export function erpCredentialPermissions(state: RoleState, credential: Credential) {
  if (credential.source !== 'fastkore' || !credential.installationId) return { mcp: false, cli: false };
  const roles = credential.externalRoles;
  // Preserve existing access for older ERP servers and employees without role metadata.
  if (!roles?.length) return { mcp: true, cli: true };
  const permissions = roles.map(role => erpRolePermissions(state, credential.installationId!, role.id));
  return { mcp: permissions.some(role => role.mcp), cli: permissions.some(role => role.cli) };
}

export function internetCredentialPermissions(state: RoleState, credential: Credential) {
  const memberships = credential.source === 'fastkore' && credential.installationId
    ? [{ installationId: credential.installationId, roles: credential.externalRoles }]
    : erpRolesForUser(state, credential.userId);
  const policies = memberships.flatMap(item => (item.roles ?? []).map(role => erpRolePermissions(state, item.installationId, role.id)));
  return { search: policies.some(role => role.webSearch), read: policies.some(role => role.webRead),
    requests: policies.some(role => role.webRequests) };
}

export function observeErpRoles(state: RoleState, installationId: string, externalUserId: string,
  roles: FastkoreRole[] | undefined, updatedAt: string) {
  const sso = state.sso ??= {};
  const snapshots = sso.roleSnapshots ??= [];
  const previous = snapshots.find(item => item.installationId === installationId && item.externalUserId === externalUserId);
  if (previous && previous.updatedAt > updatedAt) return;
  const snapshot = { installationId, externalUserId, roles, updatedAt };
  if (previous) Object.assign(previous, snapshot);
  else snapshots.push(snapshot);
  const catalog = sso.roles ??= [];
  for (const role of roles ?? []) {
    const current = catalog.find(item => item.installationId === installationId && item.id === role.id);
    if (!current) catalog.push({ ...role, installationId, lastSeenAt: updatedAt });
    else if (current.lastSeenAt <= updatedAt) Object.assign(current, { name: role.name, lastSeenAt: updatedAt });
  }
}

export function restoreErpRoles(state: State) {
  const sessions = [...(state.security?.credentials ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const session of sessions) {
    if (session.source !== 'fastkore' || !session.installationId || !session.externalUserId) continue;
    if (state.sso?.roleSnapshots?.some(item => item.installationId === session.installationId && item.externalUserId === session.externalUserId)) continue;
    observeErpRoles(state, session.installationId, session.externalUserId, session.externalRoles, session.createdAt);
  }
}

export function erpRolesForUser(state: RoleState, userId: string): TeamUser['erpRoles'] {
  return (state.externalIdentities ?? []).filter(identity => identity.userId === userId).map(identity => ({
    installationId: identity.installationId,
    roles: state.sso?.roleSnapshots?.find(snapshot => snapshot.installationId === identity.installationId
      && snapshot.externalUserId === identity.externalUserId)?.roles?.map(role => ({
        ...role, name: state.sso?.roles?.find(current => current.installationId === identity.installationId && current.id === role.id)?.name ?? role.name,
      })),
  }));
}

export function erpRoleCatalog(state: RoleState): FastkoreRoleSummary[] {
  const identities = new Map(state.externalIdentities?.map(identity => [identity.installationId + '/' + identity.externalUserId, identity.userId]));
  const members = new Map<string, Set<string>>();
  for (const snapshot of state.sso?.roleSnapshots ?? []) {
    const userId = identities.get(snapshot.installationId + '/' + snapshot.externalUserId);
    if (!userId) continue;
    for (const role of snapshot.roles ?? []) {
      const key = snapshot.installationId + '/' + role.id;
      const users = members.get(key) ?? new Set<string>();
      users.add(userId);
      members.set(key, users);
    }
  }
  return (state.sso?.roles ?? []).map(role => {
    return { ...role, installationName: state.sso?.installations?.find(item => item.id === role.installationId)?.name ?? role.installationId,
      userCount: members.get(role.installationId + '/' + role.id)?.size ?? 0,
      permissions: erpRolePermissions(state, role.installationId, role.id) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
