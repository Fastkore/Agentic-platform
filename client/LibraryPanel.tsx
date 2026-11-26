import { useCallback, useEffect, useRef, useState, useId } from 'react';
import { ChevronLeft, Cloud, Database, Folder, HardDrive, Users, Layers, Trash2 } from 'lucide-react';
import type { LibraryFolderSummary, LibraryProfile, OutputPolicy } from '../shared/library';
import { externalLabels, type DriveAccount, type ExternalProvider, type ExternalSelection } from '../shared/library';
import { LibraryStorageSetup, type StorageStatus } from './LibraryStorageSetup';
import { ExternalLibraryPicker, driveSessionExpired } from './ExternalLibraryPicker';
import { PermissionSwitch } from './PermissionSwitch';
import { SettingsSpinner } from './SettingsSpinner';
import { SettingsTabStrip } from './SettingsTabs';
import { DriveProviderIcon } from './DriveProviderIcon';
import { PlatformIcon } from './PlatformIcon';
import { WorkspaceDialog } from './WorkspaceDialog';
import { Select } from './Select';
import { formatBytes, type Request } from './library-upload';
import { folderLine, LibraryFolderCard, useLibraryRefresh } from './LibraryFolderCard';
import './specialists.css';
import './library.css';

export const profileLabels: Record<LibraryProfile, string> = { documents: 'Документы', code: 'Исходники' };
export const outputModes: Record<OutputPolicy, string> = { explanation_only: 'Только объяснение', excerpts_allowed: 'Короткие цитаты' };
const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }));
export type FolderDraft = Pick<LibraryFolderSummary, 'name' | 'description' | 'profile' | 'outputPolicy' | 'active'>;
export const emptyFolderDraft: FolderDraft = { name: '', description: '', profile: 'documents', active: true, outputPolicy: 'explanation_only' };
const statusLabel = (active: boolean) => active ? 'Активна' : 'Неактивна';

/** Folder settings form shared by creation and editing. */
export function FolderForm({ draft, setDraft, isAdmin, disabled, compact = false }: {
  draft: FolderDraft; setDraft: (draft: FolderDraft) => void; isAdmin: boolean; disabled?: boolean; compact?: boolean;
}) {
  const name = <div><label htmlFor="library-name">Название</label><input id="library-name" required maxLength={120} value={draft.name} disabled={disabled} autoFocus={compact} onChange={e => setDraft({ ...draft, name: e.target.value })}
      placeholder="Например, Договоры" /></div>;
  const optionsGrid = <>
    <div><label htmlFor="library-profile">Содержимое</label><Select id="library-profile" className="settings-select" value={draft.profile} options={options(profileLabels)} disabled={disabled}
      onChange={value => setDraft({ ...draft, profile: value as LibraryProfile })} /></div>
    <div><label htmlFor="library-output">Выдача агентом</label><Select id="library-output" className="settings-select" value={draft.outputPolicy} options={options(outputModes)} disabled={disabled}
      onChange={value => setDraft({ ...draft, outputPolicy: value as OutputPolicy })} /></div>
    {isAdmin && <div className="library-active-field"><span>Доступ</span><label>
      <PermissionSwitch name="Активная" checked={draft.active} disabled={disabled} onChange={active => setDraft({ ...draft, active })} />
      Активная
    </label></div>}
    <div className="library-wide"><label htmlFor="library-description">Назначение</label><input id="library-description" maxLength={2000} value={draft.description} disabled={disabled}
      onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="Что здесь лежит и для каких вопросов" /></div>
  </>;
  if (compact) return <>
    <div className="library-form-grid">{name}</div>
    <details className="library-advanced-settings">
      <summary>Дополнительные настройки</summary>
      <div className="library-form-grid">{optionsGrid}</div>
    </details>
  </>;
  return <div className="library-form-grid">{name}{optionsGrid}</div>;
}

export function LibraryRemovalDialog({ title, name, description, cancel, confirm }: {
  title: string; name: string; description: string; cancel: () => void; confirm: () => void;
}) {
  return <WorkspaceDialog title={title + ' «' + name + '»?'} className="workspace-chat-rename" closeOnBackdrop={false} close={cancel}>
    <p>{description}</p>
    <div className="settings-dialog-actions">
      <button type="button" className="secondary" data-dialog-focus onClick={cancel}>Отмена</button>
      <button type="button" className="secondary project-delete" onClick={confirm}>{title}</button>
    </div>
  </WorkspaceDialog>;
}

