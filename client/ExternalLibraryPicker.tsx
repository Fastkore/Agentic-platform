import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { externalLabels, type DriveAccount, type ExternalFolder, type ExternalProvider, type ExternalSelection } from '../shared/library';
import type { Request } from './library-upload';
import { DriveProviderIcon } from './DriveProviderIcon';
import { ProgressRing, SettingsSpinner } from './SettingsSpinner';

const guides = {
  dropbox: { url: 'https://www.dropbox.com/developers/apps/create', id: 'App key', secret: 'App secret', location: 'Settings', redirect: 'OAuth 2 → Redirect URIs',
    steps: ['Создайте приложение с типом Scoped access. Выберите App Folder для отдельной папки приложения или Full Dropbox для выбора существующих папок на Диске.'] },
  google: { url: 'https://console.cloud.google.com/apis/credentials', id: 'Client ID', secret: 'Client secret', location: 'Клиенты OAuth', redirect: 'Authorized redirect URIs',
    steps: ['Выберите проект в Google Cloud и включите Google Drive API.', 'Настройте экран согласия в Google Auth Platform. В разделе Data Access добавьте разрешение https://www.googleapis.com/auth/drive.readonly.', 'Откройте Clients → Create client и выберите Web application.'] },
  yandex: { url: 'https://oauth.yandex.ru/client/new/', id: 'ClientID', secret: 'Client secret', location: 'Карточка приложения', redirect: 'Redirect URI',
    steps: ['Выберите «Для доступа к API или отладки». Укажите название приложения и контактную почту.', 'В правах доступа найдите Яндекс Диск и выберите «Чтение всего Диска» (cloud_api:disk.read).'] },
};
function GoogleTestUsers() {
  return <aside className="library-drive-permissions">
    <strong>Если приложение в режиме Testing, добавьте тестировщика</strong>
    <ol>
      <li>Откройте <a className="library-provider-link" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Google Auth Platform → Audience ↗</a>.
        Вверху страницы выберите проект, в котором создан ваш Client ID.</li>
      <li>В разделе <b>Test users</b> нажмите <b>Add users</b>.</li>
      <li>Введите полный email аккаунта Google, чей Диск хотите подключить, и нажмите <b>Save</b>. Проверьте, что этот адрес появился в списке.</li>
      <li>В мастере нажмите <b>Войти через Google</b> и выберите тот же аккаунт.</li>
    </ol>
    <p>Если Google уже показал <code>403: access_denied</code> с сообщением о тестировщиках, закройте окно ошибки.
      После сохранения адреса нажмите в мастере «Назад» и повторите вход с прежними ключами.</p>
  </aside>;
}

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

