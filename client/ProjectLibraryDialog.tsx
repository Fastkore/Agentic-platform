import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Info, Plus, RefreshCw } from 'lucide-react';
import type { ProjectSummary } from '../shared/types';
import type { LibraryCell, LibraryConnection, LibraryFolderSummary, OutputPolicy, ProjectLibraryView } from '../shared/library';
import { Select } from './Select';
import { PermissionSwitch } from './PermissionSwitch';
import type { Request } from './library-upload';
import { folderLine, LibraryFolderCard } from './LibraryFolderCard';
import { emptyFolderDraft, FolderForm, outputModes, profileLabels } from './LibraryPanel';
import './specialists.css';
import './library.css';

const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }));

/** Project → Library: the project's folders, their state and access of specialists; the same server rule decides for the agent. */
export function ProjectLibraryPanel({ project, request, section, isAdmin, initialProfileId, pendingChanged }: {
  project: ProjectSummary; request: Request; section: 'folders' | 'access'; isAdmin: boolean; initialProfileId?: string; pendingChanged: (pending: boolean) => void;
}) {
  const base = '/api/projects/' + encodeURIComponent(project.id) + '/library';
  const [view, setView] = useState<ProjectLibraryView>();
  const [folders, setFolders] = useState<LibraryFolderSummary[]>([]);
  const [expanded, setExpanded] = useState<string>();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyFolderDraft);
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
    setPending(true); pendingChanged(true); setError('');
    try { await work(); await load(); } catch (e) { await load(); setError((e as Error).message); } finally { setPending(false); pendingChanged(false); }
  }
  const update = (c: LibraryConnection, patch: Record<string, unknown>) =>
    act(() => request(`${base}/${c.folderId}`, { method: 'PATCH', body: JSON.stringify({ revision: c.revision, ...patch }) }));
  const grant = (c: LibraryConnection, profileId: string, enabled: boolean, extra: Record<string, unknown> = {}) =>
    act(() => request(`${base}/${c.folderId}/grants`, { method: 'PUT', body: JSON.stringify({ profileId, enabled, revision: c.revision, ...extra }) }));
  const profiles = view?.profiles.filter(p => !profileFilter || p.id === profileFilter) ?? [];
  const matches = (name: string) => name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'));

  return <div className="project-library-settings">
    <div className="project-agents-intro">
      <strong>{section === 'folders' ? 'Папки библиотеки' : 'Доступ агентов к папкам'}</strong>
      <span className="project-specialist-actions">
        <button type="button" className="workspace-icon" title="Обновить" aria-label="Обновить" disabled={pending} onClick={() => void load()}><RefreshCw size={16} /></button>
        {section === 'folders' && isAdmin && <button type="button" className="secondary" aria-expanded={creating} onClick={() => setCreating(!creating)}><Plus size={16} aria-hidden="true" />Новая папка</button>}
      </span>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!view && !error && <p role="status">Загрузка…</p>}
    {view && <div className="library-panel">

      {section === 'folders' && <>
        {creating && <form className="agent-card library-form" onSubmit={e => { e.preventDefault(); void act(async () => {
          const created = await request<LibraryFolderSummary>('/api/library', { method: 'POST', body: JSON.stringify(draft) });
          await request(base, { method: 'POST', body: JSON.stringify({ folderId: created.id }) });
          setCreating(false); setExpanded(created.id); setDraft(emptyFolderDraft);
        }); }}>
          <FolderForm draft={draft} setDraft={setDraft} isAdmin={isAdmin} />
          <p className="help">Папка появится в общей библиотеке и подключится к проекту. Агент начнёт её использовать после загрузки материалов и назначения агентам.</p>
          <div className="settings-actions">
            <button type="submit" className="primary" disabled={pending || !draft.name.trim()}>Создать и подключить</button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>Отмена</button>
          </div>
        </form>}
        <input type="search" aria-label="Поиск по папкам библиотеки" placeholder="Поиск по папкам библиотеки…" value={search}
          onChange={event => setSearch(event.target.value)} />
        {view.connections.some(c => matches(c.folderName)) || view.available.some(f => matches(f.name)) ? <ul className="settings-records project-library-connections">{view.connections.filter(c => matches(c.folderName)).map(c => {
          const folder = folders.find(f => f.id === c.folderId);
          const assigned = view.cells.filter(cell => cell.folderId === c.folderId && cell.granted).map(cell => view.profiles.find(p => p.id === cell.profileId)?.name).filter(Boolean);
          const open = expanded === c.folderId;
          return <li key={c.folderId}>
            <div className="project-library-row">
              <label><input type="checkbox" checked={c.enabled} disabled={pending || !c.canManage}
                onChange={event => void update(c, { enabled: event.currentTarget.checked })} />{c.folderName}</label>
              <button type="button" className="workspace-icon" aria-label={'Подробности папки «' + c.folderName + '»'} title="Подробности"
                aria-expanded={open} onClick={() => setExpanded(open ? undefined : c.folderId)}>
                {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              </button>
            </div>
            {open && <div className="project-library-details">
            <div className="library-card-body">
              <p className="help">{c.folderActive ? 'Активна' : 'Неактивна'} · {profileLabels[c.profile]} · {outputModes[c.outputPolicy]}</p>
              {c.description && <p className="help">{c.description}</p>}
              <p className="help">{folder ? folderLine(folder) : c.current ? `${c.current.files.toLocaleString('ru')} файлов` : 'Материалов пока нет'}</p>
              {c.folderActive && c.classification === 'restricted' && <p className="library-warning">Для этой папки также действуют правила закрытого анализа.</p>}
              <p className="help">Агенты: {assigned.length ? assigned.join(', ') : 'не назначены — агент папку не использует'}</p>
            </div>
            {open && folder && <LibraryFolderCard request={request} folder={folder} isAdmin={isAdmin} reload={reload} />}
            {c.canManage && <div className="settings-actions library-card-actions">
              <Select className="settings-select" label="Режим выдачи" value={c.outputPolicy} options={options(outputModes)} disabled={pending} fitContent
                onChange={outputPolicy => void update(c, { outputPolicy })} />
              <button type="button" className="secondary" disabled={pending} onClick={() => {
                if (confirm(`Отключить «${c.folderName}» от проекта? Папка останется в библиотеке для других проектов.`)) void act(() => request(`${base}/${c.folderId}?revision=${c.revision}`, { method: 'DELETE' }));
              }}>Убрать из проекта</button>
            </div>}
            </div>}
          </li>;
        })}{view.available.filter(f => matches(f.name)).map(f => <li key={f.id}>
          <div className="project-library-row"><label><input type="checkbox" checked={false} disabled={pending}
            onChange={() => void act(() => request(base, { method: 'POST', body: JSON.stringify({ folderId: f.id }) }))} />{f.name}</label></div>
        </li>)}</ul> : <p className="help">{search.trim() ? 'Папки не найдены.' : 'Доступных папок пока нет.'}</p>}
      </>}

      {section === 'access' && <>
        <div className="library-field-row library-filter">
          <label htmlFor="library-profile-filter">Агент</label>
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
        </table></div> : <p className="help">Сначала подключите папки в разделе «Библиотека».</p>}
        {detail && (() => {
          const c = view.connections.find(x => x.folderId === detail.folderId);
          const p = view.profiles.find(x => x.id === detail.profileId);
          return <div className="agent-card library-detail" role="status">
            <strong>{c?.folderName} — {p?.name}</strong>
            <p className="help">{detail.allowed ? 'Агент может использовать папку.' : detail.reasons.join('; ')}</p>
            {detail.files !== undefined && <p className="help">Доступ ограничен {detail.files} файлами (перенесено из прежних «Файлов проекта»).
              {c?.canManage && <> <button type="button" className="secondary" disabled={pending} onClick={() => void grant(c, detail.profileId, true, { allFiles: true }).then(() => setDetail(undefined))}>Открыть всю папку</button></>}</p>}
            <div className="settings-actions"><button type="button" className="secondary" onClick={() => setDetail(undefined)}>Закрыть</button></div>
          </div>;
        })()}
      </>}
    </div>}
  </div>;
}
