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

export function parseHostScreenshotCapability(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object') return;
  const { type, version, capabilities } = value as Record<string, unknown>;
  if (type === 'fastkore.ui' && version === 1 && Array.isArray(capabilities)) return capabilities.includes('screenshot');
}

const screenshotErrors = {
  page_unavailable: 'Страница Fastkore недоступна для снимка.',
  capture_failed: 'Не удалось сделать скриншот.',
  busy: 'Fastkore уже делает скриншот. Повторите попытку.',
};
const maxScreenshotBytes = 20 * 1024 * 1024;

export function parseHostScreenshotResult(value: unknown, requestId: string): { file: File; preview: string } | { error: string } | undefined {
  if (!value || typeof value !== 'object') return;
  const { type, version, request_id, ok, mime_type, data_base64, error } = value as Record<string, unknown>;
  if (type !== 'fastkore.screenshot.result' || version !== 1 || request_id !== requestId) return;
  if (ok === false && typeof error === 'string' && Object.hasOwn(screenshotErrors, error)) {
    return { error: screenshotErrors[error as keyof typeof screenshotErrors] };
  }
  if (ok !== true || mime_type !== 'image/png' || typeof data_base64 !== 'string') {
    return { error: screenshotErrors.capture_failed };
  }
  const tooLarge = 'Скриншот превышает 20 МБ.';
  if (data_base64.length > 4 * Math.ceil(maxScreenshotBytes / 3)) return { error: tooLarge };
  if (/[^A-Za-z0-9+/=]/.test(data_base64)) return { error: screenshotErrors.capture_failed };
  try {
    const binary = atob(data_base64);
    if (binary.length > maxScreenshotBytes) return { error: tooLarge };
    if (!binary.startsWith('\x89PNG\r\n\x1a\n')) return { error: screenshotErrors.capture_failed };
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return { file: new File([bytes], 'Скриншот.png', { type: mime_type }), preview: `data:image/png;base64,${data_base64}` };
  } catch {
    return { error: screenshotErrors.capture_failed };
  }
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
