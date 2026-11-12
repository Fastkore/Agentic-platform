import { Select } from './Select';
import React, { useEffect, useState } from 'react';
import { agentToolIds, agentTools } from '../shared/agent-tools';
import type { AgentProfile, Dataset, WorkRole } from '../shared/types';
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const operations: Record<string, string> = { chat: 'Обсуждение проекта', estimate: 'Расчёт и КП', technology: 'Технология', accounting: 'Бухгалтерская операция' };
export function CorporatePanel({ request, onSaved }: { request: Request; onSaved?: () => void }) {
  const [roles, setRoles] = useState<WorkRole[]>([]), [profiles, setProfiles] = useState<(AgentProfile & { unavailableReason?: string })[]>([]), [datasets, setDatasets] = useState<Dataset[]>([]);
  const [tab, setTab] = useState<'roles' | 'profiles' | 'datasets'>('roles'), [editing, setEditing] = useState<WorkRole | AgentProfile | Dataset | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function load() { const [r, p, d] = await Promise.all([request<WorkRole[]>('/api/admin/roles'), request<AgentProfile[]>('/api/admin/profiles'), request<Dataset[]>('/api/admin/datasets')]); setRoles(r); setProfiles(p); setDatasets(d); }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  function change(next: Record<string, unknown>) { setEditing(old => old ? { ...old, ...next } : old); }
  function create() {
    setError(''); setNotice('');
    setEditing(tab === 'roles' ? { id: '', name: '', enabled: true, profileIds: ['universal'], operationIds: ['chat'], readDatasetIds: [], instructions: '', revision: 0 }
      : tab === 'profiles' ? { id: '', name: '', description: '', instructions: '', enabled: false, model: '', reasoningEffort: 'high', operationIds: ['chat'], datasetIds: [], skillIds: [], allowWrite: false, outputMode: 'chat', revision: 0, toolIds: [] }
      : { id: '', name: '', directory: '', projectIds: [], classification: 'restricted', revision: 0 });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!editing) return; setBusy(true); setError(''); setNotice('');
    try {
      const { id, revision, ...body } = editing;
      // Public UI status is not part of the editable profile contract.
      delete (body as Record<string, unknown>).unavailableReason;
      await request(`/api/admin/${tab}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...(revision ? { revision } : {}) }) });
      await load(); onSaved?.(); setEditing(null); setNotice('Настройки сохранены.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const role = tab === 'roles' ? editing as WorkRole | null : null, profile = tab === 'profiles' ? editing as AgentProfile | null : null, dataset = tab === 'datasets' ? editing as Dataset | null : null;
  return <>
    <div className="config-tabs" role="tablist" aria-label="Настройки работы">{([['roles', 'Роли'], ['profiles', 'Агенты'], ['datasets', 'Источники']] as const).map(([id, label]) => <button role="tab" aria-selected={tab === id} key={id} onClick={() => { setTab(id); setEditing(null); setError(''); }}>{label}</button>)}</div>
    {!editing && tab === 'profiles' && <div className="agent-catalog">
      <div className="agent-catalog-header">
        <p>Настройте агента здесь, затем подключите его в нужных проектах.</p>
        <button className="primary" onClick={create}>Добавить агента</button>
      </div>
      <ul className="agent-card-list" aria-label="Агенты">
        {profiles.map(item => <li className="agent-card" key={item.id}>
          <div className="agent-card-heading">
            <div><strong>{item.name}</strong>{item.description && <p>{item.description}</p>}</div>
            <button className="secondary" onClick={() => setEditing({ ...item })}>Настроить</button>
          </div>
          <p className="agent-card-meta">{item.enabled ? 'Включён' : 'Выключен'} · {agentTools.filter(tool => (item.toolIds ?? agentToolIds).includes(tool.id)).map(tool => tool.name).join(', ') || 'Без инструментов'}</p>
          {item.enabled && item.unavailableReason && <p className="help">{item.unavailableReason}</p>}
        </li>)}
      </ul>
    </div>}
    {!editing && tab !== 'profiles' && <><button className="secondary w-full" onClick={create}>Добавить {tab === 'roles' ? 'роль' : 'источник'}</button><div className="access-list">{(tab === 'roles' ? roles : datasets).map(item => <div className="access-user" key={item.id}><b>{item.name}</b><small>{item.id}{'enabled' in item ? item.enabled ? ' · включён' : ' · выключен' : ` · ${item.classification === 'restricted' ? 'закрытый' : 'общий'}`}</small><button className="secondary w-full" onClick={() => setEditing({ ...item })}>Настроить</button></div>)}</div></>}
    {editing && <form className={profile ? 'agent-profile-form' : undefined} onSubmit={e => void save(e)}>
      {(!profile || !editing.revision) && <><label htmlFor="config-id">Постоянный идентификатор · латиница</label><input id="config-id" pattern="[a-z][a-z0-9_-]{1,63}" value={editing.id} disabled={!!editing.revision} required onChange={e => change({ id: e.target.value })} /></>}
      <label htmlFor="config-name">Название</label><input id="config-name" maxLength={100} required value={editing.name} onChange={e => change({ name: e.target.value })} />
      {profile && <><label htmlFor="profile-description">Назначение</label><input id="profile-description" maxLength={1000} value={profile.description} onChange={e => change({ description: e.target.value })} /></>}
      {(role || profile) && <label className="check-setting agent-profile-enabled"><input type="checkbox" checked={(role ?? profile)!.enabled} onChange={e => change({ enabled: e.target.checked })} />{role ? 'Роль включена' : 'Агент включён'}</label>}
      {role && <><label htmlFor="config-rules">Инструкции рабочей роли</label><textarea id="config-rules" rows={8} maxLength={20000} value={role.instructions} onChange={e => change({ instructions: e.target.value })} /><Checks label="Разрешённые операции" values={role.operationIds} options={Object.entries(operations).map(([id, name]) => ({ id, name }))} change={operationIds => change({ operationIds })} /><Checks label="Доступные агенты" values={role.profileIds} options={profiles} change={profileIds => change({ profileIds })} /><Checks label="Право чтения исходных библиотек" values={role.readDatasetIds} options={datasets} change={readDatasetIds => change({ readDatasetIds })} /></>}
      {profile && <>
        <div className="agent-profile-config">
          <div>
            <label htmlFor="config-rules">Инструкции агента</label>
            <textarea id="config-rules" rows={8} maxLength={20000} value={profile.instructions}
              placeholder="Опишите задачу, порядок действий и ожидаемый результат." onChange={e => change({ instructions: e.target.value })} />
          </div>
          <fieldset className="agent-tool-list">
            <legend>Инструменты агента</legend>
            <p className="help">В проекте можно дополнительно ограничить источники.</p>
            {agentTools.map(tool => {
              const selected = profile.toolIds ?? agentToolIds;
              return <label className="agent-tool-choice" key={tool.id}>
                <input type="checkbox" checked={selected.includes(tool.id)} onChange={e => change({ toolIds: e.target.checked ? [...selected, tool.id] : selected.filter(id => id !== tool.id) })} />
                <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
              </label>;
            })}
          </fieldset>
        </div>
        <details className="agent-advanced"><summary>Модель и дополнительные настройки</summary>
          <label htmlFor="profile-model">Модель · пусто означает выбор диалога</label><input id="profile-model" maxLength={128} value={profile.model} onChange={e => change({ model: e.target.value })} />
          <label htmlFor="profile-effort">Уровень рассуждения</label><Select id="profile-effort" className="settings-select" value={profile.reasoningEffort} onChange={reasoningEffort => change({ reasoningEffort })} options={[{ value: 'low', label: 'Низкий' }, { value: 'medium', label: 'Средний' }, { value: 'high', label: 'Высокий' }, { value: 'xhigh', label: 'Очень высокий' }]} />
          <Checks label="Разрешённые операции" values={profile.operationIds} options={Object.entries(operations).map(([id, name]) => ({ id, name }))} change={operationIds => change({ operationIds })} />
          <label htmlFor="profile-output">Выдача результата</label><Select id="profile-output" className="settings-select" value={profile.outputMode} onChange={outputMode => change({ outputMode })} options={[{ value: 'chat', label: 'Обычный чат проекта' }, { value: 'restricted', label: 'Проверяемый результат закрытой операции' }]} />
          <label className="check-setting"><input type="checkbox" checked={profile.allowWrite} onChange={e => change({ allowWrite: e.target.checked })} />Разрешить запись, если она включена на сервере</label>
          <Checks label="Библиотеки агента" values={profile.datasetIds} options={datasets} change={datasetIds => change({ datasetIds })} />
          <label htmlFor="profile-skills">Идентификаторы утверждённых Skills · через запятую</label><input id="profile-skills" value={profile.skillIds.join(', ')} onChange={e => change({ skillIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
        </details>
      </>}
      {dataset && <><label htmlFor="dataset-directory">Папка на сервере</label><input id="dataset-directory" required maxLength={2000} value={dataset.directory} onChange={e => change({ directory: e.target.value })} /><label htmlFor="dataset-class">Доступ к источнику</label><Select id="dataset-class" className="settings-select" value={dataset.classification} onChange={classification => change({ classification })} options={[{ value: 'restricted', label: 'Закрытый источник' }, { value: 'shared', label: 'Общий источник' }]} />{dataset.classification === 'restricted' && <p role="status" className="help">Закрытый источник приостановит запуски Codex.</p>}</>}
      <div className="button-pair"><button className="primary" disabled={busy}>Сохранить</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Отмена</button></div></form>}
    {error && <div className="inline-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}</>;
}
function Checks({ label, values, options, change }: { label: string; values: string[]; options: { id: string; name: string }[]; change: (values: string[]) => void }) {
  return <fieldset className="config-checks"><legend>{label}</legend>{options.length ? options.map(item => <label className="check-setting" key={item.id}><input type="checkbox" checked={values.includes(item.id)} onChange={e => change(e.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} />{item.name}</label>) : <p className="help">Пока нет записей.</p>}</fieldset>;
}
