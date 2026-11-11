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
