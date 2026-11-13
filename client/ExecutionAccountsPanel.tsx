import { useEffect, useState } from 'react';
import { Check, LogIn, Plus, RefreshCw } from 'lucide-react';
import type { ExecutionAccounts, ExecutionProvider } from '../shared/execution-accounts';
import { Select } from './Select';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const endpoint = '/api/admin/execution/accounts';
export function ExecutionAccountsPanel({ request, busy, changed }: { request: Request; busy: boolean; changed: () => Promise<void> }) {
  const [data, setData] = useState<ExecutionAccounts>();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ExecutionProvider>('codex');
  const [authorizationCodes, setAuthorizationCodes] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const waiting = data?.accounts.some(account => account.login?.state === 'waiting') ?? false;
  async function load() { setData(await request<ExecutionAccounts>(endpoint)); }
  useEffect(() => {
    const controller = new AbortController();
    request<ExecutionAccounts>(endpoint, { signal: controller.signal }).then(setData)
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [request]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void load().catch(e => setError(e.message)); }, 2500);
    return () => clearInterval(timer);
  }, [waiting, request]);
  async function action(work: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError('');
    try { await work(); await load(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  return <section className="setting-section execution-accounts">
    <div className="settings-section-heading"><h3>Аккаунты исполнителей</h3>
      <button type="button" className="workspace-icon" aria-label="Обновить аккаунты" disabled={working}
        onClick={() => void action(load)}><RefreshCw size={16} /></button>
    </div>
    <p className="help">Codex и Gemini CLI хранят отдельные авторизации. Новые задания используют активный аккаунт.</p>
    {!data && !error && <p role="status">Загрузка…</p>}
    <ul className="settings-records">{data?.accounts.map(account => <li key={account.id}>
      <div><strong>{account.name}</strong><small>{account.provider === 'gemini' ? 'Gemini CLI' : 'Codex'} · {account.email ?? (account.signedIn ? 'Вход выполнен' : 'Требуется вход')}</small>
        {account.active && <small><Check size={13} aria-hidden="true" />Активный аккаунт</small>}
        {account.login?.state === 'waiting' && <div className="execution-device-code">
          <p><a href={account.login.url} target="_blank" rel="noreferrer">{account.provider === 'gemini' ? 'Войти через Google' : 'Войти в ChatGPT'}</a></p>
          {account.login.code && <><code>{account.login.code}</code><small>Откройте ссылку в нужном аккаунте и введите код.</small></>}
          {account.login.needsCode && <div>
            <label htmlFor={'google-code-' + account.id}>Код со страницы Google</label>
            <input type="password" autoComplete="off" id={'google-code-' + account.id} value={authorizationCodes[account.id] ?? ''} onChange={e => setAuthorizationCodes(old => ({ ...old, [account.id]: e.target.value }))} />
            <button type="button" className="secondary" disabled={working || !authorizationCodes[account.id]?.trim()} onClick={() => void action(async () => {
              await request(endpoint + '/' + account.id + '/code', { method: 'POST', body: JSON.stringify({ code: authorizationCodes[account.id] }) }); setAuthorizationCodes(old => ({ ...old, [account.id]: '' }));
            })}>Подтвердить вход</button>
          </div>}
        </div>}
        {account.login?.state === 'error' && <small role="alert">{account.login.error}</small>}
      </div>
      <div className="settings-actions">
        {!account.active && account.signedIn && <button type="button" className="secondary" disabled={busy || working}
          onClick={() => void action(async () => { await request(endpoint + '/' + account.id + '/activate', { method: 'POST', body: '{}' }); await changed(); })}>Использовать</button>}
        <button type="button" className="secondary" disabled={busy || working || account.login?.state === 'waiting'}
          onClick={() => void action(async () => { await request(endpoint + '/' + account.id + '/login', { method: 'POST', body: '{}' }); })}><LogIn size={15} />{account.signedIn ? 'Сменить вход' : 'Войти'}</button>
      </div>
    </li>)}</ul>
    <form className="execution-account-create" onSubmit={event => {
      event.preventDefault();
      void action(async () => { await request(endpoint, { method: 'POST', body: JSON.stringify({ name, provider }) }); setName(''); });
    }}>
      <label htmlFor="execution-account-name">Название нового аккаунта</label>
      <Select label="Тип исполнителя" className="settings-select" value={provider} onChange={value => setProvider(value as ExecutionProvider)}
        options={[{ value: 'codex', label: 'Codex · ChatGPT' }, { value: 'gemini', label: 'Gemini CLI · Google' }]} />
      <div className="settings-actions"><input id="execution-account-name" maxLength={100} required value={name}
        onChange={e => setName(e.target.value)} placeholder="Например, рабочий аккаунт" />
        <button className="secondary" disabled={busy || working || !name.trim()}><Plus size={15} />Добавить</button></div>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
