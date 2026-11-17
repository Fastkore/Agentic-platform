import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Info, Plus, RefreshCw } from 'lucide-react';
import type { ProjectSummary } from '../shared/types';
import type { LibraryCell, LibraryConnection, LibraryFolderSummary, OutputPolicy, ProjectLibraryView } from '../shared/library';
import { WorkspaceDialog } from './WorkspaceDialog';
import { Select } from './Select';
import { PermissionSwitch } from './PermissionSwitch';
import type { Request } from './library-upload';
import { folderLine, LibraryFolderCard } from './LibraryFolderCard';
import { FolderForm, outputModes, profileLabels } from './LibraryPanel';
import './specialists.css';
import './library.css';

type Tab = 'folders' | 'specialists';
const tabs: [Tab, string][] = [['folders', 'Папки'], ['specialists', 'Специалисты']];
const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }));

/** Project → Library: the project's folders, their state and access of specialists; the same server rule decides for the agent. */
export function ProjectLibraryDialog({ project, request, close, isAdmin, initialProfileId }: {
  project: ProjectSummary; request: Request; close: () => void; isAdmin: boolean; initialProfileId?: string;
}) {
  const base = '/api/projects/' + encodeURIComponent(project.id) + '/library';
  const [view, setView] = useState<ProjectLibraryView>();
  const [folders, setFolders] = useState<LibraryFolderSummary[]>([]);
  const [tab, setTab] = useState<Tab>(initialProfileId ? 'specialists' : 'folders');
  const [expanded, setExpanded] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', profile: 'documents' as const, classification: 'shared' as const, outputPolicy: 'explanation_only' as OutputPolicy });
  const [profileFilter, setProfileFilter] = useState(initialProfileId ?? '');
  const [detail, setDetail] = useState<LibraryCell>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([request<ProjectLibraryView>(base), request<LibraryFolderSummary[]>('/api/library')]);
      setView(next); setFolders(list);
    } catch (e) { setError((e as Error).message); }
  }, [base, request]);
  useEffect(() => { void load(); }, [load]);
  const reload = useCallback(() => { void load(); }, [load]);
  async function act(work: () => Promise<unknown>) {
    if (pending) return;
    setPending(true); setError('');
    try { await work(); await load(); } catch (e) { await load(); setError((e as Error).message); } finally { setPending(false); }
  }
  const update = (c: LibraryConnection, patch: Record<string, unknown>) =>
    act(() => request(`${base}/${c.folderId}`, { method: 'PATCH', body: JSON.stringify({ revision: c.revision, ...patch }) }));
  const grant = (c: LibraryConnection, profileId: string, enabled: boolean, extra: Record<string, unknown> = {}) =>
    act(() => request(`${base}/${c.folderId}/grants`, { method: 'PUT', body: JSON.stringify({ profileId, enabled, revision: c.revision, ...extra }) }));
  const profiles = view?.profiles.filter(p => !profileFilter || p.id === profileFilter) ?? [];

  return <WorkspaceDialog title="Библиотека проекта" className="project-agents-dialog project-library-dialog" close={() => { if (!pending) close(); }}>
    <div className="project-agents-intro">
      <div><strong>{project.name}</strong><p>Папки с материалами, по которым агент отвечает в этом проекте.</p></div>
      <span className="project-specialist-actions">
        <button type="button" className="workspace-icon" title="Обновить" aria-label="Обновить" disabled={pending} onClick={() => void load()}><RefreshCw size={16} /></button>
        {isAdmin && <button type="button" className="secondary" aria-expanded={creating} onClick={() => { setTab('folders'); setCreating(!creating); }}><Plus size={16} aria-hidden="true" />Новая папка</button>}
      </span>
    </div>
    <div className="specialist-tabs library-tabs" role="tablist" aria-label="Разделы библиотеки">
      {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!view && !error && <p role="status">Загрузка…</p>}
    {view && <div className="project-agent-scroll library-panel">

      {tab === 'folders' && <>
        {creating && <form className="agent-card library-form" onSubmit={e => { e.preventDefault(); void act(async () => {
          const created = await request<LibraryFolderSummary>('/api/library', { method: 'POST', body: JSON.stringify(draft) });
          await request(base, { method: 'POST', body: JSON.stringify({ folderId: created.id }) });
          setCreating(false); setExpanded(created.id); setDraft({ ...draft, name: '', description: '' });
        }); }}>
          <FolderForm draft={draft} setDraft={next => setDraft(next as typeof draft)} isAdmin={isAdmin} />
          <p className="help">Папка появится в общей библиотеке и подключится к проекту. Агент начнёт её использовать после загрузки материалов и назначения специалистам.</p>
          <div className="settings-actions">
            <button type="submit" className="primary" disabled={pending || !draft.name.trim()}>Создать и подключить</button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>Отмена</button>
          </div>
        </form>}
        {view.connections.length > 0 ? <ul className="agent-card-list">{view.connections.map(c => {
          const folder = folders.find(f => f.id === c.folderId);
          const assigned = view.cells.filter(cell => cell.folderId === c.folderId && cell.granted).map(cell => view.profiles.find(p => p.id === cell.profileId)?.name).filter(Boolean);
          const open = expanded === c.folderId;
          return <li key={c.folderId} className={'agent-card' + (c.enabled ? '' : ' library-disabled')}>
            <div className="agent-card-heading">
              <Database size={17} aria-hidden="true" />
              <div>
                <strong>{c.folderName}</strong>
                <p>{[profileLabels[c.profile], c.classification === 'restricted' ? 'Закрытая' : '', outputModes[c.outputPolicy], c.enabled ? '' : 'Отключена'].filter(Boolean).join(' · ')}
                  {c.description && <><br />{c.description}</>}</p>
              </div>
              {folder && <span className="project-specialist-actions">
                <button type="button" className="secondary" aria-expanded={open} onClick={() => setExpanded(open ? undefined : c.folderId)}>
                  {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}Материалы</button>
              </span>}
            </div>
            <div className="library-card-body">
              <p className="help">{folder ? folderLine(folder) : c.current ? `${c.current.files.toLocaleString('ru')} файлов` : 'Материалов пока нет'}</p>
              {c.classification === 'restricted' && <p className="library-warning">Закрытая папка: анализ закрытых материалов в этой поставке выключен, агенту она недоступна.</p>}
              <p className="help">Специалисты: {assigned.length ? assigned.join(', ') : 'не назначены — агент папку не использует'}</p>
            </div>
            {open && folder && <LibraryFolderCard request={request} folder={folder} isAdmin={isAdmin} reload={reload} />}
            {c.canManage && <div className="settings-actions library-card-actions">
              <Select className="settings-select" label="Режим выдачи" value={c.outputPolicy} options={options(outputModes)} disabled={pending} fitContent
                onChange={outputPolicy => void update(c, { outputPolicy })} />
              <button type="button" className="secondary" disabled={pending} onClick={() => void update(c, { enabled: !c.enabled })}>{c.enabled ? 'Отключить' : 'Включить'}</button>
              <button type="button" className="secondary" disabled={pending} onClick={() => {
                if (confirm(`Отключить «${c.folderName}» от проекта? Папка останется в библиотеке для других проектов.`)) void act(() => request(`${base}/${c.folderId}?revision=${c.revision}`, { method: 'DELETE' }));
              }}>Убрать из проекта</button>
            </div>}
          </li>;
        })}</ul> : <p className="help">К проекту ещё не подключены папки.</p>}
        {view.available.length > 0 && <div className="settings-project-actions">
          <Select className="settings-select" label="Подключить папку из библиотеки" value="" fitContent
            options={[{ value: '', label: 'Подключить папку из библиотеки…', disabled: true }, ...view.available.map(f => ({ value: f.id, label: f.name }))]}
            onChange={folderId => void act(() => request(base, { method: 'POST', body: JSON.stringify({ folderId }) }))} />
        </div>}
      </>}

      {tab === 'specialists' && <>
        <div className="library-field-row library-filter">
          <label htmlFor="library-profile-filter">Специалист</label>
          <Select id="library-profile-filter" className="settings-select" value={profileFilter} fitContent
            options={[{ value: '', label: 'Все подключённые' }, ...view.profiles.map(p => ({ value: p.id, label: p.name }))]} onChange={setProfileFilter} />
        </div>
        {view.connections.length ? <div className="library-matrix-wrap"><table className="library-matrix">
          <thead><tr><th scope="col">Папка</th>{profiles.map(p => <th key={p.id} scope="col">{p.name}</th>)}</tr></thead>
          <tbody>{view.connections.map(c => <tr key={c.folderId}>
            <th scope="row"><strong>{c.folderName}</strong><small>{c.current ? `${c.current.files.toLocaleString('ru')} файлов` : 'пусто'}</small></th>
            {profiles.map(p => {
              const cell = view.cells.find(x => x.folderId === c.folderId && x.profileId === p.id)!;
              return <td key={p.id} data-state={cell.allowed ? 'allowed' : cell.granted ? 'blocked' : 'off'}>
                <span className="library-cell">
                  <PermissionSwitch name={`${c.folderName} — ${p.name}`} checked={cell.granted} disabled={pending || !c.canManage} onChange={checked => void grant(c, p.id, checked)} />
                  <span>{cell.granted ? (cell.allowed ? outputModes[cell.outputPolicy!] + (cell.files !== undefined ? ` · ${cell.files} файл.` : '') : 'Недоступно') : 'Нет доступа'}</span>
                  <button type="button" className="workspace-icon" title="Почему" aria-label={`Доступ: ${c.folderName} — ${p.name}`} onClick={() => setDetail(cell)}><Info size={15} /></button>
                </span>
              </td>;
            })}
          </tr>)}</tbody>
        </table></div> : <p className="help">Сначала подключите папки на вкладке «Папки».</p>}
        {detail && (() => {
          const c = view.connections.find(x => x.folderId === detail.folderId);
          const p = view.profiles.find(x => x.id === detail.profileId);
          return <div className="agent-card library-detail" role="status">
            <strong>{c?.folderName} — {p?.name}</strong>
            <p className="help">{detail.allowed ? 'Агент этого специалиста может использовать папку.' : detail.reasons.join('; ')}</p>
            {detail.files !== undefined && <p className="help">Доступ ограничен {detail.files} файлами (перенесено из прежних «Файлов проекта»).
              {c?.canManage && <> <button type="button" className="secondary" disabled={pending} onClick={() => void grant(c, detail.profileId, true, { allFiles: true }).then(() => setDetail(undefined))}>Открыть всю папку</button></>}</p>}
            <div className="settings-actions"><button type="button" className="secondary" onClick={() => setDetail(undefined)}>Закрыть</button></div>
          </div>;
        })()}
      </>}
    </div>}
  </WorkspaceDialog>;
}
