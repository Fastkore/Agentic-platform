export const executionProviders = ['codex', 'gemini', 'antigravity', 'glm', 'gigachat'] as const;
export type ExecutionProvider = typeof executionProviders[number];
export const gigaChatScopes = ['GIGACHAT_API_PERS', 'GIGACHAT_API_B2B', 'GIGACHAT_API_CORP'] as const;
export type GigaChatScope = typeof gigaChatScopes[number];
export interface ExecutionAccount {
  id: string;
  name: string;
  provider: ExecutionProvider;
  scope?: GigaChatScope;
  email?: string;
  signedIn: boolean;
  active: boolean;
  login?: { state: 'waiting' | 'complete' | 'error'; url?: string; code?: string; needsCode?: boolean; error?: string };
}
export interface ExecutionAccounts { accounts: ExecutionAccount[] }
export const executionConnected = (info?: { authentication: string } | null) =>
  info?.authentication === 'chatgpt' || info?.authentication === 'google' || info?.authentication === 'glm' || info?.authentication === 'gigachat';
// Undefined means "any provider": the active signed-in account executes the run.
export const providerForModel = (model?: string): ExecutionProvider | undefined =>
  !model ? undefined
    : model.startsWith('antigravity/') || model === 'antigravity-auto' ? 'antigravity'
    : model.startsWith('gemini/') || model.startsWith('gemini-') ? 'gemini'
    : model.startsWith('glm/') || model.startsWith('glm-') ? 'glm'
    : model.startsWith('gigachat/') || /^gigachat(?:$|[-:])/i.test(model) ? 'gigachat'
    : 'codex';
