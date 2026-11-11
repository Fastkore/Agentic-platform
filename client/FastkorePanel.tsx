import { useEffect, useState } from 'react';
import { Select } from './Select';
import type { ExternalIdentity, User } from '../shared/types';
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
interface Installation { id: string; name: string; enabled: boolean; configuredEnabled: boolean; entityTypes: string[] }
export function FastkorePanel({ request, users }: { request: Request; users: User[] }) {
  const [installations, setInstallations] = useState<Installation[]>([]), [identities, setIdentities] = useState<ExternalIdentity[]>([]);
  const [installationId, setInstallationId] = useState(''), [externalUserId, setExternalUserId] = useState(''), [userId, setUserId] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    const [i, e] = await Promise.all([request<Installation[]>('/api/admin/fastkore/installations'), request<ExternalIdentity[]>('/api/admin/fastkore/identities')]);
    setInstallations(i); setIdentities(e); setInstallationId(old => i.some(x => x.id === old) ? old : i[0]?.id ?? '');
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="setting-section"><h3>Вход из Fastkore</h3>
    {!installations.length ? <p className="help">Интеграция выключена.</p> : <>
      <div className="access-list">{installations.map(i => <div className="access-row" key={i.id}><span><b>{i.name}</b><small>{i.enabled ? 'Вход включён' : 'Вход выключен'} · {i.id}</small></span><button className="secondary" disabled={busy || !i.configuredEnabled} onClick={() => void run(async () => { await request(`/api/admin/fastkore/installations/${encodeURIComponent(i.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !i.enabled }) }); setNotice(i.enabled ? 'Доступ установки отключён. Её сеансы и ключи отозваны.' : 'Вход установки включён.'); })}>{i.enabled ? 'Отключить' : 'Включить'}</button></div>)}</div>
      <h4>Связать с существующей учётной записью</h4>
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await request('/api/admin/fastkore/identities', { method: 'PUT', body: JSON.stringify({ installationId, externalUserId, userId }) }); setExternalUserId(''); setNotice('Связь сохранена. Сотруднику нужно открыть помощника из ERP заново.'); }); }}>
        <label htmlFor="sso-installation">Установка Fastkore</label><Select id="sso-installation" className="settings-select" value={installationId} onChange={setInstallationId} options={installations.map(i => ({ value: i.id, label: i.name }))} />
        <label htmlFor="sso-external-user">ID сотрудника в ERP</label><input id="sso-external-user" value={externalUserId} maxLength={128} onChange={e => setExternalUserId(e.target.value)} required />
        <label htmlFor="sso-platform-user">Учётная запись платформы</label><Select id="sso-platform-user" className="settings-select" value={userId} onChange={setUserId} placeholder="Выберите сотрудника" options={users.filter(u => !u.disabled).map(u => ({ value: u.id, label: u.name + ' · ' + u.username }))} /><button className="secondary w-full" disabled={busy || !installationId || !userId}>Сохранить связь</button>
      </form>
    </>}
    {!!identities.length && <div className="access-list">{identities.map(i => <div className="access-row" key={`${i.installationId}:${i.externalUserId}`}><span><b>{users.find(u => u.id === i.userId)?.name ?? 'Неизвестная учётная запись'}</b><small>{i.installationId} / {i.externalUserId}</small></span></div>)}</div>}
    {error && <div className="inline-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
  </div>;
}
