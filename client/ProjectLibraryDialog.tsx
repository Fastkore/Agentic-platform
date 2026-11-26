import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { InfoHint } from './InfoHint';
import type { ProjectSummary } from '../shared/types';
import type { LibraryConnection, LibraryFolderSummary, OutputPolicy, ProjectLibraryView } from '../shared/library';
import { SettingsTabStrip } from './SettingsTabs';
import { SettingsSpinner } from './SettingsSpinner';
import { Select } from './Select';
import { PermissionSwitch } from './PermissionSwitch';
import { formatFileCount, type Request } from './library-upload';
import { folderLine, LibraryFolderCard, useLibraryRefresh } from './LibraryFolderCard';
import { CreateLibraryForm, LibraryToolbar, LibraryRemovalDialog, libraryTabCounts, libraryTabs, LibraryKindIcon, type LibraryKind, outputModes, profileLabels } from './LibraryPanel';
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
  const [removing, setRemoving] = useState<LibraryConnection>();
  const [expanded, setExpanded] = useState<string>();
  const [search, setSearch] = useState('');
  const tabId = useId();
  const [tab, setTab] = useState<LibraryKind>('s3');
  const [creating, setCreating] = useState<LibraryKind>();
  const [profileFilter, setProfileFilter] = useState(initialProfileId ?? '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([request<ProjectLibraryView>(base), request<LibraryFolderSummary[]>('/api/library')]);
      setView(next); setFolders(list);
    } catch (e) { setError((e as Error).message); }
  }, [base, request]);
  useEffect(() => { void load(); }, [load]);
  useLibraryRefresh(folders, load);
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

  const foldersById = new Map(folders.map(f => [f.id, f]));
  const listedIds = view && new Set([...view.connections.map(c => c.folderId), ...view.available.map(f => f.id)]);
  const inTab = (id: string) => !!foldersById.get(id)?.external === (tab === 'external');
  const connections = view?.connections.filter(c => inTab(c.folderId) && matches(c.folderName)) ?? [];
  const available = view?.available.filter(f => inTab(f.id) && matches(f.name)) ?? [];
  return <div className="project-library-settings">
    <div className="project-agents-intro">
      {section === 'folders' ? <SettingsTabStrip sections={libraryTabs} value={tab} id={tabId} label="Библиотеки проекта"
        counts={listedIds && libraryTabCounts(folders.filter(f => listedIds.has(f.id)))}
        className="library-tabs" panelId={key => tabId + key + '-panel'} disabled={pending}
        select={key => { setTab(key); setCreating(undefined); setSearch(''); }} /> : <strong>Доступ агентов к папкам</strong>}
      <span className="project-specialist-actions">
        <button type="button" className="workspace-icon" title="Обновить" aria-label="Обновить" disabled={pending} onClick={() => void load()}><RefreshCw size={16} /></button>
      </span>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!view && !error && <SettingsSpinner label="Загрузка библиотек…" />}
    {view && <div className="library-panel">

      {section === 'folders' && <div className="library-panel" role="tabpanel" id={tabId + tab + '-panel'} aria-labelledby={tabId + tab}>
        <LibraryToolbar kind={tab} search={search} setSearch={setSearch} creating={!!creating} pending={pending}
          toggleCreate={isAdmin ? () => { setError(''); setCreating(creating ? undefined : tab); } : undefined} />
        {creating && <CreateLibraryForm key={creating} kind={creating} error={error} request={request} pending={pending} project cancel={() => setCreating(undefined)} submit={create => void act(async () => {
          const created = await create();
          setCreating(undefined);
          await request(base, { method: 'POST', body: JSON.stringify({ folderId: created.id }) });
          if (created.external) { setTab('external'); setExpanded(undefined); setSearch(''); }
          else setExpanded(created.id);
        })} />}
        {connections.length || available.length ? <ul className="settings-records project-library-connections">{connections.map(c => {
          const folder = foldersById.get(c.folderId);
          const assigned = view.cells.filter(cell => cell.folderId === c.folderId && cell.granted).map(cell => view.profiles.find(p => p.id === cell.profileId)?.name).filter(Boolean);
          const open = expanded === c.folderId;
          return <li key={c.folderId}>
            <div className="project-library-row">
              <label><input type="checkbox" checked={c.enabled} disabled={pending || !c.canManage}
                onChange={event => void update(c, { enabled: event.currentTarget.checked })} /><LibraryKindIcon external={!!folder?.external} />{c.folderName}</label>
              {c.enabled && !assigned.length && <small className="library-warning" title="Назначьте папку чату проекта или специалистам на вкладке «Доступ»">Не назначена агентам</small>}
              <button type="button" className="workspace-icon" aria-label={'Подробности папки «' + c.folderName + '»'} title="Подробности"
                aria-expanded={open} onClick={() => setExpanded(open ? undefined : c.folderId)}>
                {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              </button>
            </div>
            {open && <div className="project-library-details">
            <div className="library-card-body">
              <p className="help">{c.folderActive ? 'Активна' : 'Неактивна'} · {profileLabels[c.profile]} · {outputModes[c.outputPolicy]}</p>
              {c.description && <p className="help">{c.description}</p>}
              <p className="help">{folder ? folderLine(folder) : c.current ? formatFileCount(c.current.files) : 'Материалов пока нет'}</p>
              {c.folderActive && c.classification === 'restricted' && <p className="library-warning">Для этой папки также действуют правила закрытого анализа.</p>}
              <p className="help">Агенты: {assigned.length ? assigned.join(', ') : 'не назначены — агент папку не использует'}</p>
            </div>
            {open && folder && <LibraryFolderCard request={request} folder={folder} isAdmin={isAdmin} reload={reload} />}
            {c.canManage && <div className="settings-actions library-card-actions">
              <Select className="settings-select" label="Режим выдачи" value={c.outputPolicy} options={options(outputModes)} disabled={pending} fitContent
                onChange={outputPolicy => void update(c, { outputPolicy })} />
              <button type="button" className="secondary" disabled={pending} onClick={() => setRemoving(c)}>Убрать из проекта</button>
            </div>}
            </div>}
          </li>;
        })}{available.map(f => <li key={f.id}>
          <div className="project-library-row"><label><input type="checkbox" checked={false} disabled={pending}
            onChange={() => void act(() => request(base, { method: 'POST', body: JSON.stringify({ folderId: f.id }) }))} /><LibraryKindIcon external={!!foldersById.get(f.id)?.external} />{f.name}</label></div>
        </li>)}</ul> : <p className="help">{search.trim() ? 'Папки не найдены.' : tab === 'external' ? 'Внешних библиотек пока нет.' : 'Обычных библиотек пока нет.'}</p>}
      </div>}

      {section === 'access' && <>
        <div className="library-field-row library-filter">
          <label htmlFor="library-profile-filter">Агент</label>
          <Select id="library-profile-filter" className="settings-select" value={profileFilter} fitContent
            options={[{ value: '', label: 'Все подключённые' }, ...view.profiles.map(p => ({ value: p.id, label: p.name }))]} onChange={setProfileFilter} />
        </div>
        {view.connections.length ? <div className="library-matrix-wrap"><table className="library-matrix">
          <thead><tr><th scope="col">Папка</th>{profiles.map(p => <th key={p.id} scope="col">{p.name}</th>)}</tr></thead>
          <tbody>{view.connections.map(c => <tr key={c.folderId}>
            <th scope="row"><strong>{c.folderName}</strong><small>{c.current ? formatFileCount(c.current.files) : 'пусто'}</small></th>
            {profiles.map(p => {
              const cell = view.cells.find(x => x.folderId === c.folderId && x.profileId === p.id)!;
              return <td key={p.id} data-state={cell.allowed ? 'allowed' : cell.granted ? 'blocked' : 'off'}>
                <span className="library-cell">
                  <PermissionSwitch name={`${c.folderName} — ${p.name}`} checked={cell.granted} disabled={pending || !c.canManage} onChange={checked => void grant(c, p.id, checked)} />
                  <span>{cell.granted ? (cell.allowed ? outputModes[cell.outputPolicy!] + (cell.files !== undefined ? ` · ${formatFileCount(cell.files)}` : '') : 'Недоступно') : 'Нет доступа'}</span>
                  <InfoHint label={'Доступ: ' + c.folderName + ' — ' + p.name}>
                    {cell.allowed ? 'Агент может использовать папку.' : cell.reasons.join('; ')}
                    {cell.files !== undefined && ' Разрешено материалов: ' + formatFileCount(cell.files) + '.'}
                  </InfoHint>
                  {cell.files !== undefined && c.canManage && <button type="button" className="secondary" disabled={pending}
                    onClick={() => void grant(c, p.id, true, { allFiles: true })}>Открыть всю папку</button>}
                </span>
              </td>;
            })}
          </tr>)}</tbody>
        </table></div> : <p className="help">Сначала подключите папки на вкладке «Библиотеки».</p>}
      </>}
    </div>}
    {removing && <LibraryRemovalDialog title="Убрать из проекта" name={removing.folderName}
      description="Библиотека останется доступна другим проектам." cancel={() => setRemoving(undefined)} confirm={() => {
        setRemoving(undefined);
        void act(() => request(`${base}/${removing.folderId}?revision=${removing.revision}`, { method: 'DELETE' }));
      }} />}
  </div>;
}
