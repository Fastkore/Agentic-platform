import { useEffect, useRef, useState } from 'react';
import { externalLabels, type ExternalFolder, type ExternalProvider, type ExternalSelection } from '../shared/library';
import type { Request } from './library-upload';

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
  const [availability, setAvailability] = useState<'checking' | 'ready' | 'missing' | 'failed'>('checking');
  const [check, setCheck] = useState(0);
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setAvailability('checking');
    request<{ configured: boolean }>('/api/library/external/status/' + provider, { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setAvailability(result.configured ? 'ready' : 'missing'); })
      .catch(() => { if (!abort.signal.aborted) setAvailability('failed'); });
    return () => abort.abort();
  }, [provider, request, check]);

  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const post = <T,>(url: string, body: unknown) => request<T>('/api/library/external/' + url, { method: 'POST', body: JSON.stringify(body) });
  async function browse(id: string, path: ExternalFolder[], signal?: AbortSignal) {
    setBusy(true); setError(''); setChosen(false); onSelect(undefined);
    try {
      const current = path.at(-1);
      const list = await post<ExternalFolder[]>('folders', { connection: id, parent: current?.id });
      if (signal?.aborted) return;
      setFolders(list); setTrail(path); setConnection(id);
    } catch (e) { if (!signal?.aborted) setError((e as Error).message); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function connect() {
    controller.current?.abort();
    const flow = new AbortController(); controller.current = flow;
    const popup = window.open('about:blank', '_blank');
    if (popup) {
      popup.opener = null;
      flow.signal.addEventListener('abort', () => popup.close(), { once: true });
    }
    setChosen(false); setBusy(true); setAuthUrl(''); setConnection(''); setTrail([]); setFolders([]); setError(''); onSelect(undefined);
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
          if (flow.signal.aborted) return;
          setConnection(state);
          await browse(state, [], flow.signal);
        } catch (e) { if (!flow.signal.aborted) { setError((e as Error).message); setBusy(false); } }
      };
      setAuthUrl(url);
      if (popup) popup.location.replace(url);
    } catch (e) { popup?.close(); if (!flow.signal.aborted) { setError((e as Error).message); setBusy(false); } }
  }
  const name = externalLabels[provider];
  const signIn = { google: 'Войти через Google', dropbox: 'Войти в Dropbox', yandex: 'Войти через Яндекс ID' }[provider];
  const current = trail.at(-1);
  function chooseFolder() {
    if (!current) return;
    onSelect({ connection, folder: current.id }, current.name);
    setChosen(true);
  }

  if (availability === 'checking') return <p className="help" role="status">Проверяем подключение к {name}…</p>;
  if (availability === 'failed') return <div className="library-form">
    <p role="alert">Не удалось проверить, доступен ли {name}.</p>
    <button className="secondary" type="button" onClick={() => setCheck(n => n + 1)}>Проверить ещё раз</button>
  </div>;
  if (availability === 'missing') return <div className="library-form">
    <strong>Подключение к {name} ещё не настроено</strong>
    <p className="help">Администратору платформы нужно включить этот диск. Затем здесь появится кнопка входа.</p>
    <details className="help"><summary>Инструкция для администратора</summary>
      <p>{setup[provider][0]} Зарегистрируйте адрес возврата для публичного адреса этой платформы: <code>{window.location.origin}/library-oauth.html</code>.</p>
      <p>Задайте на сервере <code>BRIDGE_PUBLIC_ORIGIN</code>, <code>BRIDGE_LIBRARY_{provider.toUpperCase()}_CLIENT_ID</code> и <code>BRIDGE_LIBRARY_{provider.toUpperCase()}_CLIENT_SECRET</code> и перезапустите приложение.</p>
      <a href={setup[provider][1]} target="_blank" rel="noreferrer">Настройки приложения {name}</a>
    </details>
    <button type="button" className="secondary" onClick={() => setCheck(n => n + 1)}>Проверить настройку</button>
  </div>;

  return <div className="library-form">
    {!connection && !authUrl && <>
      <strong>Подключите аккаунт</strong>
      <p className="help">В отдельном окне разрешите чтение файлов. После входа вы выберете папку для библиотеки.</p>
      <button type="button" className="primary" disabled={busy} onClick={() => void connect()}>{signIn}</button>
    </>}
    {authUrl && <>
      <strong role="status">Завершите вход в {name}</strong>
      <p className="help">Подтвердите доступ и вернитесь сюда для выбора папки.</p>
      <div className="settings-actions">
        <a href={authUrl} target="_blank" rel="noopener noreferrer">Открыть окно входа</a>
        <button type="button" className="secondary" onClick={() => {
          controller.current?.abort(); setAuthUrl(''); setBusy(false);
        }}>Отменить вход</button>
      </div>
    </>}
    {busy && !authUrl && <p className="help" role="status">{connection ? 'Загружаем папки…' : 'Подключаем аккаунт…'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {connection && <>
      <strong>{chosen ? 'Папка для библиотеки выбрана' : 'Выберите папку для библиотеки'}</strong>
      <p className="help">{[name, ...trail.map(folder => folder.name)].join(' / ')}</p>
      {chosen ? <>
        <p className="help" role="status">Агенты с доступом к библиотеке смогут искать и читать файлы в папке «{current?.name}» и её подпапках.</p>
        <button type="button" className="secondary" onClick={() => { setChosen(false); onSelect(undefined); }}>Изменить выбор</button>
      </> : <>
        {current && <div className="settings-actions">
          <button type="button" className="primary" disabled={busy} onClick={chooseFolder}>Выбрать «{current.name}»</button>
          <button type="button" className="secondary" disabled={busy}
            onClick={() => void browse(connection, trail.slice(0, -1), controller.current?.signal)}>На уровень выше</button>
        </div>}
        {error && <button type="button" className="secondary" disabled={busy}
          onClick={() => void browse(connection, trail, controller.current?.signal)}>Обновить список папок</button>}
        {folders.length > 0 && <ul className="settings-records">{folders.map(folder => <li key={folder.id}>
          <button type="button" className="library-dir" disabled={busy} aria-label={'Открыть папку «' + folder.name + '»'}
            onClick={() => void browse(connection, [...trail, folder], controller.current?.signal)}>{folder.name}</button>
        </li>)}</ul>}
        {!busy && !error && !folders.length && <p className="help">{current ? 'Вложенных папок нет. Вы можете выбрать эту папку.' : 'Нет доступных папок. Создайте папку на диске и обновите список.'}</p>}
        {!busy && !error && !folders.length && !current && <button className="secondary" type="button"
          onClick={() => void browse(connection, [], controller.current?.signal)}>Обновить список папок</button>}
      </>}
      <button type="button" className="secondary" disabled={busy} onClick={() => void connect()}>Сменить аккаунт</button>
    </>}
  </div>;
}
