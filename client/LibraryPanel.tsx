import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Database, HardDrive, Layers, Plus, Trash2 } from 'lucide-react';
import type { LibraryFolderSummary, LibraryProfile, OutputPolicy } from '../shared/library';
import { externalLabels, type ExternalProvider, type ExternalSelection } from '../shared/library';
import { LibraryStorageSetup, type StorageStatus } from './LibraryStorageSetup';
import { ExternalLibraryPicker, driveSessionExpired } from './ExternalLibraryPicker';
import { PermissionSwitch } from './PermissionSwitch';
import { WorkspaceDialog } from './WorkspaceDialog';
import { Select } from './Select';
import { formatBytes, type Request } from './library-upload';
import { folderLine, LibraryFolderCard } from './LibraryFolderCard';
import './specialists.css';
import './library.css';

export const profileLabels: Record<LibraryProfile, string> = { documents: 'Документы', code: 'Исходники' };
export const outputModes: Record<OutputPolicy, string> = { explanation_only: 'Только объяснение', excerpts_allowed: 'Короткие цитаты' };
const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }));
export type FolderDraft = Pick<LibraryFolderSummary, 'name' | 'description' | 'profile' | 'outputPolicy' | 'active'>;
export const emptyFolderDraft: FolderDraft = { name: '', description: '', profile: 'documents', active: true, outputPolicy: 'explanation_only' };
const statusLabel = (active: boolean) => active ? 'Активна' : 'Неактивна';

/** Folder settings form shared by creation and editing. */
export function FolderForm({ draft, setDraft, isAdmin, disabled }: {
  draft: FolderDraft; setDraft: (draft: FolderDraft) => void; isAdmin: boolean; disabled?: boolean;
}) {
  return <div className="library-form-grid">
    <div><label htmlFor="library-name">Название</label><input id="library-name" required maxLength={120} value={draft.name} disabled={disabled} onChange={e => setDraft({ ...draft, name: e.target.value })}
      placeholder="Например, Договоры" /></div>
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
  </div>;
}

