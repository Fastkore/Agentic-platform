import type { FastkoreContext } from './fastkore-context.js';
import type { AgentToolId } from './agent-tools.js';
import type { ChatVisual } from './chat-visuals.js';
import type { ExecutionProvider } from './execution-accounts.js';

export type FileStorageProvider = 'local' | 's3';
export interface FileStorageStatus { provider: FileStorageProvider; s3Configured: boolean }
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export const maxExecutionConcurrency = 32;
export interface Settings { cliPath: string; allowWrite: boolean; includePreviews: boolean; model: string; reasoningEffort?: ReasoningEffort; dictationEnabled?: boolean; agentInstructions?: string; fileStorageProvider?: FileStorageProvider; executionConcurrency?: number }
export type DictationModelId = 'turbo' | 'quality';
export interface DictationModels {
  active: DictationModelId | null;
  loading: DictationModelId | null;
  downloading: DictationModelId | null;
  error: string | null;
  models: { id: DictationModelId; name: string; installed: boolean }[];
}
export interface ModelOption { id: string; name: string; description: string; isDefault: boolean }
export interface ModelCatalog { models: ModelOption[]; fetchedAt: string; source: ExecutionProvider | 'combined' }
export interface LimitWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null; label?: string }
export interface CodexLimits { buckets: { name: string; windows: LimitWindow[]; modelIds?: string[] }[]; resetsAvailable: number | null; provider?: ExecutionProvider; unavailableReason?: string }
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface TokenActivityDay { date: string; tokens: number }
export interface TokenActivityReport {
  total: TokenActivityDay[];
  users: (Pick<User, 'id' | 'name' | 'disabled'> & { days: TokenActivityDay[] })[];
  unattributed: TokenActivityDay[];
}
export type RunStatus = 'queued' | 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
export interface ProjectFile { id: string; name: string; size: number; uploadedAt: string }
export interface Attachment { id: string; name: string; path?: string; storage?: 's3'; size: number; ownerId?: string; libraryUploadedAt?: string; uploadedAt?: string }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; status: RunStatus; createdAt: string; attachments: Attachment[]; visuals?: ChatVisual[]; instructionSave?: 'saved' | 'already-saved' | 'not-saved'; usage?: Usage; runId?: string; model?: string; authorId?: string; authorName?: string; fileScope?: string; freecadSourceId?: string; libraryHistory?: string; historyScope?: string; renewalScope?: string; requestScope?: string; specialistName?: string; consultedSpecialists?: string[] }
export interface ErpContext { installationId: string; entityType: string; entityId: string }
export interface FastkoreChatBinding { installationId: string; externalUserId?: string; key: string; view: FastkoreContext['view']; entitySetId?: string; entityId?: string; entityName?: string; contextName?: string; entityUri?: string; tileId?: string; tileName?: string }
export type FastkoreNavigationTarget = { installationId: string } & ({ entityUri: string } | { tileId: string; tileName?: string });
export type ChatView = Chat & { fastkoreNavigation?: FastkoreNavigationTarget };
export interface ExternalIdentity { installationId: string; externalUserId: string; userId: string }
export const assistantProjectId = '__fastis__';
export const assistantName = 'Финист';
export interface AssistantSettings { enabled: boolean; instructions?: string; model?: string; reasoningEffort?: ReasoningEffort; revision: number }
export interface AssistantState { chats: Chat[]; attachments: Attachment[]; settings?: AssistantSettings }
export interface Chat { verifiedOpeningRunId?: string; storedFiles?: Attachment[]; reasoningEffort?: ReasoningEffort; id: string; title: string; titleCustomized?: true; sessionId?: string; sessionScope?: string; sessionProjectInstructionsHash?: string; sessionProvider?: CliInfo['provider']; historyReplayPending?: true; legacyHistory?: { lastAnswerId: string; scope: string; turns: number }; cliWorkspaceProjectId?: string; consultantIds?: string[]; knowledgeRevision?: string; specialistSessions?: Record<string, Pick<Chat, 'sessionId' | 'sessionScope' | 'knowledgeRevision'>>; updatedAt: string; archivedAt?: string; messages: Message[]; lastCompletedReplyId?: string; model?: string; agentProfileId?: string; erpContext?: ErpContext; fastkoreBinding?: FastkoreChatBinding; fastkoreHistory?: { binding: FastkoreChatBinding; turns: number } | null; linkedToFastkore?: true; assistantInstallationId?: string; assistantExternalUserId?: string; ownerId?: string; ownerName?: string; visibility?: 'private' | 'project' }
export interface ProjectAgentConnection { profileId: string; toolIds: AgentToolId[]; fileIds: string[] | null }
export interface ProjectAgentPolicy { revision: number; connections: ProjectAgentConnection[] }
export type ProjectChatDefaults = Pick<AgentProfile, 'instructions' | 'instructionFiles' | 'model' | 'reasoningEffort' | 'revision'>;
export interface ProjectAgentSettings {
  chatDefaults?: ProjectChatDefaults;
  policy: ProjectAgentPolicy;
  profiles: Pick<AgentSummary, 'id' | 'name' | 'description' | 'toolIds' | 'unavailableReason'>[];
  files: ProjectFile[];
  isolated: boolean;
}
export interface ProjectRole { installationId: string; roleId: string }
export interface ProjectRolePolicy { revision: number; roles: ProjectRole[] }
export interface ProjectRoleLabel extends ProjectRole { name: string; installationName: string }
export interface ProjectRoleSettings extends ProjectRolePolicy { available: ProjectRoleLabel[] }
export const maxProjectInstructions = 2000;
export interface Project { id: string; name: string; instructions?: string; directory: string; chats: Chat[]; attachments: Attachment[]; rolePolicy?: ProjectRolePolicy; agentPolicy?: ProjectAgentPolicy; chatDefaults?: ProjectChatDefaults; chatTools?: AgentToolId[]; chatAllowWrite?: boolean; legacyChatFileIds?: string[] | null; revokeRetiredChatGrants?: true; deletedAt?: string }
export type RunToolKind = 'cli' | 'mcp' | 'internet' | 'knowledge' | 'specialist' | 'other';
export interface RunTiming {
  queueMs: number;
  connectionMs?: number;
  erpSetupMs?: number;
  mcpSetupMs?: number;
  cliSetupMs?: number;
  preparationMs?: number;
  totalMs?: number;
  executorMs?: number;
  sessionReadyMs?: number;
  firstTextMs?: number;
  longestExecutorGapMs?: number;
  toolWallMs?: number;
  outsideToolsMs?: number;
  erpToolWallMs?: number;
  finalizeMs?: number;
  tools: Partial<Record<RunToolKind, { calls: number; totalMs: number; maxMs: number; unfinished: number }>>;
}
export interface RunToolContext { operation?: string; scope?: 'current' | 'erp'; selection?: true; pageSize?: number; continuation?: true }
export interface Run { reasoningEffort?: ReasoningEffort; id: string; projectId?: string; chatId?: string; status: RunStatus; progress: string; tool?: string; toolContext?: RunToolContext; canSteer?: boolean; steeringTo?: string; createdAt: string; startedAt?: string; completedAt?: string; response?: string; error?: string; usage?: Usage; timing?: RunTiming; usageOnly?: true; clientRequestId?: string; requestHash?: string; model?: string; executionProvider?: CliInfo['provider']; ownerId?: string; agentProfileId?: string; profileRevision?: number }
export interface QueuedRun extends Run { queuedText?: string; queuedFiles?: number }
/** Trusted queue input. Never return this record from HTTP handlers. */
export interface Job { runId: string; kind: 'chat' | 'subscription'; text: string; attachmentIds: string[]; authorId?: string; credentialId?: string; scope?: string; fastkoreContext?: FastkoreContext; recommendedSpecialistId?: string; requiredSpecialistId?: string; specialistName?: string; specialistScope?: string; fileWrite?: boolean }
export interface User { id: string; username: string; name: string; role: 'admin' | 'employee'; roleId?: string; disabled: boolean }
export const interfaceScales = [60, 70, 80, 90, 100, 110] as const;
export type InterfaceScale = typeof interfaceScales[number];
export interface WorkRole { id: string; name: string; enabled: boolean; profileIds: string[]; operationIds: string[]; readDatasetIds: string[]; instructions: string; revision: number }
export const specialistIcons = ['bot', 'message', 'calculator', 'settings', 'database', 'chart', 'file', 'search'] as const;
export type SpecialistIcon = typeof specialistIcons[number];
export interface SpecialistInstructionFile { name: string; text: string }
export const specialistFileLimits = { count: 5, characters: 6_000 };
export interface AgentProfile { id: string; name: string; description: string; instructions: string; enabled: boolean; autoConnect?: boolean; model: string; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'; operationIds: string[]; datasetIds: string[]; skillIds: string[]; allowWrite: boolean; revision: number; toolIds?: AgentToolId[]; icon?: SpecialistIcon; instructionFiles?: SpecialistInstructionFile[] }
export interface Dataset { id: string; name: string; directory: string; projectIds: string[]; classification: 'shared' | 'restricted'; revision: number }
export interface Corporate { roles: WorkRole[]; profiles: AgentProfile[]; datasets: Dataset[] }
export interface AgentSummary { id: string; name: string; description: string; available: boolean; unavailableReason?: string; closedAnalysis?: boolean; reasoningEffort?: ReasoningEffort; model: string; allowWrite?: boolean; toolIds: AgentToolId[] }
export interface UserRecord extends User { passwordHash: string; createdAt: string; deletedAt?: string; interfaceScale?: InterfaceScale; pinnedChatIds?: string[]; readChatReplies?: Record<string, string> }
export interface StoredErpDelegation { sealedGrant: string; expiresAt: number; revision: string }
export interface FastkoreRole { id: string; name: string }
export interface FastkoreRoleRecord extends FastkoreRole { installationId: string; lastSeenAt: string }
export interface FastkoreRoleSnapshot { installationId: string; externalUserId: string; roles?: FastkoreRole[]; updatedAt: string }
export interface FastkoreRolePermissions { mcp: boolean; cli: boolean; fileWrite?: boolean; readOnly?: boolean; createProjects?: boolean; assistant?: boolean; webSearch?: boolean; webRead?: boolean; webRequests?: boolean; revision: number }
export interface FastkoreRoleSummary extends FastkoreRoleRecord { installationName: string; userCount: number; permissions: FastkoreRolePermissions }
export interface TeamUser extends User {
  erpRoles: { installationId: string; roles?: FastkoreRole[] }[];
  projects: { id: string; name: string }[];
}
export interface Credential { id: string; userId: string; kind: 'session' | 'api'; hash: string; name: string; createdAt: string; expiresAt?: string; source?: 'local' | 'fastkore'; installationId?: string; externalUserId?: string; externalDisplayName?: string; externalRoles?: FastkoreRole[]; erpDelegation?: StoredErpDelegation; erpDelegationRevoked?: true; erpDelegationLoss?: ErpDelegationLoss; browserParentId?: string }
export type ErpDelegationLoss = 'expired' | 'binding_changed' | 'grant_unreadable' | 'mcp_token_denied' | 'cli_ticket_denied';
export type ErpSessionEnd = 'session_removed' | 'session_expired' | 'logout' | 'login_rotation' | 'identity_link' | 'installation_change' | 'account_change';
export interface AuditEvent {
  id: string; actorId: string; action: string; targetId: string; createdAt: string;
  details?: {
    sessionId?: string; installationId?: string; runId?: string; chatId?: string;
    delegationReason?: ErpDelegationLoss | ErpSessionEnd;
    revokeDelivery?: 'not_sent' | 'http_response' | 'no_response';
    scope?: 'current' | 'erp'; objectIds?: Record<string, string>; success?: boolean; status?: number; elapsedMs?: number;
    trustMs?: number; ticketMs?: number; ticketStatus?: number; cliRpcMs?: number; cliProcessMs?: number; exitCode?: number; responseChars?: number;
    mcpTokenMs?: number; mcpHttpMs?: number;
    mcpFailure?: 'http' | 'transport' | 'invalid_response' | 'rpc' | 'tool'; mcpErrorCode?: number;
    section?: 'fastkore' | 'company'; previousRevision?: string; revision?: string;
  };
}
export interface Security { users: UserRecord[]; credentials: Credential[]; audit: AuditEvent[]; pendingFastkoreAdminId?: string }
export interface FastkoreTlsInfo { origin: string; fingerprint: string; subject: string; expiresAt: string }
export interface FastkoreTlsTrust extends FastkoreTlsInfo { pem: string }
export interface FastkoreConnectionCheck { id: 'sso' | 'mcp' | 'cli'; ready: boolean; message: string }
export interface FastkoreInstallation { id: string; name: string; validateTicketUrl: string; mcpUrl?: string; mcpEnabled?: boolean; cliEnabled?: boolean; enabled: boolean; autoProvision: true; defaultRoleId: 'sso_pending'; sessionTtlSeconds: 1800; pairingStatus: 'manual' | 'unpaired' | 'pending' | 'paired'; pairedAt?: string; pairingRotationPending?: boolean; tlsFingerprint?: string; tlsConfirmationRequired?: boolean }
export interface FastkoreKeyIssue { installationId: string; connectionKey: string; erpKeyVerifier: string }
export interface FastkoreAuthentication { source: 'fastkore'; installationId: string; externalUserId: string; expiresAt: string; csrfToken: string; canChangePassword: false; roles?: FastkoreRole[]; canOpenBrowserSettings?: boolean; browserSettings?: boolean }
export interface FastkorePairingAttempt {
  codeHash: string; origin: string; revision: string; expiresAt: number; rotate: boolean;
  encryptedKey?: string; completed?: true;
}
export interface StoredFastkoreInstallation extends Omit<FastkoreInstallation, 'pairingStatus' | 'pairedAt' | 'pairingRotationPending' | 'tlsFingerprint' | 'tlsConfirmationRequired'> {
  revision: string; encryptedKey: string;
  pairing?: { required: boolean; binding?: { origin: string; pairedAt: string }; attempt?: FastkorePairingAttempt };
  tls?: { trust?: FastkoreTlsTrust };
}
export interface State { schemaVersion: 1; settings: Settings; projects: Project[]; assistant?: AssistantState; runs: Run[]; jobs?: Job[]; externalIdentities?: ExternalIdentity[]; sso?: { installations?: StoredFastkoreInstallation[]; roles?: FastkoreRoleRecord[]; roleSnapshots?: FastkoreRoleSnapshot[]; rolePermissions?: (FastkoreRolePermissions & { installationId: string; roleId: string })[] }; security?: Security; corporate?: Corporate }
export interface CliInfo { provider?: ExecutionProvider; accountId?: string; catalogRevision?: string; path: string; version: string; authentication: 'chatgpt' | 'google' | 'glm' | 'gigachat' | 'api-key' | 'signed-out' | 'unknown'; status: string }
export interface ProjectSummary { id: string; name: string; instructions?: string; directory: string; chatCount: number; roles?: ProjectRoleLabel[]; specialists?: string[]; libraries?: string[]; canRename?: boolean; chatCapabilities?: Omit<AgentSummary, 'id' | 'name' | 'description' | 'model'> & { model?: string } }
export interface ChatSummary { id: string; title: string; updatedAt: string; messageCount: number; ownerId?: string; ownerName?: string; visibility?: 'private' | 'project'; linkedToFastkore?: true; pinned?: boolean }
export const unassignedChatsLabel = 'Без проекта';
export const sharedChatWaitMessage = 'Другой участник ждёт ответа в этом чате. Вы сможете написать, когда его запросы завершатся.';
export interface UnassignedChatSummary extends ChatSummary { projectId: string }
export interface ArchivedChatSummary extends ChatSummary { projectId: string; projectName: string; archivedAt: string }
export interface RelatedChatSummary extends ChatSummary { projectId: string; projectName: string; parent?: true; contextMatches?: false; legacyContext?: true }
export interface ToolPermissions { erpRoles?: { cli: boolean; mcp: boolean }; reconnectReason?: string; cli: boolean; mcp: boolean; fileWrite?: boolean; cliUnavailableReason?: string; mcpUnavailableReason?: string; webSearch: boolean; webRead?: boolean }
export interface Status { version: string; activeRun: Run | null; activeRuns?: Run[]; queuedRuns: QueuedRun[]; unreadChatReplies?: Record<string, string>; busy: boolean; executionDisabled?: boolean; isolatedCodex?: boolean; workerFilesAvailable?: boolean; codexLimitsRevision?: number; user: User; setupRequired: boolean; canCreateProject?: boolean; assistantAvailable?: boolean; assistantModel?: string; assistantReasoningEffort?: ReasoningEffort; dictationAvailable?: boolean; dictationEnabled?: boolean; fastkoreToolsStatus?: 'unavailable' | 'ready' | 'reauth'; toolPermissions?: ToolPermissions; cli: CliInfo | null; settings: Settings; addresses: string[]; port: number; lan: boolean; storageWarning?: string; fileStorage?: FileStorageStatus }
