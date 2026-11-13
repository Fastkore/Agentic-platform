import { useEffect, useState } from 'react';
import { Clock3, Search, ShieldCheck, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import type { FastkoreRoleSummary, FastkoreRolePermissions } from '../shared/types';
import { Select } from './Select';
import { SettingsAction } from './SettingsAction';
import { WorkspaceDialog } from './WorkspaceDialog';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export function ErpRolesPanel({ request }: { request: Request }) {
  const [roles, setRoles] = useState<FastkoreRoleSummary[]>();
  const [search, setSearch] = useState(''), [installation, setInstallation] = useState('all');
  const [removing, setRemoving] = useState<FastkoreRoleSummary | null>(null);
  const [editing, setEditing] = useState<FastkoreRoleSummary | null>(null);
  const [permissions, setPermissions] = useState<FastkoreRolePermissions>({ mcp: true, cli: true, revision: 0 });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<FastkoreRoleSummary[]>('/api/admin/erp-roles', { signal: controller.signal })
      .then(setRoles).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [request]);
  async function remove() {
    if (!removing || busy) return;
    setBusy(true); setError('');
    try {
      await request('/api/admin/erp-roles/' + encodeURIComponent(removing.installationId) + '/' + encodeURIComponent(removing.id), { method: 'DELETE' });
      setRoles(items => items?.filter(role => role.installationId !== removing.installationId || role.id !== removing.id));
      setRemoving(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function savePermissions() {
    if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      const saved = await request<FastkoreRolePermissions>('/api/admin/erp-roles/' + encodeURIComponent(editing.installationId) + '/' + encodeURIComponent(editing.id) + '/permissions', {
        method: 'PATCH', body: JSON.stringify(permissions),
      });
      setRoles(items => items?.map(role => role.id === editing.id && role.installationId === editing.installationId ? { ...role, permissions: saved } : role));
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const query = search.trim().toLocaleLowerCase('ru-RU');
  const filtered = roles?.filter(role => (installation === 'all' || role.installationId === installation)
    && (!query || (role.name + ' ' + role.installationName).toLocaleLowerCase('ru-RU').includes(query)));
  const sources = new Map(roles?.map(role => [role.installationId, role.installationName]));
  return <div className="erp-roles-panel">
    {removing ? <SettingsAction title="Удалить роль из списка">
      <p>Удалить «{removing.name}»? При следующем входе сотрудника Fastkore сможет передать эту роль снова.</p>
      <div className="settings-dialog-actions">
        <button className="secondary" disabled={busy} onClick={() => { setRemoving(null); setError(''); }}>Отмена</button>
        <button className="primary" disabled={busy} onClick={() => void remove()}>Удалить</button>
      </div>
    </SettingsAction> : <>
      <p className="roles-intro">Роли поступают из Fastkore при входе сотрудников. Здесь собраны роли подключённых установок.</p>
      <div className="roles-filters">
        <div className="audit-search"><Search size={18} aria-hidden="true" /><input aria-label="Поиск по ролям" placeholder="Поиск по ролям…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <Select label="Установка Fastkore" className="settings-select" value={installation} onChange={setInstallation}
          options={[{ value: 'all', label: 'Все установки' }, ...[...sources].map(([value, label]) => ({ value, label }))]} />
      </div>
      {!roles && !error && <p role="status">Загрузка…</p>}
      {filtered && !filtered.length && <p role="status">{roles?.length ? 'По выбранным условиям ролей нет.' : 'Роли появятся после входа сотрудников из Fastkore.'}</p>}
      <ul className="erp-role-cards">{filtered?.map(role => <li key={role.installationId + '/' + role.id}>
        <div className="erp-role-heading"><span className="erp-role-icon"><ShieldCheck size={25} aria-hidden="true" /></span>
          <div><h3>{role.name}</h3><p>{role.installationName}</p></div>
          <span className="erp-role-permission-summary">MCP {role.permissions?.mcp === false ? 'выключен' : 'включён'} · CLI {role.permissions?.cli === false ? 'выключен' : 'включён'}</span>
          <button className="secondary" onClick={() => { setEditing(role); setPermissions(role.permissions ?? { mcp: true, cli: true, revision: 0 }); setError(''); }}><SlidersHorizontal size={16} />Настроить разрешения</button>
          <button className="secondary" onClick={() => { setRemoving(role); setError(''); }} aria-label={'Удалить роль ' + role.name}><Trash2 size={16} />Удалить</button>
        </div>
        <div className="erp-role-meta"><span><Users size={16} />Пользователи · {role.userCount}</span><span><Clock3 size={16} />Получено · <time dateTime={role.lastSeenAt}>{new Date(role.lastSeenAt).toLocaleString('ru-RU')}</time></span></div>
      </li>)}</ul>
    </>}
    {editing && <WorkspaceDialog title={'Разрешения · ' + editing.name} close={() => { if (!busy) setEditing(null); }} className="erp-role-permissions-dialog">
      <p className="help">Доступ также должен быть включён у специалиста и в проекте. Права на данные и изменения проверяет Fastkore от имени сотрудника.</p>
      <label className="check-setting"><input type="checkbox" checked={permissions.mcp} disabled={busy} onChange={e => setPermissions(old => ({ ...old, mcp: e.target.checked }))} />Fastkore MCP</label>
      <label className="check-setting"><input type="checkbox" checked={permissions.cli} disabled={busy} onChange={e => setPermissions(old => ({ ...old, cli: e.target.checked }))} />Fastkore CLI</label>
      <p className="help">Если у сотрудника несколько ролей, достаточно разрешения в одной из них. Новые роли по умолчанию допускают оба подключения.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="settings-dialog-actions"><button className="secondary" disabled={busy} onClick={() => setEditing(null)}>Отмена</button><button className="primary" disabled={busy} onClick={() => void savePermissions()}>Сохранить</button></div>
    </WorkspaceDialog>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
