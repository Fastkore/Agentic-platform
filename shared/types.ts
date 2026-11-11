export interface Settings { cliPath: string; allowWrite: boolean; includePreviews: boolean; model: string }
export interface ModelOption { id: string; name: string; description: string; isDefault: boolean }
export interface ModelCatalog { models: ModelOption[]; fetchedAt: string; source: 'codex' }
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export type RunStatus = 'queued' | 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
export interface Attachment { id: string; name: string; path: string; size: number; ownerId?: string }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; status: RunStatus; createdAt: string; attachments: Attachment[]; usage?: Usage; runId?: string; model?: string; authorId?: string; authorName?: string }
export interface ErpContext { installationId: string; entityType: string; entityId: string }
export interface ExternalIdentity { installationId: string; externalUserId: string; userId: string }
export interface Chat { id: string; title: string; sessionId?: string; sessionScope?: string; updatedAt: string; messages: Message[]; model?: string; agentProfileId?: string; erpContext?: ErpContext; ownerId?: string; ownerName?: string; visibility?: 'private' | 'project' }
export interface Project { id: string; name: string; directory: string; chats: Chat[]; attachments: Attachment[]; memberIds?: string[] }
export interface Run { id: string; projectId?: string; chatId?: string; status: RunStatus; progress: string; createdAt: string; startedAt?: string; completedAt?: string; response?: string; error?: string; usage?: Usage; clientRequestId?: string; requestHash?: string; model?: string; ownerId?: string; agentProfileId?: string; profileRevision?: number }
/** Trusted queue input. Never return this record from HTTP handlers. */
export interface Job { runId: string; kind: 'chat' | 'subscription'; text: string; attachmentIds: string[]; authorId?: string; credentialId?: string; scope?: string }
export interface User { id: string; username: string; name: string; role: 'admin' | 'employee'; roleId?: string; disabled: boolean }
export interface WorkRole { id: string; name: string; enabled: boolean; profileIds: string[]; operationIds: string[]; readDatasetIds: string[]; instructions: string; revision: number }
export interface AgentProfile { id: string; name: string; description: string; instructions: string; enabled: boolean; model: string; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'; operationIds: string[]; datasetIds: string[]; skillIds: string[]; allowWrite: boolean; outputMode: 'chat' | 'restricted'; revision: number }
export interface Dataset { id: string; name: string; directory: string; projectIds: string[]; classification: 'shared' | 'restricted'; revision: number }
export interface Corporate { roles: WorkRole[]; profiles: AgentProfile[]; datasets: Dataset[] }
export interface AgentSummary { id: string; name: string; description: string; available: boolean; unavailableReason?: string; model: string }
export interface UserRecord extends User { passwordHash: string; createdAt: string }
export interface Credential { id: string; userId: string; kind: 'session' | 'api'; hash: string; name: string; createdAt: string; expiresAt?: string; source?: 'local' | 'fastkore'; installationId?: string; externalUserId?: string }
export interface ApiKeyInfo { id: string; name: string; createdAt: string }
export interface AuditEvent { id: string; actorId: string; action: string; targetId: string; createdAt: string }
export interface Security { users: UserRecord[]; credentials: Credential[]; audit: AuditEvent[] }
export interface State { schemaVersion: 1; settings: Settings; projects: Project[]; runs: Run[]; jobs?: Job[]; externalIdentities?: ExternalIdentity[]; sso?: { disabledInstallationIds: string[] }; security?: Security; corporate?: Corporate }
export interface CliInfo { path: string; version: string; authentication: 'chatgpt' | 'api-key' | 'signed-out' | 'unknown'; status: string }
export interface ProjectSummary { id: string; name: string; directory: string; chatCount: number }
export interface ChatSummary { id: string; title: string; updatedAt: string; messageCount: number; ownerId?: string; ownerName?: string; visibility?: 'private' | 'project' }
export interface Status { version: string; activeRun: Run | null; queuedRuns: Run[]; busy: boolean; executionDisabled?: boolean; user: User; setupRequired: boolean; cli: CliInfo | null; settings: Settings; addresses: string[]; port: number; lan: boolean; storageWarning?: string }
