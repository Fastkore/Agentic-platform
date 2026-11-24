import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { externalLabels, type ExternalFolder, type ExternalProvider, type ExternalSelection } from '../shared/library';
import type { Request } from './library-upload';

const guides = {
  dropbox: { url: 'https://www.dropbox.com/developers/apps/create', id: 'App key', secret: 'App secret', location: 'Settings', redirect: 'OAuth 2 → Redirect URIs',
    steps: ['Создайте приложение с типом Scoped access и доступом Full Dropbox.'] },
  google: { url: 'https://console.cloud.google.com/apis/credentials', id: 'Client ID', secret: 'Client secret', location: 'Клиенты OAuth', redirect: 'Authorized redirect URIs',
    steps: ['Выберите проект в Google Cloud и включите Google Drive API.', 'В Google Auth Platform откройте Audience и выберите аудиторию. В Data Access добавьте разрешение https://www.googleapis.com/auth/drive.readonly. В режиме Testing добавьте свой аккаунт в Test users.', 'Откройте Clients → Create client и выберите Web application.'] },
  yandex: { url: 'https://oauth.yandex.ru/client/new/', id: 'ClientID', secret: 'Client secret', location: 'Карточка приложения', redirect: 'Redirect URI',
    steps: ['Выберите «Для доступа к API или отладки». Укажите название приложения и контактную почту.', 'В правах доступа найдите Яндекс Диск и выберите «Чтение всего Диска» (cloud_api:disk.read).'] },
};
function DropboxPermissions() {
  return <aside className="library-drive-permissions">
    <strong>Включите оба разрешения для чтения</strong>
    <p>Откройте своё приложение в <a className="library-provider-link" href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">кабинете Dropbox ↗</a>.
      На вкладке <b>Permissions</b> найдите раздел «Файлы и папки» (Files and folders) и поставьте две галочки.</p>
    <ul>
      <li><code>files.metadata.read</code> — видеть названия файлов и папок.</li>
      <li><code>files.content.read</code> — читать содержимое файлов.</li>
    </ul>
    <p>Нажмите <b>Submit</b> внизу страницы, чтобы сохранить разрешения.</p>
  </aside>;
}

export function driveSessionExpired(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 410;
}

