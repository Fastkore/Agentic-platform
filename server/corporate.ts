import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { agentToolIds } from '../shared/agent-tools.js';
import type { AgentProfile, AgentSummary, Corporate, Dataset, Project, ProjectAgentPolicy, State, User, WorkRole } from '../shared/types.js';
import { BridgeError, Store } from './store.js';

export const operationIds = ['chat', 'estimate', 'technology', 'accounting'] as const;
export function initializeCorporate(state: State): Corporate {
  if (!state.corporate) state.corporate = {
    roles: [{ id: 'employee', name: 'Сотрудник', enabled: true, profileIds: ['universal'], operationIds: ['chat'], readDatasetIds: [], instructions: '', revision: 1 }],
    profiles: [
      { id: 'universal', name: 'Универсальный помощник', description: 'Обсуждение файлов и вопросов проекта', instructions: '', enabled: true, model: '', reasoningEffort: 'high', operationIds: ['chat'], datasetIds: [], skillIds: [], allowWrite: false, outputMode: 'chat', revision: 1 },
      ...[['estimator', 'Оценщик', 'Подготовка расчёта и коммерческого предложения', 'estimate'], ['technologist', 'Технолог', 'Подготовка технологии изготовления', 'technology'], ['accountant', 'Бухгалтер', 'Работа с согласованными бухгалтерскими операциями', 'accounting']].map(([id, name, description, operation]): AgentProfile => ({ id, name, description, instructions: '', enabled: false, model: '', reasoningEffort: 'high', operationIds: [operation], datasetIds: [], skillIds: [], allowWrite: false, outputMode: 'restricted', revision: 1 }))
    ], datasets: []
  };
  for (const user of state.security?.users ?? []) user.roleId ??= 'employee';
  for (const project of state.projects) for (const chat of project.chats) chat.agentProfileId ??= 'universal';
  return state.corporate;
}
/** Business permissions are checked outside prompts and shared by UI and API. */
export class CorporateAccess {
  readonly data: Corporate;
  constructor(readonly store: Store, private readonly isolated: boolean) { this.data = initializeCorporate(store.state); }
  ensureSsoPendingRole() {
    const existing = this.data.roles.find(role => role.id === 'sso_pending');
    if (existing?.enabled && !existing.profileIds.length && !existing.operationIds.length && !existing.readDatasetIds.length && !existing.instructions) return;
    const pending: WorkRole = {
      id: 'sso_pending', name: 'Fastkore · ожидает назначения', enabled: true,
      profileIds: [], operationIds: [], readDatasetIds: [], instructions: '', revision: (existing?.revision ?? 0) + 1,
    };
    if (existing) Object.assign(existing, pending); else this.data.roles.push(pending);
  }
  role(user: User) { return this.data.roles.find(r => r.id === (user.roleId ?? 'employee') && r.enabled); }
  canUse(user: User, profile: AgentProfile) {
    const role = this.role(user);
    return profile.enabled && (user.role === 'admin' || !!role && role.profileIds.includes(profile.id) && profile.operationIds.some(id => role.operationIds.includes(id)));
  }
  profile(user: User | undefined, id = 'universal', project?: Project): AgentProfile {
    const profile = this.data.profiles.find(p => p.id === id);
    if (!profile || user && !this.canUse(user, profile)) throw new BridgeError('Профиль недоступен.', 403);
    if (!profile.enabled) throw new BridgeError('Профиль выключен.', 403);
    if (project?.agentPolicy && !this.connection(profile, project)) throw new BridgeError('Агент не подключён к этому проекту.', 403);
    const reason = this.unavailable(profile, project);
    if (reason) throw new BridgeError(reason, 409);
    return profile;
  }
  unavailable(profile: AgentProfile, project?: Project) {
    // A shared OS identity cannot promise that a "normal" chat cannot read another source.
    if (this.data.datasets.some(d => d.classification === 'restricted')) return 'На сервере зарегистрированы закрытые источники. Запуски приостановлены до проверки изоляции на Linux.';
    if (profile.outputMode === 'restricted' || profile.operationIds.some(id => id !== 'chat') || profile.datasetIds.length) return 'Профиль ожидает проверки изоляции и выдачи результатов на Linux. Запуск пока закрыт.';
    if (profile.skillIds.length) return 'Профиль ожидает установки и проверки утверждённых Skills в среде исполнения.';
    if (!this.isolated && (project?.agentPolicy || profile.toolIds !== undefined)) return 'Для применения разрешений на инструменты нужен отдельный исполнитель Codex.';
    return undefined;
  }
  connection(profile: AgentProfile, project?: Project) {
    return project?.agentPolicy?.connections.find(connection => connection.profileId === profile.id);
  }
  tools(profile: AgentProfile, project?: Project) {
    const tools = profile.toolIds ?? agentToolIds;
    const policy = project?.agentPolicy;
    if (!policy) return tools;
    const connection = this.connection(profile, project);
    return tools.filter(id => connection?.toolIds.includes(id));
  }
  list(user: User, project?: Project): AgentSummary[] {
    return this.data.profiles.filter(profile => this.canUse(user, profile) && (!project?.agentPolicy || this.connection(profile, project)))
      .map(profile => {
        const unavailableReason = this.unavailable(profile, project);
        return { id: profile.id, name: profile.name, description: profile.description, model: profile.model, allowWrite: profile.allowWrite,
          toolIds: this.tools(profile, project), available: !unavailableReason, unavailableReason };
      });
  }
  defaultProjectPolicy(includeFastkore: boolean): ProjectAgentPolicy {
    return {
      revision: includeFastkore ? 0 : 1,
      connections: this.data.profiles.filter(profile => profile.enabled).map(profile => ({
        profileId: profile.id, fileIds: null, toolIds: this.tools(profile).filter(id => includeFastkore || id !== 'fastkore'),
      })),
    };
  }
  saveProjectPolicy(project: Project, input: ProjectAgentPolicy, authorize: () => User) {
    return this.store.changeAccess(draft => {
      const actor = authorize();
      this.admin(actor);
      if ((project.agentPolicy?.revision ?? 0) !== input.revision) throw new BridgeError('Подключения изменились. Откройте настройки проекта заново.', 409);
      const knownProfiles = new Set(this.data.profiles.map(profile => profile.id));
      const library = new Set(project.attachments.filter(file => file.libraryUploadedAt).map(file => file.id));
      const seen = new Set<string>();
      for (const connection of input.connections) {
        if (!knownProfiles.has(connection.profileId) || seen.has(connection.profileId)) throw new BridgeError('Выберите существующих агентов без повторов.');
        if (connection.fileIds?.some(id => !library.has(id))) throw new BridgeError('Файл недоступен в библиотеке проекта.');
        seen.add(connection.profileId);
      }
      const policy = { revision: input.revision + 1, connections: input.connections };
      draft.projectAgentPolicies = new Map([[project.id, policy]]);
      draft.security?.audit.unshift({ id: randomUUID(), actorId: actor.id, action: 'project.agents', targetId: project.id, createdAt: new Date().toISOString() });
      draft.security?.audit.splice(1000);
      return policy;
    });
  }
  scope(user: User | undefined, profile: AgentProfile, project: Project) {
    const role = user && this.role(user);
    return createHash('sha256').update(JSON.stringify({ profile: profile.id, revision: profile.revision, projectId: project.id, role: role?.id,
      roleRevision: role?.revision, actor: user?.id, projectRevision: project.agentPolicy?.revision })).digest('hex');
  }
  instructions(user: User | undefined, profile: AgentProfile) {
    const role = user && this.role(user)?.instructions;
    return [role && 'Инструкции рабочей роли\n' + role,
      profile.instructions && 'Инструкции специалиста\n' + profile.instructions].filter(Boolean).join('\n\n');
  }
  private admin(actor: User) { if (actor.role !== 'admin' || actor.disabled) throw new BridgeError('Доступно только руководителю.', 403); }
  private audit(actor: User, action: string, id: string) { this.store.state.security?.audit.unshift({ id: randomUUID(), actorId: actor.id, action, targetId: id, createdAt: new Date().toISOString() }); this.store.state.security?.audit.splice(1000); }
  async saveRole(actor: User, input: Omit<WorkRole, 'revision'> & { revision?: number }) {
    if (input.id === 'sso_pending') throw new BridgeError('Служебная роль Fastkore не редактируется.');
    this.admin(actor);
    if (input.profileIds.some(id => !this.data.profiles.some(p => p.id === id)) || input.operationIds.some(id => !operationIds.includes(id as typeof operationIds[number])) || input.readDatasetIds.some(id => !this.data.datasets.some(d => d.id === id))) throw new BridgeError('Выберите существующие профили, операции и источники.');
    const old = this.data.roles.find(r => r.id === input.id); if (old && old.revision !== input.revision) throw new BridgeError('Роль изменена. Обновите настройки.', 409);
    const value: WorkRole = { ...input, name: input.name.trim(), revision: (old?.revision ?? 0) + 1 };
    if (!value.name) throw new BridgeError('Укажите название роли.');
    if (old) Object.assign(old, value); else this.data.roles.push(value);
    this.audit(actor, 'role.update', value.id); await this.store.save(); return value;
  }
  async saveProfile(actor: User, input: Omit<AgentProfile, 'revision'> & { revision?: number }) {
    this.admin(actor);
    if (input.operationIds.some(id => !operationIds.includes(id as typeof operationIds[number])) || input.datasetIds.some(id => !this.data.datasets.some(d => d.id === id))) throw new BridgeError('Выберите существующие операции и источники.');
    if (input.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(input.model)) throw new BridgeError('Некорректная модель.');
    const old = this.data.profiles.find(p => p.id === input.id); if (old && old.revision !== input.revision) throw new BridgeError('Профиль изменён. Обновите настройки.', 409);
    if (this.store.state.runs.some(r => r.agentProfileId === input.id && ['queued', 'running'].includes(r.status))) throw new BridgeError('Дождитесь завершения заданий профиля.', 409);
    const value: AgentProfile = { ...input, name: input.name.trim(), revision: (old?.revision ?? 0) + 1, toolIds: input.toolIds ?? old?.toolIds };
    if (!value.name || !value.operationIds.length) throw new BridgeError('Укажите название и хотя бы одну операцию.');
    if (old) Object.assign(old, value); else this.data.profiles.push(value);
    this.audit(actor, 'profile.update', value.id); await this.store.save(); return value;
  }
  async saveDataset(actor: User, input: Omit<Dataset, 'revision'> & { revision?: number }) {
    this.admin(actor);
    if (!path.isAbsolute(input.directory)) throw new BridgeError('Укажите абсолютную папку на сервере.');
    const directory = await realpath(input.directory).catch(() => { throw new BridgeError('Папка источника недоступна.'); });
    if (!(await stat(directory)).isDirectory()) throw new BridgeError('Укажите папку источника.');
    if (input.projectIds.some(id => !this.store.state.projects.some(p => p.id === id))) throw new BridgeError('Проект не найден.');
    const old = this.data.datasets.find(d => d.id === input.id); if (old && old.revision !== input.revision) throw new BridgeError('Источник изменён. Обновите настройки.', 409);
    const value: Dataset = { ...input, directory, name: input.name.trim(), revision: (old?.revision ?? 0) + 1 };
    if (old) Object.assign(old, value); else this.data.datasets.push(value);
    this.audit(actor, 'dataset.update', value.id); await this.store.save(); return value;
  }
}
