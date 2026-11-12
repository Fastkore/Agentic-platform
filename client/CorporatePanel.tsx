import { Select } from './Select';
import { SettingsAction } from './SettingsAction';
import React, { useEffect, useState } from 'react';
import type { AgentProfile, Dataset, WorkRole } from '../shared/types';
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export const operations: Record<string, string> = { chat: 'Обсуждение проекта', estimate: 'Расчёт и КП', technology: 'Технология', accounting: 'Бухгалтерская операция' };
export function CorporatePanel({ request, section }: { request: Request; section: 'roles' | 'datasets' }) {
  const [roles, setRoles] = useState<WorkRole[]>([]), [profiles, setProfiles] = useState<AgentProfile[]>([]), [datasets, setDatasets] = useState<Dataset[]>([]);
  const [editing, setEditing] = useState<WorkRole | Dataset | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  async function load() {
    const [r, p, d] = await Promise.all([
      section === 'roles' ? request<WorkRole[]>('/api/admin/roles') : [],
      section === 'roles' ? request<AgentProfile[]>('/api/admin/profiles') : [],
      request<Dataset[]>('/api/admin/datasets'),
    ]);
    setRoles(r); setProfiles(p); setDatasets(d); setLoaded(true);
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, [section]);
  function change(next: Record<string, unknown>) { setEditing(old => old ? { ...old, ...next } : old); }
  function create() {
    setError(''); setNotice('');
    setEditing(section === 'roles' ? { id: '', name: '', enabled: true, profileIds: ['universal'], operationIds: ['chat'], readDatasetIds: [], instructions: '', revision: 0 }
      : { id: '', name: '', directory: '', projectIds: [], classification: 'restricted', revision: 0 });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!editing) return; setBusy(true); setError(''); setNotice('');
    try {
      const { id, revision, ...body } = editing;
      await request(`/api/admin/${section}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...(revision ? { revision } : {}) }) });
      await load(); setEditing(null); setNotice('Настройки сохранены.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const role = section === 'roles' ? editing as WorkRole | null : null, dataset = section === 'datasets' ? editing as Dataset | null : null;
  const entries = section === 'roles' ? roles : datasets;
  const addLabel = section === 'roles' ? 'Добавить роль' : 'Добавить источник';
  return <>
    {!loaded && !error && <p role="status">Загрузка…</p>}
    {!editing && loaded && <>
      <div className="settings-list-toolbar"><button className="primary" onClick={create}>{addLabel}</button></div>
      {entries.length ? <ul className="settings-records">
        {entries.map(item => <li key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <small>{section === 'roles' && item.id === 'sso_pending' ? 'Служебная роль' : 'enabled' in item
              ? item.enabled ? 'Включено' : 'Выключено' : item.classification === 'restricted' ? 'Закрытый источник' : 'Общий источник'}</small>
          </div>
          {(section !== 'roles' || item.id !== 'sso_pending') && <button className="secondary" onClick={() => { setEditing({ ...item }); setNotice(''); setError(''); }}>Настроить</button>}
        </li>)}
      </ul> : <p className="help">Источников пока нет.</p>}
    </>}
    {editing && <SettingsAction title={editing.revision ? 'Редактирование' : addLabel}><form onSubmit={e => void save(e)}>
      {!editing.revision && <><label htmlFor="config-id">Идентификатор · латиница</label><input id="config-id" pattern="[a-z][a-z0-9_\-]{1,63}" value={editing.id} required onChange={e => change({ id: e.target.value })} /></>}
      <label htmlFor="config-name">Название</label><input id="config-name" maxLength={100} required value={editing.name} onChange={e => change({ name: e.target.value })} />
      {role && <label className="check-setting"><input type="checkbox" checked={role.enabled} onChange={e => change({ enabled: e.target.checked })} />Роль включена</label>}
      {role && <><label htmlFor="config-rules">Инструкции рабочей роли</label><textarea id="config-rules" rows={8} maxLength={20000} value={role.instructions} onChange={e => change({ instructions: e.target.value })} /><Checks label="Разрешённые операции" values={role.operationIds} options={Object.entries(operations).map(([id, name]) => ({ id, name }))} change={operationIds => change({ operationIds })} /><Checks label="Доступные агенты" values={role.profileIds} options={profiles} change={profileIds => change({ profileIds })} /><Checks label="Право чтения исходных библиотек" values={role.readDatasetIds} options={datasets} change={readDatasetIds => change({ readDatasetIds })} /></>}
      {dataset && <><label htmlFor="dataset-directory">Папка на сервере</label><input id="dataset-directory" required maxLength={2000} value={dataset.directory} onChange={e => change({ directory: e.target.value })} /><label htmlFor="dataset-class">Доступ к источнику</label><Select id="dataset-class" className="settings-select" value={dataset.classification} onChange={classification => change({ classification })} options={[{ value: 'restricted', label: 'Закрытый источник' }, { value: 'shared', label: 'Общий источник' }]} />{dataset.classification === 'restricted' && <p role="status" className="help">Закрытый источник приостановит запуски Codex.</p>}</>}
      <div className="settings-dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(null); setError(''); }}>Отмена</button><button className="primary" disabled={busy}>Сохранить</button></div>
    </form></SettingsAction>}
    {error && <div className="inline-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}</>;
}
export function Checks({ label, values, options, change }: { label: string; values: string[]; options: { id: string; name: string }[]; change: (values: string[]) => void }) {
  return <fieldset className="config-checks"><legend>{label}</legend>{options.length ? options.map(item => <label className="check-setting" key={item.id}><input type="checkbox" checked={values.includes(item.id)} onChange={e => change(e.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} />{item.name}</label>) : <p className="help">Пока нет записей.</p>}</fieldset>;
}
