import type { FastkoreContext } from './fastkore-context.js';
import type { AgentToolId } from './agent-tools.js';

export type FileStorageProvider = 'local' | 's3';
export interface FileStorageStatus { provider: FileStorageProvider; s3Configured: boolean }
export interface Settings { cliPath: string; allowWrite: boolean; includePreviews: boolean; model: string; dictationEnabled?: boolean; agentInstructions?: string; fileStorageProvider?: FileStorageProvider }
export type DictationModelId = 'turbo' | 'quality';
export interface DictationModels {
  active: DictationModelId | null;
  loading: DictationModelId | null;
  downloading: DictationModelId | null;
  error: string | null;
  models: { id: DictationModelId; name: string; installed: boolean }[];
}
export interface ModelOption { id: string; name: string; description: string; isDefault: boolean }
export interface ModelCatalog { models: ModelOption[]; fetchedAt: string; source: 'codex' | 'gemini' }
export interface LimitWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface CodexLimits { buckets: { name: string; windows: LimitWindow[] }[]; resetsAvailable: number | null }
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
export interface Message { id: string; role: 'user' | 'assistant'; text: string; status: RunStatus; createdAt: string; attachments: Attachment[]; usage?: Usage; runId?: string; model?: string; authorId?: string; authorName?: string; fileScope?: string; specialistName?: string; consultedSpecialists?: string[] }
export interface ErpContext { installationId: string; entityType: string; entityId: string }
export interface FastkoreChatBinding { installationId: string; key: string; view: FastkoreContext['view']; entitySetId: string; entityId?: string }
export interface ExternalIdentity { installationId: string; externalUserId: string; userId: string }
export interface Chat { id: string; title: string; titleCustomized?: true; sessionId?: string; sessionScope?: string; knowledgeRevision?: string; specialistSessions?: Record<string, Pick<Chat, 'sessionId' | 'sessionScope' | 'knowledgeRevision'>>; updatedAt: string; archivedAt?: string; messages: Message[]; model?: string; agentProfileId?: string; erpContext?: ErpContext; fastkoreBinding?: FastkoreChatBinding; fastkoreHistory?: { binding: FastkoreChatBinding; turns: number } | null; linkedToFastkore?: true; ownerId?: string; ownerName?: string; visibility?: 'private' | 'project' }
export interface ProjectAgentConnection { profileId: string; toolIds: AgentToolId[]; fileIds: string[] | null }
export interface ProjectAgentPolicy { revision: number; connections: ProjectAgentConnection[] }
export interface ProjectAgentSettings {
  policy: ProjectAgentPolicy;
  profiles: Pick<AgentSummary, 'id' | 'name' | 'description' | 'toolIds' | 'unavailableReason'>[];
  files: ProjectFile[];
  isolated: boolean;
}
export interface Project { id: string; name: string; directory: string; chats: Chat[]; attachments: Attachment[]; memberIds?: string[]; agentPolicy?: ProjectAgentPolicy }
export interface Run { id: string; projectId?: string; chatId?: string; status: RunStatus; progress: string; createdAt: string; startedAt?: string; completedAt?: string; response?: string; error?: string; usage?: Usage; usageOnly?: true; clientRequestId?: string; requestHash?: string; model?: string; ownerId?: string; agentProfileId?: string; profileRevision?: number }
/** Trusted queue input. Never return this record from HTTP handlers. */
export interface Job { runId: string; kind: 'chat' | 'subscription'; text: string; attachmentIds: string[]; authorId?: string; credentialId?: string; scope?: string; fastkoreContext?: FastkoreContext; recommendedSpecialistId?: string; specialistName?: string; specialistScope?: string }
export interface User { id: string; username: string; name: string; role: 'admin' | 'employee'; roleId?: string; disabled: boolean }
export interface WorkRole { id: string; name: string; enabled: boolean; profileIds: string[]; operationIds: string[]; readDatasetIds: string[]; instructions: string; revision: number }
export const specialistIcons = ['bot', 'message', 'calculator', 'settings', 'database', 'chart', 'file', 'search'] as const;
export type SpecialistIcon = typeof specialistIcons[number];
export interface SpecialistInstructionFile { name: string; text: string }
export const specialistFileLimits = { count: 5, characters: 6_000 };
export interface AgentProfile { id: string; name: string; description: string; instructions: string; enabled: boolean; model: string; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'; operationIds: string[]; datasetIds: string[]; skillIds: string[]; allowWrite: boolean; outputMode: 'chat' | 'restricted'; revision: number; toolIds?: AgentToolId[]; icon?: SpecialistIcon; instructionFiles?: SpecialistInstructionFile[] }
export interface Dataset { id: string; name: string; directory: string; projectIds: string[]; classification: 'shared' | 'restricted'; revision: number }
export interface Corporate { roles: WorkRole[]; profiles: AgentProfile[]; datasets: Dataset[] }
export interface AgentSummary { id: string; name: string; description: string; available: boolean; unavailableReason?: string; model: string; allowWrite?: boolean; toolIds: AgentToolId[] }
export interface UserRecord extends User { passwordHash: string; createdAt: string }
export interface StoredErpDelegation { sealedGrant: string; expiresAt: number; revision: string }
export interface FastkoreRole { id: string; name: string }
export interface FastkoreRoleRecord extends FastkoreRole { installationId: string; lastSeenAt: string }
export interface FastkoreRoleSnapshot { installationId: string; externalUserId: string; roles?: FastkoreRole[]; updatedAt: string }
export interface FastkoreRoleSummary extends FastkoreRoleRecord { installationName: string; userCount: number }
export interface TeamUser extends User { erpRoles: { installationId: string; roles?: FastkoreRole[] }[] }
export interface Credential { id: string; userId: string; kind: 'session' | 'api'; hash: string; name: string; createdAt: string; expiresAt?: string; source?: 'local' | 'fastkore'; installationId?: string; externalUserId?: string; externalDisplayName?: string; externalRoles?: FastkoreRole[]; erpDelegation?: StoredErpDelegation; erpDelegationRevoked?: true }
export interface AuditEvent {
  id: string; actorId: string; action: string; targetId: string; createdAt: string;
  details?: {
    sessionId?: string; installationId?: string; runId?: string; chatId?: string;
    scope?: 'current' | 'erp'; objectIds?: Record<string, string>; success?: boolean; status?: number; elapsedMs?: number;
    section?: 'fastkore' | 'company'; previousRevision?: string; revision?: string;
  };
}
export interface Security { users: UserRecord[]; credentials: Credential[]; audit: AuditEvent[] }
export interface FastkoreTlsInfo { origin: string; fingerprint: string; subject: string; expiresAt: string }
export interface FastkoreTlsTrust extends FastkoreTlsInfo { pem: string }
export interface FastkoreInstallation { id: string; name: string; validateTicketUrl: string; mcpUrl?: string; mcpEnabled?: boolean; cliEnabled?: boolean; enabled: boolean; autoProvision: true; defaultRoleId: 'sso_pending'; sessionTtlSeconds: 1800; pairingStatus: 'manual' | 'unpaired' | 'pending' | 'paired'; pairedAt?: string; pairingRotationPending?: boolean; tlsFingerprint?: string; tlsConfirmationRequired?: boolean }
export interface FastkoreKeyIssue { installationId: string; connectionKey: string; erpKeyVerifier: string }
export interface FastkoreAuthentication { source: 'fastkore'; installationId: string; externalUserId: string; expiresAt: string; csrfToken: string; canChangePassword: false; roles?: FastkoreRole[] }
export interface FastkorePairingAttempt {
  codeHash: string; origin: string; revision: string; expiresAt: number; rotate: boolean;
  encryptedKey?: string; completed?: true;
}
export interface StoredFastkoreInstallation extends Omit<FastkoreInstallation, 'pairingStatus' | 'pairedAt' | 'pairingRotationPending' | 'tlsFingerprint' | 'tlsConfirmationRequired'> {
  revision: string; encryptedKey: string;
  pairing?: { required: boolean; binding?: { origin: string; pairedAt: string }; attempt?: FastkorePairingAttempt };
  tls?: { trust?: FastkoreTlsTrust };
}
export interface State { schemaVersion: 1; settings: Settings; projects: Project[]; runs: Run[]; jobs?: Job[]; externalIdentities?: ExternalIdentity[]; sso?: { installations?: StoredFastkoreInstallation[]; roles?: FastkoreRoleRecord[]; roleSnapshots?: FastkoreRoleSnapshot[] }; security?: Security; corporate?: Corporate }
export interface CliInfo { provider?: 'codex' | 'gemini'; accountId?: string; path: string; version: string; authentication: 'chatgpt' | 'google' | 'api-key' | 'signed-out' | 'unknown'; status: string }
export interface ProjectSummary { id: string; name: string; directory: string; chatCount: number }
export interface ChatSummary { id: string; title: string; updatedAt: string; messageCount: number; ownerId?: string; ownerName?: string; visibility?: 'private' | 'project'; linkedToFastkore?: true }
export interface ArchivedChatSummary extends ChatSummary { projectId: string; projectName: string; archivedAt: string }
export interface RelatedChatSummary extends ChatSummary { projectId: string; projectName: string }
export interface Status { version: string; activeRun: Run | null; queuedRuns: Run[]; busy: boolean; executionDisabled?: boolean; isolatedCodex?: boolean; workerFilesAvailable?: boolean; codexLimitsRevision?: number; user: User; setupRequired: boolean; canCreateProject?: boolean; dictationAvailable?: boolean; dictationEnabled?: boolean; fastkoreToolsStatus?: 'unavailable' | 'ready' | 'reauth'; cli: CliInfo | null; settings: Settings; addresses: string[]; port: number; lan: boolean; storageWarning?: string; fileStorage?: FileStorageStatus }