export type LibraryKind = 's3' | 'external';
export function LibraryCreateButtons({ kind, select, disabled }: { kind?: LibraryKind; select: (kind?: LibraryKind) => void; disabled: boolean }) {
  return <span className="library-create-actions">{(['s3', 'external'] as const).map(value =>
    <button key={value} type="button" className="secondary" disabled={disabled} aria-expanded={kind === value}
      onClick={() => select(kind === value ? undefined : value)}><Plus size={16} aria-hidden="true" />{value === 's3' ? 'Обычная библиотека' : 'Внешняя библиотека'}</button>
  )}</span>;
}
export function CreateLibraryForm({ kind, request, pending, submit, cancel, project, storageChanged, error }: {
  kind: LibraryKind; request: Request; pending: boolean; submit: (create: () => Promise<LibraryFolderSummary>) => void; cancel: () => void; project?: boolean; storageChanged?: () => void; error?: string;
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
        <label htmlFor="library-provider">Внешний диск</label>
        <Select id="library-provider" className="settings-select" options={options(externalLabels)} value={provider}
          onChange={value => { setProvider(value as ExternalProvider); setSelection(undefined); }} />
        <ExternalLibraryPicker key={provider + attempt} selectionConfirmed={!!selection} provider={provider} request={request} onSelect={(next, name) => {
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
        : <p role="status">Проверяем хранилище…</p>}
    </fieldset>
    {showDetails && <>
      {kind === 'external' && <p className="help">Проверьте название и нажмите «{project ? 'Создать и подключить' : 'Создать'}». После этого начнётся загрузка папки в поисковый индекс.</p>}
      <FolderForm draft={draft} setDraft={setDraft} isAdmin disabled={pending} />
    </>}
    {showDetails && project && <p className="help">Библиотека подключится к этому проекту. Доступ агентам можно назначить на вкладке прав.</p>}
    {kind === 'external' && error && <p className="inline-error" role="alert">{error}</p>}
    {(showDetails || kind === 's3') && <div className="settings-actions">{showDetails && <button type="submit" className="primary" disabled={pending || !ready}>{project ? 'Создать и подключить' : 'Создать'}</button>}
      {kind === 's3'
        ? <button type="button" className="secondary" disabled={pending} onClick={cancel}>Отмена</button>
        : <button type="button" className="secondary" disabled={pending} onClick={() => setSelection(undefined)}>Изменить выбор</button>}</div>}
  </form>;
  return kind === 'external'
    ? <WorkspaceDialog title="Внешняя библиотека" className="external-library-dialog" close={() => { if (!pending) cancel(); }}>{form}</WorkspaceDialog>
    : form;
}

/** Settings → Library: all folders the user may manage, storage status and the projects each folder is connected to. */
export function LibraryPanel({ request, isAdmin }: { request: Request; isAdmin: boolean }) {
  const [folders, setFolders] = useState<LibraryFolderSummary[]>();
  const [storage, setStorage] = useState<StorageStatus>();
  const [selected, setSelected] = useState<string>();
  const [folderSearch, setFolderSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [creating, setCreating] = useState<LibraryKind>();
  const [storageSetup, setStorageSetup] = useState(false);
  const [editing, setEditing] = useState<{ draft: FolderDraft; revision: number }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageCheck, setStorageCheck] = useState<{ message: string; failed?: boolean }>();
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    await Promise.all([
      request<LibraryFolderSummary[]>('/api/library').then(setFolders).catch((e: Error) => setError(e.message)),
      isAdmin ? request<StorageStatus>('/api/library/storage').then(setStorage).catch(() => setStorage(undefined)) : undefined,
    ]);
  }, [request, isAdmin]);
  useEffect(() => { void load(); }, [load]);
  const reload = useCallback(() => { void load(); }, [load]);
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
      await load();
    } catch (e) {
      setStorageCheck({ message: (e as Error).message, failed: true });
    } finally { setPending(false); }
  }
  const folder = folders?.find(f => f.id === selected);
  const currentDraft: FolderDraft | undefined = folder && {
    name: folder.name, description: folder.description, profile: folder.profile, outputPolicy: folder.outputPolicy, active: folder.active,
  };
  const editDraft = editing?.draft ?? currentDraft;
  const includes = (name: string, query: string) => name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
  const visibleFolders = folders?.filter(item => includes(item.name, folderSearch));
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
      <LibraryFolderCard request={request} folder={folder} isAdmin={isAdmin} reload={reload} />
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
          {folder.canDelete && <button type="button" className="secondary library-danger" disabled={pending} onClick={() => {
            const where = folder.projects.length ? `\nПапка исчезнет из проектов: ${folder.projects.map(p => p.name ?? p.id).join(', ')}.` : '';
            if (confirm(folder.external ? `Отключить библиотеку «${folder.name}»? Оригиналы останутся на диске.${where}` : `Удалить папку «${folder.name}» со всеми файлами?${where}\nДействие нельзя отменить.`)) void act(async () => {
              await request(`/api/library/${folder.id}?revision=${folder.revision}`, { method: 'DELETE' });
              setSelected(undefined);
            }, 'Папка удалена.');
          }}><Trash2 size={16} aria-hidden="true" />{folder.external ? 'Отключить библиотеку' : 'Удалить папку'}</button>}
        </div>
      </form>
    </section>}
  </div>;

  return <div className="library-settings">
    <h2 id="settings-section-title">Библиотеки</h2>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    <section className="library-folders" aria-label="Папки библиотеки">
      <div className="library-folders-heading">
        <strong>Папки библиотеки</strong>
        {isAdmin && <LibraryCreateButtons kind={creating} select={value => { setError(''); setCreating(value); }} disabled={pending} />}
      </div>
      {creating && <CreateLibraryForm key={creating} kind={creating} error={error} storageChanged={reload} request={request} pending={pending} cancel={() => setCreating(undefined)} submit={create => void act(async () => {
        const created = await create();
        setCreating(undefined); setSelected(created.id);
      }, creating === 'external' ? 'Создана внешняя библиотека.' : 'Папка создана. Загрузите в неё материалы.')} />}
      {folders && folders.length > 0 && <input type="search" aria-label="Поиск по папкам библиотеки" placeholder="Поиск по папкам библиотеки…"
        value={folderSearch} onChange={event => setFolderSearch(event.target.value)} />}
      {visibleFolders?.length ? <ul className="settings-records">{visibleFolders.map(f => <li key={f.id}>
        <div>
          <strong>{f.name}</strong>
          <small>{statusLabel(f.active)} · {profileLabels[f.profile]} · {outputModes[f.outputPolicy]}</small>
          <small>{folderLine(f)}{f.projects.length ? ' · проекты: ' + f.projects.map(p => p.name ?? p.id).join(', ') : ' · не подключена'}</small>
        </div>
        <button type="button" className="secondary" onClick={() => { setNotice(''); setProjectSearch(''); setSelected(f.id); }}>Открыть</button>
      </li>)}</ul> : folders && <p className="help">{folders.length ? 'Папки не найдены.' : 'Папок пока нет.'}</p>}
    </section>
    {isAdmin && storage && <section className="library-storage" aria-label="Хранилище библиотеки">
      {processing && <p className="help">{processing}</p>}
      <div className="library-storage-row">
        <strong><HardDrive size={15} aria-hidden="true" /> {storage.configured ? (storage.kind === 's3' ? 'Хранилище MinIO / S3' : 'Локальное хранилище') : 'Хранилище не настроено'}</strong>
        <div className="settings-actions"><button type="button" className="secondary" aria-expanded={storageSetup} disabled={pending} onClick={() => { setStorageSetup(!storageSetup); setStorageCheck(undefined); }}>{storage.configured ? 'Настроить' : 'Подключить хранилище'}</button>
        {storage.configured && <button type="button" className="secondary" disabled={pending} onClick={() => void checkStorage()}>Проверить</button>}</div>
      </div>
      {storageSetup && <LibraryStorageSetup request={request} location={storage.location} cancel={() => setStorageSetup(false)} onSaved={() => {
        setStorageSetup(false); setStorageCheck({ message: 'Хранилище подключено. Можно загружать файлы.' }); void load();
      }} />}
      {storageCheck && <p className={storageCheck.failed ? 'inline-error' : 'help'} role={storageCheck.failed ? 'alert' : 'status'}>{storageCheck.message}</p>}
    </section>}
  </div>;
}
