import type { FastkoreNavigationTarget } from '../shared/types';

export interface WebViewHost {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export function webViewHost(): WebViewHost | undefined { return (window as Window & { chrome?: { webview?: WebViewHost } }).chrome?.webview; }

export function openFastkoreBrowser(url: string) {
  const host = webViewHost();
  if (!host) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const request_id = crypto.randomUUID();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      host.removeEventListener('message', receive);
      resolve(ok);
    };
    const receive = ({ data }: { data: unknown }) => {
      if (!data || typeof data !== 'object') return;
      const { type, version, request_id: id, ok } = data as Record<string, unknown>;
      if (type === 'fastkore.browser_result' && version === 1 && id === request_id && typeof ok === 'boolean') finish(ok);
    };
    const timer = setTimeout(() => finish(false), 1800);
    host.addEventListener('message', receive);
    try { host.postMessage({ type: 'fastkore.open_browser', version: 1, request_id, url }); }
    catch { finish(false); }
  });
}
export type Theme = 'light' | 'dark';
export function parseHostTheme(value: unknown): Theme | null {
  if (!value || typeof value !== 'object') return null;
  const { type, version, theme } = value as Record<string, unknown>;
  return type === 'fastkore.ui' && version === 1 && (theme === 'light' || theme === 'dark') ? theme : null;
}

const navigationErrors = {
  target_unavailable: 'В Fastkore эта карточка или плитка недоступна.',
  wrong_installation: 'Откройте чат в той установке Fastkore, к которой он привязан.',
  invalid_target: 'Fastkore не смог прочитать ссылку на карточку или плитку.',
  navigation_failed: 'Не удалось открыть карточку или плитку в Fastkore.',
  not_ready: 'Окно Fastkore ещё не готово. Повторите попытку.',
};

export function openFastkoreTarget(host: WebViewHost, target: FastkoreNavigationTarget, signal: AbortSignal) {
  return new Promise<string | null>(resolve => {
    if (signal.aborted) { resolve(null); return; }
    const request_id = crypto.randomUUID();
    const base = { version: 1, request_id, installation_id: target.installationId };
    const finish = (message: string | null) => {
      clearTimeout(timer);
      host.removeEventListener('message', receive);
      signal.removeEventListener('abort', abort);
      resolve(message);
    };
    const abort = () => finish(null);
    const receive = ({ data }: { data: unknown }) => {
      if (!data || typeof data !== 'object') return;
      const { type, version, request_id: id, ok, error } = data as Record<string, unknown>;
      if (type !== 'fastkore.navigation_result' || version !== 1 || id !== request_id || typeof ok !== 'boolean') return;
      finish(ok ? null : typeof error === 'string' && Object.hasOwn(navigationErrors, error)
        ? navigationErrors[error as keyof typeof navigationErrors] : navigationErrors.navigation_failed);
    };
    const timer = setTimeout(() => finish('Fastkore не ответил. Откройте цель вручную или обновите клиент.'), 5000);
    host.addEventListener('message', receive);
    signal.addEventListener('abort', abort, { once: true });
    try {
      host.postMessage('entityUri' in target ? { ...base, type: 'fastkore.open_entity', entity_uri: target.entityUri }
        : { ...base, type: 'fastkore.open_tile', tile_id: target.tileId });
    } catch { finish(navigationErrors.navigation_failed); }
  });
}
