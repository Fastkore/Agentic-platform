import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Copy, Folder, FolderOpen, KeyRound, LogIn, Plus, RefreshCw } from 'lucide-react';
import { externalLabels, type DriveAccount, type ExternalFolder, type ExternalProvider, type ExternalSelection } from '../shared/library';
import type { Request } from './library-upload';
import { DriveProviderIcon, driveProviderIcons } from './DriveProviderIcon';
import { Select } from './Select';
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

const preloadBatchSize = 4;
const preloadFolderLimit = 48;

export function ExternalLibraryPicker({ provider, request, onSelect, checkSelection, selectionConfirmed, accountSaved, openAccounts, providerPicker, onFolderStepChange }: {
  providerPicker?: ReactNode;
  onFolderStepChange?: (visible: boolean) => void;
  accountSaved?: () => void; openAccounts?: (provider: ExternalProvider) => void; selectionConfirmed?: boolean; provider: ExternalProvider; request: Request;
  onSelect: (selection?: ExternalSelection, folderName?: string, checkedName?: string) => void;
  checkSelection?: (selection: ExternalSelection, folderName: string, nameOverride: string | undefined, signal?: AbortSignal) => Promise<{ name: string; nameTaken: boolean; connected: boolean }>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [nameConflict, setNameConflict] = useState<{ folder: string; name: string }>();
  const replacementNameId = useId();
  const [connection, setConnection] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [childrenByFolder, setChildrenByFolder] = useState(() => new Map<string, ExternalFolder[]>());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [trail, setTrail] = useState<ExternalFolder[]>([]);
  const [connectedFolders, setConnectedFolders] = useState<ReadonlySet<string>>(() => new Set());
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
  const preload = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); preload.current?.abort(); }, []);
  const post = <T,>(url: string, body: unknown, signal?: AbortSignal) => request<T>('/api/library/external/' + url, { method: 'POST', body: JSON.stringify(body), signal });
  async function listChildren(connection: string, parent: string | undefined, signal?: AbortSignal) {
    const options = { connection, parent, includeAppFolder: provider === 'dropbox' };
    return checkSelection
      ? post<{ folders: ExternalFolder[]; connected: string[] }>('folders', { ...options, includeConnected: true }, signal)
      : { folders: await post<ExternalFolder[]>('folders', options, signal), connected: [] };
  }
  async function preloadChildren(connection: string, roots: ExternalFolder[]) {
    const task = new AbortController();
    preload.current = task;
    const queued = new Set(['']);
    let parents = roots;
    // The root listing is the first level. Prefetch child listings for the next two levels.
    for (let level = 2; level <= 3; level++) {
      const next: ExternalFolder[] = [];
      for (let offset = 0; offset < parents.length && !task.signal.aborted && queued.size <= preloadFolderLimit; offset += preloadBatchSize) {
        const batch = parents.slice(offset, offset + preloadBatchSize);
        const results = await Promise.all(batch.map(async ({ id }) => {
          if (queued.has(id) || queued.size > preloadFolderLimit) return;
          queued.add(id);
          try { return { id, ...await listChildren(connection, id, task.signal) }; }
          catch { /* Leave this branch available to open manually. */ }
        }));
        if (task.signal.aborted) return;
        for (const result of results) {
          if (!result) continue;
          next.push(...result.folders);
          setChildrenByFolder(previous => previous.has(result.id) ? previous : new Map(previous).set(result.id, result.folders));
          setConnectedFolders(previous => new Set([...previous, ...result.connected]));
        }
      }
      parents = next;
    }
  }
  async function browse(id: string, path: ExternalFolder[], signal?: AbortSignal, select = true) {
    setBusy(true); setError(''); setChosen(false); onSelect(undefined);
    const parent = path.at(-1)?.id;
    if (parent === undefined) preload.current?.abort();
    try {
      const result = await listChildren(id, parent, signal);
      if (signal?.aborted) return;
      setChildrenByFolder(previous => new Map(parent === undefined ? [] : previous).set(parent ?? '', result.folders));
      if (select) setTrail(path);
      setConnection(id);
      setConnectedFolders(new Set(result.connected));
      if (parent === undefined) {
        setCollapsed(new Set());
        void preloadChildren(id, result.folders);
      }
    } catch (e) {
      if (signal?.aborted) return;
      if (driveSessionExpired(e)) {
        backToAccount();
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
  function backToAccount() {
    controller.current?.abort(); preload.current?.abort();
    setConnection(''); setTrail([]); setChildrenByFolder(new Map()); setChosen(false); onSelect(undefined);
    setAccountName(''); setError(''); setNameConflict(undefined); setConnectedFolders(new Set()); setBusy(false);
  }
  const nameField = <label>Название аккаунта<input value={accountName} maxLength={100} onChange={e => setAccountName(e.target.value)}
    placeholder="Например, Рабочий диск" /></label>;
  function replaceDropbox() {
    controller.current?.abort();
    preload.current?.abort();
    setConnection(''); setChildrenByFolder(new Map()); setTrail([]);
    setChosen(false); onSelect(undefined);
    setClientId(''); setSecret(''); setError('');
    setStep('keys'); setReplacingDropbox(true);
  }
  async function connect() {
    controller.current?.abort();
    preload.current?.abort();
    const flow = new AbortController(); controller.current = flow;
    const popup = window.open('about:blank', '_blank');
    if (popup) {
      popup.opener = null;
      flow.signal.addEventListener('abort', () => popup.close(), { once: true });
    }
    setCode(''); setChosen(false); setBusy(true); setAuthUrl(''); setConnection(''); setTrail([]); setChildrenByFolder(new Map()); setError(''); onSelect(undefined);
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
  const root = childrenByFolder.get('') ?? [];
  const folders = current ? childrenByFolder.get(current.id) ?? [] : root;
  const appFolder = provider === 'dropbox' && !current ? root.find(folder => folder.id === '') : undefined;
  const selectedFolder = current ?? appFolder;
  const appFolderConnected = !!appFolder && connectedFolders.has(appFolder.id);
  function folderChoiceDisabled(folder: ExternalFolder) {
    return busy || connectedFolders.has(folder.id) || (nameConflict?.folder === folder.id && !nameConflict.name.trim());
  }
  async function chooseFolder(folder: ExternalFolder) {
    if (folderChoiceDisabled(folder)) return;
    const selection = { connection, folder: folder.id };
    let checkedName: string | undefined;
    if (checkSelection) {
      const signal = controller.current?.signal;
      const nameOverride = nameConflict?.folder === folder.id ? nameConflict.name.trim() : undefined;
      setBusy(true); setError('');
      try {
        const result = await checkSelection(selection, folder.name, nameOverride, signal);
        if (signal?.aborted) return;
        if (result.connected) {
          setConnectedFolders(previous => new Set([...previous, folder.id]));
          setNameConflict(undefined);
          return;
        }
        if (result.nameTaken) {
          setNameConflict({ folder: folder.id, name: result.name });
          return;
        }
        checkedName = result.name;
      } catch (e) {
        if (signal?.aborted) return;
        if (driveSessionExpired(e)) backToAccount();
        setNameConflict(undefined);
        setError((e as Error).message);
        return;
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    }
    setNameConflict(undefined);
    onSelect(selection, folder.name, checkedName);
    setChosen(true);
  }

  function expandFolder(id: string) {
    setCollapsed(previous => {
      if (!previous.has(id)) return previous;
      const updated = new Set(previous);
      updated.delete(id);
      return updated;
    });
  }
  function navigate(path: ExternalFolder[]) {
    setNameConflict(undefined);
    const folder = path.at(-1);
    if (folder) expandFolder(folder.id);
    if (childrenByFolder.has(folder?.id ?? '')) {
      setTrail(path);
      setError('');
      return;
    }
    void browse(connection, path, controller.current?.signal);
  }
  function toggleFolder(path: ExternalFolder[], id: string, open: boolean) {
    if (open) {
      setCollapsed(previous => new Set([...previous, id]));
      if (trail.length > path.length && path.every((folder, index) => folder.id === trail[index]?.id)) {
        setTrail(path);
        setNameConflict(undefined);
      }
    } else {
      expandFolder(id);
      if (!childrenByFolder.has(id)) void browse(connection, path, controller.current?.signal, false);
    }
  }
  function branch(path: ExternalFolder[]): ReactNode {
    const children = childrenByFolder.get(path.at(-1)?.id ?? '')?.filter(f => f.id !== '' && !path.some(parent => parent.id === f.id));
    if (!children?.length) return null;
    return <ul>{children.map(folder => {
      const pathToFolder = [...path, folder];
      const descendants = childrenByFolder.get(folder.id);
      const open = !!descendants?.length && !collapsed.has(folder.id);
      const active = pathToFolder.length === trail.length && pathToFolder.every((item, index) => item.id === trail[index]?.id);
      const connected = connectedFolders.has(folder.id);
      const Icon = open ? FolderOpen : Folder;
      const Chevron = open ? ChevronDown : ChevronRight;
      return <li key={folder.id}>
        <div className="library-folder-row">
          {descendants?.length === 0 ? <span className="library-folder-toggle" /> :
            <button type="button" className="library-folder-toggle" disabled={busy} aria-expanded={open}
              aria-label={(open ? 'Свернуть папку «' : 'Раскрыть папку «') + folder.name + '»'}
              onClick={() => toggleFolder(pathToFolder, folder.id, open)}><Chevron size={14} aria-hidden="true" /></button>}
          <button type="button" className="library-folder-name" disabled={busy} aria-current={active || undefined}
            onClick={() => navigate(pathToFolder)}>
            <Icon size={17} aria-hidden="true" /><span>{folder.name}</span>
            {connected && <small className="library-folder-status">Подключена</small>}
          </button>
        </div>
        {open && branch(pathToFolder)}
      </li>;
    })}</ul>;
  }
  if (availability === 'checking') return <>{providerPicker}<SettingsSpinner inline label={`Проверяем подключение к ${name}…`} /></>;
  if (availability === 'failed') return <div className="library-form">
    {providerPicker}
    <p role="alert">Не удалось проверить, доступен ли {name}.</p>
    <button className="secondary" type="button" onClick={() => setCheck(n => n + 1)}><RefreshCw size={16} aria-hidden="true" />Проверить ещё раз</button>
  </div>;
  if ((availability === 'missing' || replacingDropbox) && !authUrl && !busy) return <div className="library-form">
    {step === 'start' && <>
      <p className="help">При первом подключении понадобятся два ключа из кабинета {provider === 'google' ? 'Google Cloud' : provider === 'yandex' ? 'Яндекс OAuth' : name}.
        {provider === 'dropbox' ? ' ' : <br />}Мастер покажет, где их взять.</p>
      <div className="settings-actions">
        <button type="button" className="primary" onClick={() => setStep('register')}><Plus size={16} aria-hidden="true" />Подключить {name}</button>
        <button type="button" className="secondary" onClick={() => setStep('keys')}><KeyRound size={16} aria-hidden="true" />У меня есть ключи</button>
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
        }}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? 'Адрес скопирован' : 'Скопировать адрес'}</button>}
        <button type="button" className="secondary library-action-button" onClick={() => { setError(''); setStep('keys'); }}>
          Далее — ввести ключи <ArrowRight size={16} aria-hidden="true" />
        </button>
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
        <button type="button" className="primary" disabled={!accountName.trim() || !clientId.trim() || !secret.trim()} onClick={() => void connect()}><LogIn size={16} aria-hidden="true" />{signIn}</button>
        <button type="button" className="secondary library-action-button" onClick={() => {
          setStep(replacingDropbox ? 'start' : 'register');
          if (replacingDropbox) { setReplacingDropbox(false); setSecret(''); }
          setError('');
        }}><ArrowLeft size={16} aria-hidden="true" /> Назад</button>
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
        <button type="button" className="primary" disabled={!accountName.trim()} onClick={() => void connect()}><LogIn size={16} aria-hidden="true" />{signIn}</button>
        {provider === 'dropbox' && <button type="button" className="secondary" onClick={replaceDropbox}><RefreshCw size={16} aria-hidden="true" />Настроить Dropbox заново</button>}
      </div>
    </> : accounts.length ? <>
      <div className="library-picker-field">
        <label htmlFor={accountFieldId}>Аккаунт {name}</label>
        <Select id={accountFieldId} className="settings-select" placeholder="Выберите аккаунт" disabled={busy}
          options={accounts.map(account => ({ value: account.id, label: account.name, image: driveProviderIcons[account.provider] }))}
          value={selectedAccount?.id ?? ''} onChange={id => { setSelectedAccountId(id); setError(''); }} />
      </div>
      <div className="settings-actions">
        <button type="button" className="secondary library-action-button" disabled={busy || !selectedAccount} aria-busy={busy}
          onClick={() => { if (selectedAccount) void useSaved(selectedAccount); }}>Далее <ArrowRight size={16} aria-hidden="true" /></button>
        {error && openAccounts && <button type="button" className="secondary" onClick={() => openAccounts(provider)}>Перейти в «Аккаунты»<ArrowRight size={16} aria-hidden="true" /></button>}
      </div>
    </> : <>
      <p className="help">Для {name} пока нет подключённых аккаунтов. Сначала подключите аккаунт в «Настройки → Библиотеки → Аккаунты», затем вернитесь к выбору папки.</p>
      {openAccounts && <button type="button" className="secondary" onClick={() => openAccounts(provider)}>Перейти в «Аккаунты»<ArrowRight size={16} aria-hidden="true" /></button>}
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
          onClick={() => void finishLogin.current?.(code.trim())}><Check size={16} aria-hidden="true" />Подтвердить код</button>}
        <a className="library-provider-link" href={authUrl} target="_blank" rel="noopener noreferrer">Открыть окно входа</a>
        <button type="button" className="secondary library-action-button" onClick={() => {
          controller.current?.abort(); setCode(''); setAuthUrl(''); setBusy(false);
        }}><ArrowLeft size={16} aria-hidden="true" /> Назад</button>
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
          <button type="button" className="secondary library-action-button" onClick={() => { setChosen(false); onSelect(undefined); }}>
            <ArrowLeft size={16} aria-hidden="true" /> Назад
          </button>
        </div>}
      </> : <>
        {!onFolderStepChange && <strong>Выберите папку</strong>}
        <div className="library-drive-heading">
          <nav className="library-path" aria-label="Путь к папке">
            {[{ id: '', name: root.find(f => !f.id)?.name ?? name }, ...trail].map((f, i) => <span key={f.id}>
              {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
              {i === trail.length ? <strong aria-current="location">{f.name}</strong> :
                <button type="button" disabled={busy} onClick={() => navigate(trail.slice(0, i))}>{f.name}</button>}
            </span>)}
          </nav>
          <button type="button" className="workspace-icon" disabled={busy} aria-busy={busy} aria-label="Обновить список папок" title="Обновить список папок"
            onClick={() => { setNameConflict(undefined); preload.current?.abort(); void browse(connection, trail, controller.current?.signal); }}
          >{busy ? <ProgressRing size={16} /> : <RefreshCw size={16} aria-hidden="true" />}</button>
        </div>
        <div className="library-folder-tree" aria-busy={busy}>
          {branch([])}
          {!error && !folders.some(folder => folder.id) && <p className="help">{selectedFolder ? 'Вложенных папок нет.' : 'Нет доступных папок. Создайте папку на диске и обновите список.'}</p>}
        </div>
        {nameConflict && <div className="library-field-row">
          <p className="inline-error" role="alert">Библиотека с таким названием уже есть. Укажите другое название.</p>
          <label htmlFor={replacementNameId}>Название библиотеки</label>
          <input id={replacementNameId} type="text" value={nameConflict.name} maxLength={120} disabled={busy}
            onChange={event => setNameConflict({ ...nameConflict, name: event.target.value })} />
        </div>}
        <div className="settings-actions library-folder-actions">
          {current && <button type="button" className="secondary library-action-button" disabled={folderChoiceDisabled(current)}
            onClick={() => void chooseFolder(current)}>Далее <ArrowRight size={16} aria-hidden="true" /></button>}
          {appFolder && <button type="button" className="secondary library-action-button" disabled={folderChoiceDisabled(appFolder)}
            onClick={() => void chooseFolder(appFolder)}>Выбрать папку приложения <ArrowRight size={16} aria-hidden="true" /></button>}
          {appFolderConnected && <small className="library-folder-status">Подключена</small>}
          <span className="library-account-label library-folder-account" title={name}>
            <DriveProviderIcon provider={provider} /><span>Аккаунт: <strong>{accountName}</strong></span>
          </span>
          <button type="button" className="secondary library-action-button" disabled={busy} onClick={backToAccount}>
            <ArrowLeft size={16} aria-hidden="true" /> Назад
          </button>
        </div>
      </>}
    </>}
  </div>;
}