export type LibraryKind = 's3' | 'external';
export function LibraryKindIcon({ external }: { external: boolean }) {
  return <span className={external ? 'library-icon-external' : 'library-icon-ordinary'}><PlatformIcon name={external ? 'cloud' : 'folder'} /></span>;
}
export const libraryTabs = [['s3', 'Обычные', Folder], ['external', 'Внешние', Cloud]] as const;
export function libraryTabCounts(folders: LibraryFolderSummary[]) {
  const external = folders.filter(folder => folder.external).length;
  return { s3: folders.length - external, external };
}
const adminLibraryTabs = [...libraryTabs, ['accounts', 'Аккаунты', Users], ['storage', 'MinIO / S3', HardDrive]] as const;
export function LibraryToolbar({ kind, search, setSearch, creating, toggleCreate, pending }: {
  kind: LibraryKind; search: string; setSearch: (value: string) => void; creating: boolean; toggleCreate?: () => void; pending: boolean;
}) {
  return <div className="library-toolbar">
    <div className="library-search">
      <PlatformIcon name="search" />
      <input type="search" aria-label="Поиск библиотеки" placeholder="Поиск библиотеки" value={search}
        onChange={event => setSearch(event.target.value)} />
    </div>
    {toggleCreate && <button type="button" className="secondary" disabled={pending} aria-expanded={creating} onClick={toggleCreate}>
      <LibraryKindIcon external={kind === 'external'} />Создать библиотеку
    </button>}
  </div>;
}
export function CreateLibraryForm({ kind, request, pending, submit, cancel, project, storageChanged, error, openAccounts }: {
  kind: LibraryKind; request: Request; pending: boolean; submit: (create: () => Promise<LibraryFolderSummary>) => void; cancel: () => void; project?: boolean; storageChanged?: () => void; error?: string; openAccounts?: (provider: ExternalProvider) => void;
}) {
  const [draft, setDraft] = useState(emptyFolderDraft);
  const [provider, setProvider] = useState<ExternalProvider>('dropbox');
  const [storage, setStorage] = useState<StorageStatus>(), [storageError, setStorageError] = useState('');
  const [reloadStorage, setReloadStorage] = useState(0);
  useEffect(() => {
    if (kind !== 's3') return;
    const abort = new AbortController();
    setStorageError('');
    request<StorageStatus>('/api/library/storage', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setStorage(value); })
      .catch((e: Error) => { if (!abort.signal.aborted) setStorageError(e.message); });
    return () => abort.abort();
  }, [kind, request, reloadStorage]);
  const [selection, setSelection] = useState<ExternalSelection>();
  const [attempt, setAttempt] = useState(0);
  const suggestedName = useRef('');
  const showDetails = kind === 's3' ? !!storage?.configured : !!selection;
  const ready = !!draft.name.trim() && showDetails;
  async function create() {
    try {
      return await request<LibraryFolderSummary>('/api/library', { method: 'POST', body: JSON.stringify({ ...draft, external: selection }) });
    } catch (e) {
      if (selection && driveSessionExpired(e)) { setSelection(undefined); setAttempt(n => n + 1); }
      throw e;
    }
  }
  const form = <form className={kind === 'external' ? 'library-form' : 'agent-card library-form'} onSubmit={e => { e.preventDefault(); if (ready && !pending) submit(create); }}>
    {kind === 's3' && <strong>Обычная библиотека</strong>}
    <fieldset disabled={pending} className="library-source-fields">
      {kind === 'external' ? <>
        <ExternalLibraryPicker key={provider + attempt} selectionConfirmed={!!selection} openAccounts={openAccounts} provider={provider} request={request}
          providerPicker={<>
            <label htmlFor="library-provider">Внешний диск</label>
            <select id="library-provider" className="library-drive-select" value={provider}
              onChange={event => setProvider(event.target.value as ExternalProvider)}>
              {options(externalLabels).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </>}
          onSelect={(next, name) => {
          setSelection(next);
          if (name) {
            const previous = suggestedName.current, suggestion = name.slice(0,120);
            suggestedName.current = suggestion;
            setDraft(current => !current.name.trim() || current.name === previous ? { ...current, name: suggestion } : current);
          }
        }} />
      </> : storage?.configured ? <p className="help">Назовите библиотеку и нажмите «{project ? 'Создать и подключить' : 'Создать'}». Затем нажмите «Загрузить папку» и выберите файлы на компьютере.</p>
        : storage ? <LibraryStorageSetup request={request} onSaved={() => { setReloadStorage(n => n + 1); storageChanged?.(); }} />
        : storageError ? <><p role="alert">{storageError}</p><button type="button" className="secondary" onClick={() => setReloadStorage(n => n + 1)}>Проверить ещё раз</button></>
        : <SettingsSpinner inline label="Проверяем хранилище…" />}
    </fieldset>
    {showDetails && <>
      <FolderForm draft={draft} setDraft={setDraft} isAdmin disabled={pending} compact={kind === 'external'} />
    </>}
    {showDetails && project && <p className="help">Библиотека подключится к этому проекту. Доступ агентам можно назначить на вкладке прав.</p>}
    {kind === 'external' && error && <p className="inline-error" role="alert">{error}</p>}
    {(showDetails || kind === 's3') && <div className="settings-actions">{showDetails && <button type="submit" className="primary" disabled={pending || !ready}>{project ? 'Создать и подключить' : 'Создать'}</button>}
      {kind === 's3'
        ? <button type="button" className="secondary" disabled={pending} onClick={cancel}>Отмена</button>
        : <button type="button" className="secondary" disabled={pending} onClick={() => setSelection(undefined)}>Изменить папку</button>}</div>}
  </form>;
  return kind === 'external'
    ? <WorkspaceDialog title="Внешняя библиотека" className="external-library-dialog" closeOnBackdrop={false} close={() => { if (!pending) cancel(); }}>{form}</WorkspaceDialog>
    : form;
}

