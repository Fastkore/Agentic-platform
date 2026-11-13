export type ExecutionProvider = 'codex' | 'gemini' | 'antigravity' | 'glm';
export interface ExecutionAccount {
  id: string;
  name: string;
  provider: ExecutionProvider;
  email?: string;
  signedIn: boolean;
  active: boolean;
  login?: { state: 'waiting' | 'complete' | 'error'; url?: string; code?: string; needsCode?: boolean; error?: string };
}
export interface ExecutionAccounts { accounts: ExecutionAccount[] }
export const executionConnected = (info?: { authentication: string } | null) =>
  info?.authentication === 'chatgpt' || info?.authentication === 'google' || info?.authentication === 'glm';
// Undefined means "any provider": the active signed-in account executes the run.
export const providerForModel = (model?: string): ExecutionProvider | undefined =>
  !model ? undefined
    : model.startsWith('antigravity/') || model === 'antigravity-auto' ? 'antigravity'
    : model.startsWith('gemini/') || model.startsWith('gemini-') ? 'gemini'
    : model.startsWith('glm/') || model.startsWith('glm-') ? 'glm'
    : 'codex';
