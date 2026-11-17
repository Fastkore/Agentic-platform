import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Database, HardDrive, Layers, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { LibraryClassification, LibraryFolderSummary, LibraryProfile, OutputPolicy } from '../shared/library';
import { Select } from './Select';
import { formatBytes, type Request } from './library-upload';
import { folderLine, LibraryFolderCard } from './LibraryFolderCard';
import './specialists.css';
import './library.css';

interface Storage { configured: boolean; kind?: string; problem?: string; limits: Record<string, number>; activeParts: number; indexQueue: number; indexFailures: number;
  openUploads: number; orphanBlobs: number; indexChunks: number }
export const profileLabels: Record<LibraryProfile, string> = { documents: 'Документы', code: 'Исходники' };
export const outputModes: Record<OutputPolicy, string> = { explanation_only: 'Только объяснение', excerpts_allowed: 'Короткие цитаты' };
const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }));
type Draft = { name: string; description: string; profile: LibraryProfile; classification: LibraryClassification; outputPolicy: OutputPolicy };
const emptyDraft: Draft = { name: '', description: '', profile: 'documents', classification: 'shared', outputPolicy: 'explanation_only' };

/** Folder settings form shared by creation and editing. */
export function FolderForm({ draft, setDraft, isAdmin }: { draft: Draft; setDraft: (draft: Draft) => void; isAdmin: boolean }) {
  return <div className="library-form-grid">
    <div><label htmlFor="library-name">Название</label><input id="library-name" required maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
      placeholder="Например: Договоры, Fastkore Platform" /></div>
    <div><label htmlFor="library-profile">Содержимое</label><Select id="library-profile" className="settings-select" value={draft.profile} options={options(profileLabels)}
      onChange={value => setDraft({ ...draft, profile: value as LibraryProfile })} /></div>
    <div><label htmlFor="library-output">Выдача агентом</label><Select id="library-output" className="settings-select" value={draft.outputPolicy} options={options(outputModes)}
      onChange={value => setDraft({ ...draft, outputPolicy: value as OutputPolicy })} /></div>
    {isAdmin && <div><label htmlFor="library-class">Доступ</label><Select id="library-class" className="settings-select" value={draft.classification}
      options={[{ value: 'shared', label: 'Обычная папка' }, { value: 'restricted', label: 'Закрытая (анализ выключен)' }]}
      onChange={value => setDraft({ ...draft, classification: value as LibraryClassification })} /></div>}
    <div className="library-wide"><label htmlFor="library-description">Назначение</label><input id="library-description" maxLength={2000} value={draft.description}
      onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="Что здесь лежит и для каких вопросов" /></div>
  </div>;
}