/** Settings → Library: all folders the user may manage, storage status and the projects each folder is connected to. */
export function LibraryPanel({ request, isAdmin, initialAccountsProvider }: { request: Request; isAdmin: boolean; initialAccountsProvider?: ExternalProvider }) {
  const [folders, setFolders] = useState<LibraryFolderSummary[]>();
  const [storage, setStorage] = useState<StorageStatus>();
  const [storageLoading, setStorageLoading] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [folderSearch, setFolderSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const tabId = useId();
  const [tab, setTab] = useState<LibraryKind | 'accounts' | 'storage'>(initialAccountsProvider ? 'accounts' : 's3');
  const [creating, setCreating] = useState<LibraryKind>();
  const [accounts, setAccounts] = useState<DriveAccount[]>();
  const [addAccount, setAddAccount] = useState(false);
  const [accountProvider, setAccountProvider] = useState<ExternalProvider>(initialAccountsProvider ?? 'dropbox');
  const [removeAccount, setRemoveAccount] = useState<DriveAccount>();
  const [storageSetup, setStorageSetup] = useState(false);
  const [editing, setEditing] = useState<{ draft: FolderDraft; revision: number }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageCheck, setStorageCheck] = useState<{ message: string; failed?: boolean }>();
  const [pending, setPending] = useState(false);
  const loadAccounts = useCallback(async () => {
    try { setAccounts(await request<DriveAccount[]>('/api/library/external/accounts')); }
    catch (e) { setError((e as Error).message); }
  }, [request]);
  useEffect(() => { if (isAdmin) void loadAccounts(); }, [loadAccounts, isAdmin, tab, creating]);
  const loadStorage = useCallback(async () => {
    if (!isAdmin) return;
    setStorageLoading(true);
    try { setStorage(await request<StorageStatus>('/api/library/storage')); }
    catch { setStorage(undefined); }
    finally { setStorageLoading(false); }
  }, [request, isAdmin]);
  const load = useCallback(async () => {
    await request<LibraryFolderSummary[]>('/api/library').then(setFolders).catch((e: Error) => setError(e.message));
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (isAdmin && tab === 'storage') void loadStorage(); }, [isAdmin, tab, loadStorage]);
  useLibraryRefresh(folders, load);
  const reload = useCallback(() => { void load(); if (isAdmin && tab === 'storage') void loadStorage(); }, [load, isAdmin, tab, loadStorage]);
  async function act(work: () => Promise<unknown>, done?: string) {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try { await work(); await load(); if (done) setNotice(done); } catch (e) { setError((e as Error).message); await load(); } finally { setPending(false); }
  }
  async function checkStorage() {
    if (pending) return;
    setPending(true); setStorageCheck(undefined);
    try {
      await request('/api/library/storage/check', { method: 'POST', body: '{}' });
      setStorageCheck({ message: 'Соединение с хранилищем проверено.' });
      await loadStorage();
    } catch (e) {
      setStorageCheck({ message: (e as Error).message, failed: true });
    } finally { setPending(false); }
  }
  function openAccounts(provider: ExternalProvider) {
    setCreating(undefined); setSelected(undefined); setEditing(undefined);
    setAccountProvider(provider); setError(''); setNotice(''); setTab('accounts');
  }
  const folder = folders?.find(f => f.id === selected);
  const currentDraft: FolderDraft | undefined = folder && {
    name: folder.name, description: folder.description, profile: folder.profile, outputPolicy: folder.outputPolicy, active: folder.active,
  };
  const editDraft = editing?.draft ?? currentDraft;
  const includes = (name: string, query: string) => name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
  const tabFolders = folders?.filter(item => !!item.external === (tab === 'external'));
  const visibleFolders = tabFolders?.filter(item => includes(item.name, folderSearch));
  const visibleProjects = folder?.projects.filter(project => includes(project.name ?? project.id, projectSearch));
  const processing = storage ? [
    storage.indexQueue > 0 && `В очереди: ${storage.indexQueue}`,
    storage.indexFailures > 0 && `Сбоев обработки: ${storage.indexFailures}`,
    storage.openUploads > 0 && `Незавершённых загрузок: ${storage.openUploads}`,
  ].filter(Boolean).join(' · ') : '';

  if (folder) return <div className="library-settings">
    <header className="library-heading">
      <h2 id="settings-section-title">Библиотеки · {folder.name}</h2>
      <button type="button" className="specialist-back" onClick={() => { setSelected(undefined); setEditing(undefined); setNotice(''); }}><ChevronLeft size={16} aria-hidden="true" />Все папки</button>
    </header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    <section className="specialist-card">
      <h3><Database size={18} aria-hidden="true" />Материалы</h3>
      <p className="help">{folderLine(folder)} · {statusLabel(folder.active)} · {profileLabels[folder.profile]} · {outputModes[folder.outputPolicy]}
        {' · '}занято {formatBytes(folder.usedBytes)} из {formatBytes(folder.quotaBytes)}</p>
      {folder.description && <p className="help">{folder.description}</p>}
      <LibraryFolderCard request={request} folder={folder} isAdmin={isAdmin} reload={reload} openAccounts={openAccounts} />
    </section>
    <section className="specialist-card">
      <h3><Layers size={18} aria-hidden="true" />Где используется</h3>
      {folder.projects.length > 0 && <input type="search" aria-label="Поиск по связанным проектам" placeholder="Поиск по проектам…"
        value={projectSearch} onChange={event => setProjectSearch(event.target.value)} />}
      {visibleProjects?.length ? <ul className="settings-records">{visibleProjects.map(p => <li key={p.id}><div><strong>{p.name ?? p.id}</strong></div></li>)}</ul>
        : <p className="help">{folder.projects.length ? 'Проекты не найдены.' : 'Папка пока не подключена к проектам.'}</p>}
    </section>
    {folder.canManage && editDraft && <section className="specialist-card">
      <h3>Настройки папки</h3>
      <form className="library-form" onSubmit={e => {
        e.preventDefault();
        if (!editing || !editDraft.name.trim()) return;
        const { active, ...changes } = editDraft;
        void act(async () => {
          await request('/api/library/' + folder.id, { method: 'PATCH', body: JSON.stringify({ revision: editing.revision, ...changes, ...(isAdmin ? { active } : {}) }) });
          setEditing(undefined);
        }, 'Настройки сохранены.');
      }}>
        <FolderForm draft={editDraft} isAdmin={isAdmin} disabled={pending}
          setDraft={next => setEditing({ draft: next, revision: editing?.revision ?? folder.revision })} />
        {folder.classification === 'restricted' && editDraft.active && <p className="help">Для этой папки также действуют правила закрытого анализа.</p>}
        <div className="settings-actions">
          <button type="submit" className="primary" disabled={pending || !editing || !editDraft.name.trim()}>Сохранить</button>
          <button type="button" className="secondary" disabled={pending || !editing} onClick={() => setEditing(undefined)}>Отмена</button>
          {folder.canDelete && <button type="button" className="secondary library-danger" disabled={pending}
            onClick={() => setConfirmRemoval(true)}><Trash2 size={16} aria-hidden="true" />{folder.external ? 'Отключить библиотеку' : 'Удалить папку'}</button>}
        </div>
      </form>
      {confirmRemoval && <LibraryRemovalDialog title={folder.external ? 'Отключить библиотеку' : 'Удалить папку'} name={folder.name}
        description={(folder.external ? 'Синхронизация и подготовка к поиску остановятся. Оригиналы останутся на диске.' : 'Папка и её файлы будут удалены без возможности восстановления.')
          + (folder.projects.length ? ' Папка исчезнет из проектов: ' + folder.projects.map(p => p.name ?? p.id).join(', ') + '.' : '')}
        cancel={() => setConfirmRemoval(false)} confirm={() => {
          setConfirmRemoval(false);
          void act(async () => {
            await request(`/api/library/${folder.id}?revision=${folder.revision}`, { method: 'DELETE' });
            setSelected(undefined);
          }, folder.external ? 'Библиотека отключена.' : 'Папка удалена.');
        }} />}
    </section>}
  </div>;

  return <div className="library-settings">
    <h2 id="settings-section-title">Библиотеки</h2>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    <div className="library-folders-heading">
      <SettingsTabStrip sections={isAdmin ? adminLibraryTabs : libraryTabs} value={tab} id={tabId} label="Библиотеки"
        counts={{ ...(folders && libraryTabCounts(folders)), accounts: accounts?.length }}
        className="library-tabs" panelId={key => tabId + key + '-panel'} disabled={pending}
        select={key => { setTab(key); setCreating(undefined); setFolderSearch(''); setNotice(''); }} />
    </div>
    {(tab === 's3' || tab === 'external') && <section className="library-folders" role="tabpanel" aria-labelledby={tabId + tab} id={tabId + tab + '-panel'}>
      <LibraryToolbar kind={tab} search={folderSearch} setSearch={setFolderSearch} creating={!!creating} pending={pending}
        toggleCreate={isAdmin ? () => { setError(''); setCreating(creating ? undefined : tab); } : undefined} />
      {creating && <CreateLibraryForm key={creating} kind={creating} error={error} openAccounts={openAccounts} storageChanged={reload} request={request} pending={pending} cancel={() => setCreating(undefined)} submit={create => void act(async () => {
        const created = await create();
        setCreating(undefined);
        if (created.external) { setTab('external'); setFolderSearch(''); }
        else setSelected(created.id);
      }, creating === 'external' ? 'Создана внешняя библиотека.' : 'Папка создана. Загрузите в неё материалы.')} />}
      {!folders && !error && <SettingsSpinner label="Загрузка библиотек…" />}
      {visibleFolders?.length ? <ul className="settings-records">{visibleFolders.map(f => <li key={f.id}>
        <div>
          <strong><LibraryKindIcon external={!!f.external} />{f.name}</strong>
          <small>{statusLabel(f.active)} · {profileLabels[f.profile]} · {outputModes[f.outputPolicy]}</small>
          <small>{folderLine(f)}{f.projects.length ? ' · проекты: ' + f.projects.map(p => p.name ?? p.id).join(', ') : ' · не подключена'}</small>
        </div>
        <div className="library-row-actions">
          {f.external?.accountName && <span className="library-account-label" title={'Аккаунт: ' + f.external.accountName}>
            <DriveProviderIcon provider={f.external.provider} /><span>Аккаунт: {f.external.accountName}</span>
          </span>}
          <button type="button" className="secondary" onClick={() => { setNotice(''); setProjectSearch(''); setSelected(f.id); }}>Открыть</button>
        </div>
      </li>)}</ul> : folders && <p className="help">{folderSearch.trim() ? 'Папки не найдены.' : tab === 'external' ? 'Внешних библиотек пока нет.' : 'Обычных библиотек пока нет.'}</p>}
    </section>}
    {tab === 'accounts' && isAdmin && <section className="library-panel" role="tabpanel" id={tabId + tab + '-panel'} aria-labelledby={tabId + tab}>
      <div className="settings-actions"><button type="button" className="primary" onClick={() => setAddAccount(true)}>Подключить аккаунт</button></div>
      {!accounts && !error && <SettingsSpinner label="Загрузка аккаунтов…" />}
      {accounts && (accounts.length ? <ul className="settings-records">{accounts.map(a => <li key={a.id}>
        <div className="library-account-identity">
          <DriveProviderIcon provider={a.provider} />
          <div><strong>{a.name}</strong><small>{externalLabels[a.provider]} · Библиотек: {a.libraries}</small></div>
        </div>
        <button type="button" className="secondary" disabled={pending || a.libraries > 0} title={a.libraries ? 'Сначала отключите связанные библиотеки' : undefined}
          onClick={() => setRemoveAccount(a)}>Отключить</button>
      </li>)}</ul> : <p className="help">Подключите первый аккаунт, чтобы выбирать его папки при создании библиотек.</p>)}
      {removeAccount && <LibraryRemovalDialog title="Отключить аккаунт" name={removeAccount.name} description="Чтобы снова выбирать папки этого аккаунта, потребуется войти в сервис."
        cancel={() => setRemoveAccount(undefined)} confirm={() => { setRemoveAccount(undefined); void act(async () => {
          await request('/api/library/external/accounts/' + removeAccount.id, { method: 'DELETE' }); await loadAccounts();
        }, 'Аккаунт отключён.'); }} />}
      {addAccount && <WorkspaceDialog title="Подключить аккаунт" className="external-library-dialog" closeOnBackdrop={false} close={() => setAddAccount(false)}>
        <div className="library-form"><label htmlFor="account-provider">Сервис</label>
          <Select id="account-provider" className="settings-select" options={options(externalLabels)} value={accountProvider} onChange={v => setAccountProvider(v as ExternalProvider)} />
          <ExternalLibraryPicker key={accountProvider} provider={accountProvider} request={request} onSelect={() => {}} accountSaved={() => {
            setAddAccount(false); void loadAccounts(); setNotice('Аккаунт подключён.');
          }} />
        </div>
      </WorkspaceDialog>}
    </section>}
    {tab === 'storage' && isAdmin && <section className="library-storage" role="tabpanel" id={tabId + tab + '-panel'} aria-labelledby={tabId + tab}>
      {storage ? <>
      {processing && <p className="help">{processing}</p>}
      <div className="library-storage-row">
        <strong><HardDrive size={15} aria-hidden="true" /> {storage.configured ? (storage.kind === 's3' ? 'Хранилище MinIO / S3' : 'Локальное хранилище') : 'Хранилище не настроено'}</strong>
        <div className="settings-actions"><button type="button" className="secondary" aria-expanded={storageSetup} disabled={pending} onClick={() => { setStorageSetup(!storageSetup); setStorageCheck(undefined); }}>{storage.configured ? 'Настроить' : 'Подключить хранилище'}</button>
        {storage.configured && <button type="button" className="secondary" disabled={pending} onClick={() => void checkStorage()}>Проверить</button>}</div>
      </div>
      {storageSetup && <LibraryStorageSetup request={request} location={storage.location} cancel={() => setStorageSetup(false)} onSaved={() => {
        setStorageSetup(false); setStorageCheck({ message: 'Хранилище подключено. Можно загружать файлы.' }); void loadStorage();
      }} />}
      {storageCheck && <p className={storageCheck.failed ? 'inline-error' : 'help'} role={storageCheck.failed ? 'alert' : 'status'}>{storageCheck.message}</p>}
      </> : storageLoading ? <SettingsSpinner label="Загрузка данных хранилища…" /> : <p className="help">Данные о хранилище недоступны. <button type="button" className="secondary" onClick={reload}>Обновить</button></p>}
    </section>}
  </div>;
}