export function ExternalLibraryPicker({ provider, request, onSelect, selectionConfirmed, accountSaved, openAccounts, providerPicker, onFolderStepChange }: {
  providerPicker?: ReactNode;
  onFolderStepChange?: (visible: boolean) => void;
  accountSaved?: () => void; openAccounts?: (provider: ExternalProvider) => void; selectionConfirmed?: boolean; provider: ExternalProvider; request: Request; onSelect: (selection?: ExternalSelection, folderName?: string) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [connection, setConnection] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [levels, setLevels] = useState<ExternalFolder[][]>([]), [trail, setTrail] = useState<ExternalFolder[]>([]);
  const [availability, setAvailability] = useState<'checking' | 'ready' | 'missing' | 'failed'>('checking');
  const [check, setCheck] = useState(0);
  const [localChoice, setChosen] = useState(false);
  const chosen = selectionConfirmed ?? localChoice;
  const folderStep = !!connection && !chosen && availability === 'ready';
  useLayoutEffect(() => { onFolderStepChange?.(folderStep); }, [folderStep, onFolderStepChange]);
  const [step, setStep] = useState<'start' | 'register' | 'keys'>('start');
  const [replacingDropbox, setReplacingDropbox] = useState(false);
  const [redirect, setRedirect] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const finishLogin = useRef<((code?: string) => Promise<void>) | null>(null);
  const screenCode = provider === 'yandex' && redirect === 'https://oauth.yandex.ru/verification_code';
  const [accounts, setAccounts] = useState<DriveAccount[]>([]);
  const accountFieldId = useId();
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const selectedAccount = accounts.length === 1 ? accounts[0] : accounts.find(account => account.id === selectedAccountId);
  const [accountName, setAccountName] = useState('');
  const guide = guides[provider];
  const configuring = !!accountSaved;
  useEffect(() => {
    const abort = new AbortController();
    setAvailability('checking');
    const options = { signal: abort.signal };
    const load = configuring
      ? request<{ configured: boolean; redirectUri: string }>('/api/library/external/status/' + provider, options).then(result => {
        if (abort.signal.aborted) return;
        setAvailability(result.configured ? 'ready' : 'missing');
        setRedirect(result.redirectUri);
      })
      : request<DriveAccount[]>('/api/library/external/accounts', options).then(list => {
        if (abort.signal.aborted) return;
        setAccounts(list.filter(account => account.provider === provider));
        setAvailability('ready');
      });
    void load.catch(() => { if (!abort.signal.aborted) setAvailability('failed'); });
    return () => abort.abort();
  }, [provider, request, check, configuring]);

  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const post = <T,>(url: string, body: unknown) => request<T>('/api/library/external/' + url, { method: 'POST', body: JSON.stringify(body) });
  async function browse(id: string, path: ExternalFolder[], signal?: AbortSignal) {
    setBusy(true); setError(''); setChosen(false); onSelect(undefined);
    try {
      const current = path.at(-1);
      const list = await post<ExternalFolder[]>('folders', { connection: id, parent: current?.id, includeAppFolder: provider === 'dropbox' });
      if (signal?.aborted) return;
      setLevels(previous => [...previous.slice(0, path.length), list]); setTrail(path); setConnection(id);
    } catch (e) {
      if (signal?.aborted) return;
      if (driveSessionExpired(e)) {
        setConnection(''); setLevels([]); setTrail([]);
        setCheck(n => n + 1);
      }
      setError((e as Error).message);
    }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function useSaved(account: DriveAccount) {
    controller.current?.abort();
    const flow = new AbortController(); controller.current = flow;
    setBusy(true); setError('');
    try {
      const { state } = await post<{state: string}>('accounts/use', { provider, account: account.id });
      if (flow.signal.aborted) return;
      setAccountName(account.name);
      await browse(state, [], flow.signal);
    } catch (e) { if (!flow.signal.aborted) { setError((e as Error).message); setBusy(false); } }
  }
  function chooseAccount() {
    controller.current?.abort(); setConnection(''); setTrail([]); setLevels([]); setChosen(false); onSelect(undefined);
    setSelectedAccountId(undefined); setAccountName(''); setError(''); setCheck(n => n + 1);
  }
  const nameField = <label>Название аккаунта<input value={accountName} maxLength={100} onChange={e => setAccountName(e.target.value)}
    placeholder="Например, Рабочий диск" /></label>;
  function replaceDropbox() {
    controller.current?.abort();
    setConnection(''); setLevels([]); setTrail([]);
    setChosen(false); onSelect(undefined);
    setClientId(''); setSecret(''); setError('');
    setStep('keys'); setReplacingDropbox(true);
  }
  async function connect() {
    controller.current?.abort();
    const flow = new AbortController(); controller.current = flow;
    const popup = window.open('about:blank', '_blank');
    if (popup) {
      popup.opener = null;
      flow.signal.addEventListener('abort', () => popup.close(), { once: true });
    }
    setCode(''); setChosen(false); setBusy(true); setAuthUrl(''); setConnection(''); setTrail([]); setLevels([]); setError(''); onSelect(undefined);
    try {
      const setup = availability === 'missing' || replacingDropbox ? { id: clientId.trim(), secret: secret.trim() } : undefined;
      const { state, url } = await post<{state: string; url: string}>('authorize', { provider, setup, replaceDropbox: replacingDropbox, switchAccount: true, accountName: accountName.trim() });
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
          setSecret(''); setAvailability('ready'); setStep('start'); setReplacingDropbox(false);
          accountSaved?.();
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
  const folders = levels[trail.length] ?? [];
  const appFolder = provider === 'dropbox' ? folders.find(folder => folder.id === '') : undefined;
  const subfolders = folders.filter(folder => folder.id !== '');
  const selectedFolder = current ?? appFolder;
  function chooseFolder(folder: ExternalFolder) {
    onSelect({ connection, folder: folder.id }, folder.name);
    setChosen(true);
  }

  function navigate(path: ExternalFolder[]) {
    if (path.length < trail.length && path.every((folder, depth) => folder.id === trail[depth].id)) {
      setTrail(path);
      setLevels(previous => previous.slice(0, path.length + 1));
      setError('');
      return;
    }
    void browse(connection, path, controller.current?.signal);
  }
  function branch(depth: number): ReactNode {
    const children = levels[depth]?.filter(f => f.id !== '');
    if (!children?.length) return null;
    return <ul>{children.map(folder => {
      const open = trail[depth]?.id === folder.id;
      const active = open && depth === trail.length - 1;
      const Icon = open ? FolderOpen : Folder;
      const Chevron = open ? ChevronDown : ChevronRight;
      return <li key={folder.id}>
        <button type="button" disabled={busy} aria-expanded={open} aria-current={active || undefined}
          aria-label={(open ? 'Свернуть папку «' : 'Открыть папку «') + folder.name + '»'}
          onClick={() => navigate(open ? trail.slice(0, depth) : [...trail.slice(0, depth), folder])}>
          <Chevron size={14} aria-hidden="true" /><Icon size={17} aria-hidden="true" /><span>{folder.name}</span>
        </button>
        {open && branch(depth + 1)}
      </li>;
    })}</ul>;
  }
  if (availability === 'checking') return <>{providerPicker}<SettingsSpinner inline label={`Проверяем подключение к ${name}…`} /></>;
  if (availability === 'failed') return <div className="library-form">
    {providerPicker}
    <p role="alert">Не удалось проверить, доступен ли {name}.</p>
    <button className="secondary" type="button" onClick={() => setCheck(n => n + 1)}>Проверить ещё раз</button>
  </div>;
  if ((availability === 'missing' || replacingDropbox) && !authUrl && !busy) return <div className="library-form">
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
      <a className="library-provider-link" href={guide.url} target="_blank" rel="noreferrer">Открыть кабинет {name} ↗</a>
      <ol>{guide.steps.map((text, index) => <li key={text}>{text}{provider === 'google' && index === 0 && <>
        {' '}<a className="library-provider-link" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Открыть Google Drive API</a>
      </>}</li>)}{screenCode
        ? <li>Оставьте адрес возврата Яндекса <code>{redirect}</code> и нажмите «Создать приложение».</li>
        : <li>В поле <b>{guide.redirect}</b> вставьте адрес ниже и сохраните настройки.</li>}</ol>
      {!screenCode && <label>Адрес возврата<input readOnly value={redirect} onFocus={e => e.currentTarget.select()} /></label>}
      {provider === 'dropbox' && <DropboxPermissions />}
      {provider === 'google' && <GoogleTestUsers />}
      <div className="settings-actions">
        {!screenCode && <button type="button" className="secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(redirect); setCopied(true); setError(''); }
          catch { setError('Выделите адрес в поле выше и скопируйте его.'); }
        }}>{copied ? 'Адрес скопирован' : 'Скопировать адрес'}</button>}
        <button type="button" className="primary" onClick={() => { setError(''); setStep('keys'); }}>Далее — ввести ключи</button>
      </div>
    </>}
    {step === 'keys' && <>
      <strong>{replacingDropbox ? 'Введите новые ключи Dropbox' : 'Шаг 2. Введите ключи и войдите'}</strong>
      {provider === 'dropbox' && <DropboxPermissions />}
      {provider === 'google' && <GoogleTestUsers />}
      {replacingDropbox && <label>Адрес возврата для нового приложения<input readOnly value={redirect}
        onFocus={event => event.currentTarget.select()} /></label>}
      <p className="help">В кабинете {name} откройте «{guide.location}». Скопируйте два значения из карточки приложения.</p>
      {nameField}
      <label>{guide.id}<input autoComplete="off" spellCheck={false} value={clientId} onChange={e => setClientId(e.target.value)} maxLength={2048} /></label>
      <label>{guide.secret}<input autoComplete="new-password" type="password" value={secret} onChange={e => setSecret(e.target.value)} maxLength={2048} /></label>
      <p className="help">{replacingDropbox
        ? 'Новые ключи сохранятся после успешного входа. Если с прежними ключами связаны библиотеки, их нужно сначала отключить.'
        : 'Подтвердите чтение файлов в окне сервиса. После входа ключи сохранятся для этой платформы.'}</p>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!accountName.trim() || !clientId.trim() || !secret.trim()} onClick={() => void connect()}>{signIn}</button>
        <button type="button" className="secondary" onClick={() => {
          setStep(replacingDropbox ? 'start' : 'register');
          if (replacingDropbox) { setReplacingDropbox(false); setSecret(''); }
          setError('');
        }}>Назад</button>
      </div>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </div>;

  return <div className="library-form">
    {!connection && providerPicker}
    {!connection && !authUrl && (!busy || !configuring) && (accountSaved ? <>
      <strong>Подключите аккаунт</strong>
      {nameField}
      <p className="help">В отдельном окне войдите в аккаунт и разрешите чтение файлов.</p>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!accountName.trim()} onClick={() => void connect()}>{signIn}</button>
        {provider === 'dropbox' && <button type="button" className="secondary" onClick={replaceDropbox}>Настроить Dropbox заново</button>}
      </div>
    </> : accounts.length ? <>
      <label htmlFor={accountFieldId}>Аккаунт {name}</label>
      <div className="library-account-control">
        <DriveProviderIcon provider={provider} />
        <select id={accountFieldId} className="library-drive-select" disabled={busy}
          value={selectedAccount?.id ?? ''} onChange={event => { setSelectedAccountId(event.target.value); setError(''); }}>
          {accounts.length > 1 && <option value="" disabled>Выберите аккаунт</option>}
          {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
      </div>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={busy || !selectedAccount} aria-busy={busy}
          onClick={() => { if (selectedAccount) void useSaved(selectedAccount); }}>Далее</button>
        {error && openAccounts && <button type="button" className="secondary" onClick={() => openAccounts(provider)}>Перейти в «Аккаунты»</button>}
      </div>
    </> : <>
      <p className="help">Для {name} пока нет подключённых аккаунтов. Сначала подключите аккаунт в «Настройки → Библиотеки → Аккаунты», затем вернитесь к выбору папки.</p>
      {openAccounts && <button type="button" className="secondary" onClick={() => openAccounts(provider)}>Перейти в «Аккаунты»</button>}
    </>)}
    {authUrl && <>
      <strong role="status">Завершите вход в {name}</strong>
      {screenCode ? <>
        <p className="help">Разрешите чтение Диска в окне Яндекса. Скопируйте показанный код, вернитесь сюда и вставьте его в поле.</p>
        <label>Код подтверждения Яндекса<input autoComplete="one-time-code" inputMode="numeric" value={code}
          maxLength={32} onChange={event => setCode(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); if (code.trim()) void finishLogin.current?.(code.trim()); }
          }} /></label>
      </> : <p className="help">Подтвердите доступ и вернитесь к списку аккаунтов.</p>}
      <div className="settings-actions">
        {screenCode && <button type="button" className="primary" disabled={!code.trim()}
          onClick={() => void finishLogin.current?.(code.trim())}>Подтвердить код</button>}
        <a className="library-provider-link" href={authUrl} target="_blank" rel="noopener noreferrer">Открыть окно входа</a>
        <button type="button" className="secondary" onClick={() => {
          controller.current?.abort(); setCode(''); setAuthUrl(''); setBusy(false);
        }}>Назад</button>
      </div>
    </>}
    {authUrl && provider === 'google' && <details>
      <summary>Google показал ошибку 403 о тестировщиках?</summary>
      <GoogleTestUsers />
    </details>}
    {busy && !authUrl && configuring && <SettingsSpinner inline label="Подключаем аккаунт…" />}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {connection && <>
      {chosen ? <>
        <div className="library-source-summary">
          <DriveProviderIcon provider={provider} />
          <div><strong>{selectedFolder?.name}</strong><small>{name} · {accountName}</small>
            {trail.length > 1 && <small>В папке {trail.slice(0, -1).map(f => f.name).join(' / ')}</small>}
          </div>
        </div>
        <p className="help">Агенты с доступом смогут читать файлы в этой папке и её подпапках.</p>
        {selectionConfirmed === undefined && <div className="settings-actions">
          <button type="button" className="secondary" onClick={() => { setChosen(false); onSelect(undefined); }}>Изменить выбор</button>
          <button type="button" className="secondary" onClick={chooseAccount}>Сменить аккаунт</button>
        </div>}
      </> : <>
        {!onFolderStepChange && <strong>Выберите папку</strong>}
        <div className="library-drive-heading">
          <nav className="library-path" aria-label="Путь к папке">
            {[{ id: '', name: levels[0]?.find(f => !f.id)?.name ?? name }, ...trail].map((f, i) => <span key={f.id}>
              {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
              {i === trail.length ? <strong aria-current="location">{f.name}</strong> :
                <button type="button" disabled={busy} onClick={() => navigate(trail.slice(0, i))}>{f.name}</button>}
            </span>)}
          </nav>
          <button type="button" className="workspace-icon" disabled={busy} aria-busy={busy} aria-label="Обновить список папок" title="Обновить список папок"
            onClick={() => navigate(trail)}>{busy ? <ProgressRing size={16} /> : <RefreshCw size={16} aria-hidden="true" />}</button>
        </div>
        {levels[0]?.some(f => f.id) && <div className="library-folder-tree">{branch(0)}</div>}
        {!error && !subfolders.length && <p className="help">{selectedFolder ? 'Вложенных папок нет.' : 'Нет доступных папок. Создайте папку на диске и обновите список.'}</p>}
        <div className="settings-actions library-folder-actions">
          {current && <button type="button" className="primary" disabled={busy} onClick={() => chooseFolder(current)}>Далее</button>}
          {appFolder && <button type="button" className="primary" disabled={busy}
            onClick={() => chooseFolder(appFolder)}>Выбрать папку приложения</button>}
          <span className="library-account-label library-folder-account" title={name}>
            <DriveProviderIcon provider={provider} /><span>Аккаунт: <strong>{accountName}</strong></span>
          </span>
          <button type="button" className="secondary" disabled={busy} onClick={chooseAccount}>Сменить аккаунт</button>
        </div>
      </>}
    </>}
  </div>;
}
