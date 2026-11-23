import { useEffect, useRef, useState } from 'react';
import { externalLabels, type ExternalFolder, type ExternalProvider, type ExternalSelection } from '../shared/library';
import type { Request } from './library-upload';

const help = {
  google: ['Выберите аккаунт Google и разрешите просмотр файлов Google Диска.', 'Доступ приложений в аккаунте Google', 'https://myaccount.google.com/connections'],
  dropbox: ['Войдите в нужный аккаунт Dropbox и нажмите «Разрешить».', 'Подключение приложений к Dropbox', 'https://help.dropbox.com/integrations/app-center'],
  yandex: ['Войдите через Яндекс ID и разрешите чтение файлов Диска.', 'Управление доступом в Яндекс ID', 'https://yandex.ru/support/id/ru/profile.html'],
};
const setup = {
  google: ['Включите Google Drive API и создайте OAuth-клиент для веб-приложения с правом drive.readonly.', 'https://developers.google.com/identity/protocols/oauth2/web-server'],
  dropbox: ['Выберите Scoped access и Full Dropbox. В Permissions включите files.metadata.read и files.content.read.', 'https://www.dropbox.com/developers/apps'],
  yandex: ['Зарегистрируйте веб-приложение с правом чтения cloud_api:disk.read.', 'https://oauth.yandex.ru/'],
};
export function ExternalLibraryPicker({ provider, request, onSelect }: {
  provider: ExternalProvider; request: Request; onSelect: (selection?: ExternalSelection, folderName?: string) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [connection, setConnection] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [folders, setFolders] = useState<ExternalFolder[]>([]), [trail, setTrail] = useState<ExternalFolder[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const post = <T,>(url: string, body: unknown) => request<T>('/api/library/external/' + url, { method: 'POST', body: JSON.stringify(body) });
  async function browse(id: string, path: ExternalFolder[], signal?: AbortSignal) {
    setBusy(true); setError(''); onSelect(undefined);
    try {
      const current = path.at(-1);
      const list = await post<ExternalFolder[]>('folders', { connection: id, parent: current?.id });
      if (signal?.aborted) return;
      setFolders(list); setTrail(path); setConnection(id);
      onSelect(current ? { connection: id, folder: current.id } : undefined, current?.name);
    } catch (e) { if (!signal?.aborted) setError((e as Error).message); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function connect() {
    controller.current?.abort();
    const flow = new AbortController(); controller.current = flow;
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setBusy(true); setAuthUrl(''); setConnection(''); setTrail([]); setFolders([]); setError(''); onSelect(undefined);
    try {
      const { state, url } = await post<{state: string; url: string}>('authorize', { provider });
      if (flow.signal.aborted) { popup?.close(); return; }
      const channel = new BroadcastChannel('library-oauth-' + state);
      const timeout = window.setTimeout(() => {
        flow.abort(); setBusy(false); setAuthUrl(''); setError('Время входа истекло. Подключитесь ещё раз.');
      }, 15 * 60_000);
      const cleanup = () => { channel.close(); window.clearTimeout(timeout); };
      flow.signal.addEventListener('abort', cleanup, { once: true });
      channel.onmessage = async ({ data }) => {
        cleanup(); setAuthUrl('');
        try {
          if (!data?.code) throw new Error('Вход отменён. Можно повторить подключение.');
          await post('authorize/finish', { state, code: data.code });
          if (!flow.signal.aborted) await browse(state, [], flow.signal);
        } catch (e) { if (!flow.signal.aborted) { setError((e as Error).message); setBusy(false); } }
      };
      setAuthUrl(url);
      if (popup) popup.location.replace(url);
    } catch (e) { popup?.close(); if (!flow.signal.aborted) { setError((e as Error).message); setBusy(false); } }
  }
  const [instruction, title, url] = help[provider];
  return <div className="library-form">
    <div className="settings-actions">
      <button type="button" className="secondary" disabled={busy && !authUrl} onClick={() => void connect()}>{connection || authUrl ? 'Повторить подключение' : 'Подключить ' + externalLabels[provider]}</button>
      {authUrl && <a href={authUrl} target="_blank" rel="noopener noreferrer">Открыть окно входа</a>}
    </div>
    <p className="help">{instruction} Вернитесь сюда и откройте нужную папку. Материалы из неё и подпапок смогут читать назначенные агенты подключённых проектов. <a href={url} target="_blank" rel="noreferrer">{title}</a></p>
    <details className="help"><summary>Как настроить первое подключение на сервере</summary>
      <p>{setup[provider][0]} Укажите адрес возврата <code>{window.location.origin}/library-oauth.html</code>.</p>
      <p>Передайте серверу <code>BRIDGE_LIBRARY_{provider.toUpperCase()}_CLIENT_ID</code> и <code>BRIDGE_LIBRARY_{provider.toUpperCase()}_CLIENT_SECRET</code>,
        задайте публичный HTTPS-адрес в <code>BRIDGE_PUBLIC_ORIGIN</code> и перезапустите приложение. <a href={setup[provider][1]} target="_blank" rel="noreferrer">Настройки {externalLabels[provider]}</a></p>
    </details>
    {busy && <p className="help" role="status">{authUrl ? 'Ожидаем подтверждения в окне входа…' : 'Загружаем…'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {connection && <div>
      <p><strong>{trail.length ? 'Выбранная папка' : 'Выберите папку'}</strong> · {[externalLabels[provider], ...trail.map(f => f.name)].join(' / ')}</p>
      {trail.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => void browse(connection, trail.slice(0,-1), controller.current?.signal)}>На уровень выше</button>}
      {folders.length ? <ul className="settings-records">{folders.map(f => <li key={f.id}><button type="button" className="library-dir" disabled={busy}
        onClick={() => void browse(connection, [...trail, f], controller.current?.signal)}>{f.name}</button></li>)}</ul> : <p className="help">{trail.length ? 'Вложенных папок нет.' : 'В этом аккаунте нет доступных папок.'}</p>}
    </div>}
  </div>;
}
