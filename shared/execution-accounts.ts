export type ExecutionProvider = 'codex' | 'gemini' | 'antigravity';
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
  info?.authentication === 'chatgpt' || info?.authentication === 'google';