/** Settings → Library: all folders the user may manage, storage status and the projects each folder is connected to. */
export function LibraryPanel({ request, isAdmin }: { request: Request; isAdmin: boolean }) {
  const [folders, setFolders] = useState<LibraryFolderSummary[]>();
  const [storage, setStorage] = useState<Storage>();
  const [selected, setSelected] = useState<string>();
  const [folderSearch, setFolderSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<Draft>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([request<LibraryFolderSummary[]>('/api/library'), isAdmin ? request<Storage>('/api/library/storage').catch(() => undefined) : undefined]);
      setFolders(list); setStorage(status);
    } catch (e) { setError((e as Error).message); }
  }, [request, isAdmin]);
  useEffect(() => { void load(); }, [load]);
  const reload = useCallback(() => { void load(); }, [load]);
  async function act(work: () => Promise<unknown>, done?: string) {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try { await work(); await load(); if (done) setNotice(done); } catch (e) { setError((e as Error).message); await load(); } finally { setPending(false); }
  }
  const folder = folders?.find(f => f.id === selected);
  const includes = (name: string, query: string) => name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
  const visibleFolders = folders?.filter(item => includes(item.name, folderSearch));
  const visibleProjects = folder?.projects.filter(project => includes(project.name ?? project.id, projectSearch));

  if (folder) return <div className="library-settings">
    <button type="button" className="specialist-back" onClick={() => { setSelected(undefined); setEditing(undefined); setNotice(''); }}><ChevronLeft size={16} aria-hidden="true" />Все папки</button>
    <div className="specialist-header"><h2>{folder.name}</h2></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    <section className="specialist-card">
      <h3><Database size={18} aria-hidden="true" />Материалы</h3>
      <p className="help">{folderLine(folder)} · {profileLabels[folder.profile]} · {outputModes[folder.outputPolicy]}{folder.classification === 'restricted' ? ' · закрытая' : ''}
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
    {folder.canManage && <section className="specialist-card">
      <h3>Настройки папки</h3>
      {editing ? <form className="library-form" onSubmit={e => { e.preventDefault(); void act(async () => {
        await request('/api/library/' + folder.id, { method: 'PATCH', body: JSON.stringify({ revision: folder.revision, ...editing, ...(isAdmin ? {} : { classification: undefined }) }) });
        setEditing(undefined);
      }, 'Настройки сохранены.'); }}>
        <FolderForm draft={editing} setDraft={setEditing} isAdmin={isAdmin} />
        <div className="settings-actions"><button type="submit" className="primary" disabled={pending || !editing.name.trim()}>Сохранить</button>
          <button type="button" className="secondary" onClick={() => setEditing(undefined)}>Отмена</button></div>
      </form> : <div className="settings-actions">
        <button type="button" className="secondary" onClick={() => setEditing({ name: folder.name, description: folder.description, profile: folder.profile, classification: folder.classification, outputPolicy: folder.outputPolicy })}>Изменить</button>
        {folder.canDelete && <button type="button" className="secondary library-danger" disabled={pending} onClick={() => {
          const where = folder.projects.length ? `\nПапка исчезнет из проектов: ${folder.projects.map(p => p.name ?? p.id).join(', ')}.` : '';
          if (confirm(`Удалить папку «${folder.name}» со всеми файлами?${where}\nДействие нельзя отменить.`)) void act(async () => {
            await request(`/api/library/${folder.id}?revision=${folder.revision}`, { method: 'DELETE' });
            setSelected(undefined);
          }, 'Папка удалена.');
        }}><Trash2 size={16} aria-hidden="true" />Удалить папку</button>}
      </div>}
    </section>}
  </div>;

  return <div className="library-settings">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    {isAdmin && <section className="setting-section">
      <div className="settings-model-row">
        <label>Хранилище библиотеки</label>
        <button type="button" className="workspace-icon" title="Обновить" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={16} /></button>
      </div>
      {storage && <>
        <ul className="settings-records">
          <li><div><strong><HardDrive size={15} aria-hidden="true" /> {storage.configured ? (storage.kind === 's3' ? 'Отдельный закрытый бакет MinIO' : 'Тестовое локальное хранилище') : 'Хранилище не настроено'}</strong>
            <small>{storage.configured ? `Файл до ${formatBytes(storage.limits.maxFileBytes)} · до ${storage.limits.maxFiles?.toLocaleString('ru')} файлов в папке · квота по умолчанию ${formatBytes(storage.limits.defaultQuotaBytes)}` : storage.problem}</small></div>
            <button type="button" className="secondary" disabled={pending || !storage.configured} onClick={() => void act(() => request('/api/library/storage/check', { method: 'POST', body: '{}' }), 'Соединение с хранилищем проверено.')}>Проверить</button></li>
          <li><div><strong>Обработка</strong>
            <small>В очереди {storage.indexQueue}{storage.indexFailures ? `, со сбоем ${storage.indexFailures}` : ''} · незавершённых загрузок {storage.openUploads}</small></div></li>
        </ul>
        <p className="help">Адрес и ключи хранилища задаются на сервере (BRIDGE_LIBRARY_S3_*) и здесь не показываются.</p>
      </>}
    </section>}
    <section className="setting-section">
      <div className="settings-model-row">
        <label>Папки библиотеки</label>
        {isAdmin && <button type="button" className="secondary" aria-expanded={creating} onClick={() => setCreating(!creating)}><Plus size={16} aria-hidden="true" />Новая папка</button>}
      </div>
      {creating && <form className="agent-card library-form" onSubmit={e => { e.preventDefault(); void act(async () => {
        const created = await request<LibraryFolderSummary>('/api/library', { method: 'POST', body: JSON.stringify(draft) });
        setCreating(false); setDraft(emptyDraft); setSelected(created.id);
      }, 'Папка создана. Загрузите в неё материалы.'); }}>
        <FolderForm draft={draft} setDraft={setDraft} isAdmin={isAdmin} />
        <div className="settings-actions"><button type="submit" className="primary" disabled={pending || !draft.name.trim()}>Создать</button>
          <button type="button" className="secondary" onClick={() => setCreating(false)}>Отмена</button></div>
      </form>}
      {folders && folders.length > 0 && <input type="search" aria-label="Поиск по папкам библиотеки" placeholder="Поиск по папкам библиотеки…"
        value={folderSearch} onChange={event => setFolderSearch(event.target.value)} />}
      {visibleFolders?.length ? <ul className="settings-records">{visibleFolders.map(f => <li key={f.id}>
        <div>
          <strong>{f.name}</strong>
          <small>{folderLine(f)} · {profileLabels[f.profile]}{f.classification === 'restricted' ? ' · закрытая' : ''}{f.projects.length ? ' · проекты: ' + f.projects.map(p => p.name ?? p.id).join(', ') : ' · не подключена'}</small>
        </div>
        <button type="button" className="secondary" onClick={() => { setNotice(''); setProjectSearch(''); setSelected(f.id); }}>Открыть</button>
      </li>)}</ul> : folders && <p className="help">{folders.length ? 'Папки не найдены.' : 'Папок пока нет.'}</p>}
    </section>
  </div>;
}
