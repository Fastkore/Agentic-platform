export interface HostContext { type: 'fastkore.context'; version: 1; entityType: string; entityId: string; suggestedAgent?: string }
export interface WebViewHost {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export function webViewHost(): WebViewHost | undefined { return (window as Window & { chrome?: { webview?: WebViewHost } }).chrome?.webview; }
export type Theme = 'light' | 'dark';
export function parseHostTheme(value: unknown): Theme | null {
  if (!value || typeof value !== 'object') return null;
  const { type, version, theme } = value as Record<string, unknown>;
  return type === 'fastkore.ui' && version === 1 && (theme === 'light' || theme === 'dark') ? theme : null;
}
/** Native host messages are data, never executable script or evidence of permission. */
export function parseHostContext(value: unknown): HostContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['type', 'version', 'entityType', 'entityId', 'suggestedAgent'].includes(k)) || v.type !== 'fastkore.context' || v.version !== 1
    || typeof v.entityType !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(v.entityType)
    || typeof v.entityId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(v.entityId)
    || v.suggestedAgent !== undefined && (typeof v.suggestedAgent !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(v.suggestedAgent))) return null;
  return v as unknown as HostContext;
}