export function ExternalLibraryPicker({ provider, request, onSelect, selectionConfirmed }: {
  selectionConfirmed?: boolean; provider: ExternalProvider; request: Request; onSelect: (selection?: ExternalSelection, folderName?: string) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [connection, setConnection] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [folders, setFolders] = useState<ExternalFolder[]>([]), [trail, setTrail] = useState<ExternalFolder[]>([]);
  const [availability, setAvailability] = useState<'checking' | 'ready' | 'missing' | 'failed'>('checking');
  const [check, setCheck] = useState(0);
  const [localChoice, setChosen] = useState(false);
  const chosen = selectionConfirmed ?? localChoice;
  const [step, setStep] = useState<'start' | 'register' | 'keys'>('start');
  const [redirect, setRedirect] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const finishLogin = useRef<((code?: string) => Promise<void>) | null>(null);
  const screenCode = provider === 'yandex' && redirect === 'https://oauth.yandex.ru/verification_code';
  const guide = guides[provider];
  useEffect(() => {
    const abort = new AbortController();
    setAvailability('checking');
    request<{ configured: boolean; redirectUri: string }>('/api/library/external/status/' + provider, { signal: abort.signal })
      .then(result => {
        if (abort.signal.aborted) return;
        setAvailability(result.configured ? 'ready' : 'missing');
        setRedirect(result.redirectUri);
      })
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
    } catch (e) {
      if (signal?.aborted) return;
      if (driveSessionExpired(e)) {
        setConnection(''); setFolders([]); setTrail([]);
        setCheck(n => n + 1);
      }
      setError((e as Error).message);
    }
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
    setCode(''); setChosen(false); setBusy(true); setAuthUrl(''); setConnection(''); setTrail([]); setFolders([]); setError(''); onSelect(undefined);
    try {
      const setup = availability === 'missing' ? { id: clientId.trim(), secret: secret.trim() } : undefined;
      const { state, url } = await post<{state: string; url: string}>('authorize', { provider, setup });
      if (flow.signal.aborted) { popup?.close(); return; }
      const channel = screenCode ? undefined : new BroadcastChannel('library-oauth-' + state);
      const timeout = window.setTimeout(() => {
        flow.abort(); setBusy(false); setAuthUrl(''); setError('Время входа истекло. Подключитесь ещё раз.');
      }, 15 * 60_000);
      const cleanup = () => { finishLogin.current = null; channel?.close(); window.clearTimeout(timeout); };
      flow.signal.addEventListener('abort', cleanup, { once: true });
      finishLogin.current = async confirmation => {
        cleanup(); setAuthUrl(''); setCode(''); popup?.close();
        try {
          if (!confirmation) throw new Error('Вход отменён. Можно повторить подключение.');
          await post('authorize/finish', { state, code: confirmation });
          if (flow.signal.aborted) return;
          setSecret(''); setAvailability('ready'); setStep('start');
          setConnection(state);
          await browse(state, [], flow.signal);
        } catch (e) { if (!flow.signal.aborted) { setError((e as Error).message); setBusy(false); } }
      };
      if (channel) channel.onmessage = ({ data }) => { if (!flow.signal.aborted) void finishLogin.current?.(data?.code); };
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
  if (availability === 'missing' && !authUrl && !busy) return <div className="library-form">
    {step === 'start' && <>
      <p className="help">При первом подключении понадобятся два ключа из кабинета {provider === 'google' ? 'Google Cloud' : provider === 'yandex' ? 'Яндекс OAuth' : name}.
        {provider === 'dropbox' ? ' ' : <br />}Мастер покажет, где их взять.</p>
      <div className="settings-actions">
        <button type="button" className="primary" onClick={() => setStep('register')}>Подключить {name}</button>
        <button type="button" className="secondary" onClick={() => setStep('keys')}>У меня есть ключи</button>
      </div>
    </>}
    {step === 'register' && <>
      <strong>Шаг 1. Зарегистрируйте приложение в {name}</strong>
      <a className={provider === 'dropbox' ? 'library-provider-link' : undefined} href={guide.url} target="_blank" rel="noreferrer">Открыть кабинет {name} ↗</a>
      <ol>{guide.steps.map((text, index) => <li key={text}>{text}{provider === 'google' && index === 0 && <>
        {' '}<a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Открыть Google Drive API</a>
      </>}</li>)}{screenCode
        ? <li>Оставьте адрес возврата Яндекса <code>{redirect}</code> и нажмите «Создать приложение».</li>
        : <li>В поле <b>{guide.redirect}</b> вставьте адрес ниже и сохраните настройки.</li>}</ol>
      {!screenCode && <label>Адрес возврата<input readOnly value={redirect} onFocus={e => e.currentTarget.select()} /></label>}
      {provider === 'dropbox' && <DropboxPermissions />}
      <div className="settings-actions">
        {!screenCode && <button type="button" className="secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(redirect); setCopied(true); setError(''); }
          catch { setError('Выделите адрес в поле выше и скопируйте его.'); }
        }}>{copied ? 'Адрес скопирован' : 'Скопировать адрес'}</button>}
        <button type="button" className="primary" onClick={() => { setError(''); setStep('keys'); }}>Далее — ввести ключи</button>
      </div>
    </>}
    {step === 'keys' && <>
      <strong>Шаг 2. Введите ключи и войдите</strong>
      {provider === 'dropbox' && <DropboxPermissions />}
      {provider === 'google' && <p className="help">Если приложение в режиме <b>Testing</b>, откройте
        {' '}<a className="library-provider-link" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Google Auth Platform → Audience ↗</a>
        {' '}в проекте этого Client ID. В разделе <b>Test users → Add users</b> добавьте адрес аккаунта, с которым будете входить, и нажмите <b>Save</b>.</p>}
      <p className="help">В кабинете {name} откройте «{guide.location}». Скопируйте два значения из карточки приложения.</p>
      <label>{guide.id}<input autoComplete="off" spellCheck={false} value={clientId} onChange={e => setClientId(e.target.value)} maxLength={2048} /></label>
      <label>{guide.secret}<input autoComplete="new-password" type="password" value={secret} onChange={e => setSecret(e.target.value)} maxLength={2048} /></label>
      <p className="help">Подтвердите чтение файлов в окне сервиса. После входа ключи сохранятся для этой платформы.</p>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!clientId.trim() || !secret.trim()} onClick={() => void connect()}>{signIn}</button>
        <button type="button" className="secondary" onClick={() => { setStep('register'); setError(''); }}>Назад</button>
      </div>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </div>;

  return <div className="library-form">
    {!connection && !authUrl && !busy && <>
      <strong>Подключите аккаунт</strong>
      <p className="help">В отдельном окне разрешите чтение файлов. После входа вы выберете папку для библиотеки.</p>
      <button type="button" className="primary" disabled={busy} onClick={() => void connect()}>{signIn}</button>
    </>}
    {authUrl && <>
      <strong role="status">Завершите вход в {name}</strong>
      {screenCode ? <>
        <p className="help">Разрешите чтение Диска в окне Яндекса. Скопируйте показанный код, вернитесь сюда и вставьте его в поле.</p>
        <label>Код подтверждения Яндекса<input autoComplete="one-time-code" inputMode="numeric" value={code}
          maxLength={32} onChange={event => setCode(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); if (code.trim()) void finishLogin.current?.(code.trim()); }
          }} /></label>
      </> : <p className="help">Подтвердите доступ и вернитесь сюда для выбора папки.</p>}
      <div className="settings-actions">
        {screenCode && <button type="button" className="primary" disabled={!code.trim()}
          onClick={() => void finishLogin.current?.(code.trim())}>Подтвердить код</button>}
        <a href={authUrl} target="_blank" rel="noopener noreferrer">Открыть окно входа</a>
        <button type="button" className="secondary" onClick={() => {
          controller.current?.abort(); setCode(''); setAuthUrl(''); setBusy(false);
        }}>Назад</button>
      </div>
    </>}
    {busy && !authUrl && <p className="help" role="status">{connection ? 'Загружаем папки…' : 'Подключаем аккаунт…'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {connection && <>
      <strong>{chosen ? 'Папка для библиотеки выбрана' : 'Откройте папку для библиотеки'}</strong>
      <p className="help">{[name, ...trail.map(folder => folder.name)].join(' / ')}</p>
      {chosen ? <>
        <p className="help" role="status">Агенты с доступом к библиотеке смогут искать и читать файлы в папке «{current?.name}» и её подпапках.</p>
        {selectionConfirmed === undefined && <div className="settings-actions">
          <button type="button" className="secondary" onClick={() => { setChosen(false); onSelect(undefined); }}>Изменить выбор</button>
          <button type="button" className="secondary" onClick={() => void connect()}>Сменить аккаунт</button>
        </div>}
      </> : <>
        {folders.length > 0 && <ul className="settings-records library-drive-folders">{folders.map(folder => <li key={folder.id}>
          <button type="button" disabled={busy} aria-label={'Открыть папку «' + folder.name + '»'}
            onClick={() => void browse(connection, [...trail, folder], controller.current?.signal)}>
            <span>{folder.name}</span><ChevronRight size={15} aria-hidden="true" />
          </button>
        </li>)}</ul>}
        {!busy && !error && !folders.length && <p className="help">{current ? 'Вложенных папок нет.' : 'Нет доступных папок. Создайте папку на диске и обновите список.'}</p>}
        {current && selectionConfirmed !== undefined && <p className="help">На следующем шаге можно изменить название библиотеки.</p>}
        <div className="settings-actions">
          {current && <>
            <button type="button" className="primary" disabled={busy} onClick={chooseFolder}>Далее</button>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => void browse(connection, trail.slice(0, -1), controller.current?.signal)}>На уровень выше</button>
          </>}
          {(error || (!busy && !folders.length && !current)) && <button type="button" className="secondary" disabled={busy}
            onClick={() => void browse(connection, trail, controller.current?.signal)}>Обновить список папок</button>}
          <button type="button" className="secondary" disabled={busy} onClick={() => void connect()}>Сменить аккаунт</button>
        </div>
      </>}
    </>}
  </div>;
}
