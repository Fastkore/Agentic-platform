import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { agentToolIds } from '../shared/agent-tools.js';
import { specialistFileLimits } from '../shared/types.js';
import type { AgentProfile, AgentSummary, Corporate, Dataset, Project, ProjectAgentPolicy, State, User, WorkRole } from '../shared/types.js';
import { BridgeError, Store } from './store.js';

export const operationIds = ['chat', 'technology', 'accounting'] as const;
// The existing library grant key belongs to the project chat after the profile is retired.
export const projectChatGrantId = 'universal';
const estimatorInstructions = 'Готовь расчёты стоимости и черновики коммерческих предложений по согласованным данным и материалам проекта. ' +
  'Указывай исходные данные, допущения и итог. Если данных недостаточно, задай уточняющий вопрос.';
function projectChatProfile(project?: Project): AgentProfile {
  return { id: projectChatGrantId, name: 'Чат проекта', description: '', instructions: '', enabled: true,
    toolIds: project?.chatTools,
    model: '', reasoningEffort: 'high', operationIds: ['chat'], datasetIds: [], skillIds: [], allowWrite: project?.chatAllowWrite === true, revision: 1, ...project?.chatDefaults };
}
function migrateEstimateOperation(corporate: Corporate) {
  const retired = 'estimate';
  const normalize = (ids: string[]) => [...new Set(ids.map(id => id === retired ? 'chat' : id))];
  const profiles = new Map(corporate.profiles.map(profile => [profile.id, profile.operationIds]));
  for (const role of corporate.roles) {
    const operations = normalize(role.operationIds);
    // Replacing an operation must not grant access to an additional profile.
    const profileIds = role.profileIds.filter(id => {
      const operationsBefore = profiles.get(id);
      return !operationsBefore || operationsBefore.some(operation => role.operationIds.includes(operation))
        || !normalize(operationsBefore).some(operation => operations.includes(operation));
    });
    if (!role.operationIds.includes(retired) && profileIds.length === role.profileIds.length) continue;
    role.operationIds = operations;
    role.profileIds = profileIds;
    role.revision++;
  }
  for (const profile of corporate.profiles) {
    if (!profile.operationIds.includes(retired)) continue;
    profile.operationIds = normalize(profile.operationIds);
    if (!profile.instructions.trim() && !profile.instructionFiles?.length) profile.instructions = estimatorInstructions;
    profile.revision++;
  }
}
export function initializeCorporate(state: State): Corporate {
  if (!state.corporate) state.corporate = {
    roles: [{ id: 'employee', name: 'Сотрудник', enabled: true, profileIds: [], operationIds: ['chat'], readDatasetIds: [], instructions: '', revision: 1 }],
    profiles: [
      { ...projectChatProfile(), id: 'estimator', name: 'Оценщик', description: 'Подготовка расчёта и коммерческого предложения', instructions: estimatorInstructions, enabled: false },
      ...[['technologist', 'Технолог', 'Подготовка технологии изготовления', 'technology'], ['accountant', 'Бухгалтер', 'Работа с согласованными бухгалтерскими операциями', 'accounting']].map(([id, name, description, operation]): AgentProfile => ({ id, name, description, instructions: '', enabled: false, model: '', reasoningEffort: 'high', operationIds: [operation], datasetIds: [], skillIds: [], allowWrite: false, revision: 1 }))
    ], datasets: []
  };
  migrateEstimateOperation(state.corporate);
  const retired = state.corporate.profiles.find(profile => profile.id === projectChatGrantId);
  state.corporate.profiles = state.corporate.profiles.filter(profile => profile !== retired);
  for (const role of state.corporate.roles) role.profileIds = role.profileIds.filter(id => id !== projectChatGrantId);
  for (const profile of state.corporate.profiles) {
    delete (profile as AgentProfile & { outputMode?: unknown }).outputMode;
    profile.autoConnect ??= false;
  }
  for (const user of state.security?.users ?? []) user.roleId ??= 'employee';
  for (const project of state.projects) {
    const previous = project.agentPolicy?.connections.find(connection => connection.profileId === projectChatGrantId);
    if (previous) {
      project.chatTools = agentToolIds.filter(id => id === 'fastkore' || (retired?.toolIds ?? agentToolIds).includes(id) && previous.toolIds.includes(id));
      project.agentPolicy!.connections = project.agentPolicy!.connections.filter(connection => connection !== previous);
    } else if (!project.agentPolicy && retired?.toolIds) {
      project.chatTools = agentToolIds.filter(id => id === 'fastkore' || retired.toolIds!.includes(id));
    }
    if (retired && (previous || !project.agentPolicy)) {
      if (retired.instructions || retired.instructionFiles?.length || retired.model) {
        project.chatDefaults ??= { instructions: retired.instructions, instructionFiles: structuredClone(retired.instructionFiles),
          model: retired.model, reasoningEffort: retired.reasoningEffort, revision: retired.revision };
      }
      if (retired.allowWrite) project.chatAllowWrite = true;
      if (((retired.toolIds ?? ['project-files']) as string[]).includes('project-files') &&
        (!project.agentPolicy || (previous?.toolIds as string[] | undefined)?.includes('project-files'))) {
        project.legacyChatFileIds = previous?.fileIds ?? null;
      }
    } else if (retired && project.agentPolicy) {
      project.revokeRetiredChatGrants = true;
    }
    for (const chat of project.chats) if (chat.agentProfileId === projectChatGrantId) {
      delete chat.agentProfileId;
      // The previous model session may contain the retired profile's instructions and sources.
      delete chat.sessionId;
      chat.historyReplayPending = true;
    }
  }
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
  private canUseOutsideProject(user: User, profile: AgentProfile) {
    const role = this.role(user);
    return profile.enabled && (user.role === 'admin' || !!role && role.profileIds.includes(profile.id) && profile.operationIds.some(id => role.operationIds.includes(id)));
  }
  profile(user: User | undefined, id?: string, project?: Project): AgentProfile {
    const projectChat = !id || id === projectChatGrantId;
    if (projectChat) {
      if (user?.disabled || !project && user && user.role !== 'admin' && !this.role(user)?.operationIds.includes('chat')) {
        throw new BridgeError('Чат недоступен.', 403);
      }
      const profile = projectChatProfile(project);
      const reason = this.unavailable(profile, project);
      if (reason) throw new BridgeError(reason, 409);
      return profile;
    }
    const profile = this.data.profiles.find(p => p.id === id);
    if (!profile || user?.disabled || !project && user && !this.canUseOutsideProject(user, profile)) throw new BridgeError('Профиль недоступен.', 403);
    if (!profile.enabled) throw new BridgeError('Профиль выключен.', 403);
    if (project?.agentPolicy && !this.connection(profile, project)) throw new BridgeError('Агент не подключён к этому проекту.', 403);
    const reason = this.unavailable(profile, project);
    if (reason) throw new BridgeError(reason, 409);
    return profile;
  }
  unavailable(profile: AgentProfile, project?: Project) {
    // A shared OS identity cannot promise that a "normal" chat cannot read another source.
    if (this.data.datasets.some(d => d.classification === 'restricted')) return 'На сервере зарегистрированы закрытые источники. Запуски приостановлены до проверки изоляции на Linux.';
    if (profile.operationIds.some(id => id !== 'chat')) return 'Профилю назначены операции, которые пока недоступны в чате.';
    if (profile.datasetIds.length) return 'Запуск профиля с назначенными библиотеками пока недоступен.';
    if (profile.skillIds.length) return 'Профиль ожидает установки и проверки утверждённых Skills в среде исполнения.';
    if (!this.isolated && (profile.id !== projectChatGrantId && project?.agentPolicy || profile.toolIds !== undefined)) return 'Для применения разрешений на инструменты нужен отдельный исполнитель Codex.';
    return undefined;
  }
  connection(profile: AgentProfile, project?: Project) {
    return project?.agentPolicy?.connections.find(connection => connection.profileId === profile.id);
  }
  // Project membership is checked at the entry point and again for running jobs.
  connectedProfiles(project: Project) {
    return this.data.profiles.filter(profile => profile.enabled && (!project.agentPolicy || this.connection(profile, project)));
  }
  tools(profile: AgentProfile, project?: Project) {
    const tools = profile.toolIds ?? agentToolIds;
    if (profile.id === projectChatGrantId) return agentToolIds.filter(id => tools.includes(id));
    const policy = project?.agentPolicy;
    const connection = this.connection(profile, project);
    return agentToolIds.filter(id => id === 'fastkore' || tools.includes(id) && (!policy || connection?.toolIds.includes(id)));
  }
  list(user: User, project?: Project): AgentSummary[] {
    if (user.disabled) return [];
    const profiles = project ? this.connectedProfiles(project) : this.data.profiles.filter(profile => this.canUseOutsideProject(user, profile));
    return profiles
      .map(profile => this.summary(profile, project));
  }
  summary(profile: AgentProfile, project?: Project): AgentSummary {
    const unavailableReason = this.unavailable(profile, project);
    return { id: profile.id, name: profile.name, description: profile.description, model: profile.model, reasoningEffort: profile.model ? profile.reasoningEffort : undefined, allowWrite: profile.allowWrite,
      toolIds: this.tools(profile, project), available: !unavailableReason, unavailableReason };
  }
  projectChat(project: Project) {
    const { available, unavailableReason, toolIds, allowWrite, model, reasoningEffort } = this.summary(projectChatProfile(project), project);
    return { available, unavailableReason, toolIds, allowWrite, model, reasoningEffort };
  }
  specialists(user: User | undefined, project: Project, mainProfileId: string) {
    if (!user || user.disabled) return [];
    return this.connectedProfiles(project).filter(profile => profile.id !== mainProfileId && !this.unavailable(profile, project));
  }
  defaultProjectPolicy(mode: 'new' | 'legacy'): ProjectAgentPolicy {
    const legacy = mode === 'legacy';
    return {
      revision: legacy ? 0 : 1,
      connections: this.data.profiles.filter(profile => profile.enabled && (legacy || profile.autoConnect)).map(profile => ({
        profileId: profile.id, fileIds: null, toolIds: this.tools(profile).filter(id => legacy || id !== 'fastkore'),
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
      profile.instructions && 'Инструкции агента\n' + profile.instructions,
      ...(profile.instructionFiles ?? []).map(file => 'Файл инструкций ' + JSON.stringify(file.name) + '\n' + file.text),
    ].filter(Boolean).join('\n\n');
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
    if (input.id === projectChatGrantId) throw new BridgeError('Этот идентификатор зарезервирован для чата проекта.');
    if (input.operationIds.some(id => !operationIds.includes(id as typeof operationIds[number])) || input.datasetIds.some(id => !this.data.datasets.some(d => d.id === id))) throw new BridgeError('Выберите существующие операции и источники.');
    if (input.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(input.model)) throw new BridgeError('Некорректная модель.');
    const old = this.data.profiles.find(p => p.id === input.id); if (old && old.revision !== input.revision) throw new BridgeError('Профиль изменён. Обновите настройки.', 409);
    if (this.store.state.runs.some(r => r.agentProfileId === input.id && ['queued', 'running'].includes(r.status))) throw new BridgeError('Дождитесь завершения заданий профиля.', 409);
    const instructionFiles = input.instructionFiles ?? old?.instructionFiles;
    if (instructionFiles && (instructionFiles.length > specialistFileLimits.count ||
      instructionFiles.reduce((size, file) => size + file.text.length, 0) > specialistFileLimits.characters ||
      instructionFiles.some(file => !/^[^/\\\x00-\x1f]+\.(md|txt)$/i.test(file.name) || !file.text.trim() || file.text.includes('\0')) ||
      new Set(instructionFiles.map(file => file.name.toLowerCase())).size !== instructionFiles.length)) {
      throw new BridgeError('Добавьте до пяти разных файлов .md или .txt общим объёмом до 6 000 символов.');
    }
    const value: AgentProfile = { ...input, name: input.name.trim(), description: input.description.trim(), revision: (old?.revision ?? 0) + 1,
      autoConnect: input.autoConnect ?? old?.autoConnect ?? false,
      toolIds: input.toolIds ?? old?.toolIds, icon: input.icon ?? old?.icon, instructionFiles };
    if (!value.name || !value.operationIds.length) throw new BridgeError('Укажите название и хотя бы одну операцию.');
    if (!value.description && old?.description !== '') throw new BridgeError('Кратко опишите, для каких задач подходит агент.');
    if (old) Object.assign(old, value); else this.data.profiles.push(value);
    this.audit(actor, 'profile.update', value.id); await this.store.save(); return value;
  }
  async saveDataset(actor: User, input: Omit<Dataset, 'revision'> & { revision?: number }) {
    this.admin(actor);
    if (!path.isAbsolute(input.directory)) throw new BridgeError('Укажите абсолютную папку на сервере.');
    const directory = await realpath(input.directory).catch(() => { throw new BridgeError('Папка источника недоступна.'); });
    if (!(await stat(directory)).isDirectory()) throw new BridgeError('Укажите папку источника.');
    if (input.projectIds.some(id => !this.store.state.projects.some(p => p.id === id && !p.deletedAt))) throw new BridgeError('Проект не найден.');
    const old = this.data.datasets.find(d => d.id === input.id); if (old && old.revision !== input.revision) throw new BridgeError('Источник изменён. Обновите настройки.', 409);
    const value: Dataset = { ...input, directory, name: input.name.trim(), revision: (old?.revision ?? 0) + 1 };
    if (old) Object.assign(old, value); else this.data.datasets.push(value);
    this.audit(actor, 'dataset.update', value.id); await this.store.save(); return value;
  }
}
