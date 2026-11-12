import { useEffect, useState } from 'react';
import { Clock3, Search, ShieldCheck, Trash2, Users } from 'lucide-react';
import type { FastkoreRoleSummary } from '../shared/types';
import { Select } from './Select';
import { SettingsAction } from './SettingsAction';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export function ErpRolesPanel({ request }: { request: Request }) {
  const [roles, setRoles] = useState<FastkoreRoleSummary[]>();
  const [search, setSearch] = useState(''), [installation, setInstallation] = useState('all');
  const [removing, setRemoving] = useState<FastkoreRoleSummary | null>(null);
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
          <button className="secondary" onClick={() => { setRemoving(role); setError(''); }} aria-label={'Удалить роль ' + role.name}><Trash2 size={16} />Удалить</button>
        </div>
        <div className="erp-role-meta"><span><Users size={16} />Пользователи · {role.userCount}</span><span><Clock3 size={16} />Получено · <time dateTime={role.lastSeenAt}>{new Date(role.lastSeenAt).toLocaleString('ru-RU')}</time></span></div>
      </li>)}</ul>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
