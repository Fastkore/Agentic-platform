import { useEffect, useState } from 'react';
import { KeyRound, LogIn, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ExecutionAccount, ExecutionAccounts, ExecutionProvider } from '../shared/execution-accounts';
import { Select } from './Select';
import { WorkspaceDialog } from './WorkspaceDialog';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const endpoint = '/api/admin/execution/accounts';
const providerLabel = (provider: ExecutionProvider) => provider === 'antigravity' ? 'Antigravity CLI' : provider === 'gemini' ? 'Gemini CLI' : provider === 'glm' ? 'GLM · Z.ai' : 'Codex';
// The Gemini CLI type is omitted on purpose: Google has retired it and new logins cannot work.
const createOptions = [{ value: 'codex', label: 'Codex · ChatGPT' }, { value: 'antigravity', label: 'Antigravity CLI · Google' }, { value: 'glm', label: 'GLM · Z.ai (ключ)' }];

type Wizard = { id?: string; provider: ExecutionProvider; name: string };

export function ExecutionAccountsPanel({ request, busy, changed }: { request: Request; busy: boolean; changed: () => Promise<void> }) {
  const [data, setData] = useState<ExecutionAccounts>();
  const [authorizationCodes, setAuthorizationCodes] = useState<Record<string, string>>({});
  const [glmKeys, setGlmKeys] = useState<Record<string, string>>({});
  const [wizard, setWizard] = useState<Wizard | null>(null);
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
  // A finished wizard connection activates the account right away and closes the dialog.
  useEffect(() => {
    if (!wizard?.id || working) return;
    const account = data?.accounts.find(item => item.id === wizard.id);
    if (account?.signedIn && !account.active) {
      setWorking(true);
      void (async () => {
        try {
          await request(endpoint + '/' + account.id + '/activate', { method: 'POST', body: '{}' });
          await changed(); setWizard(null); setError('');
        } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
      })();
    }
  }, [data, wizard, working, request, changed]);
  async function action(work: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError('');
    try { await work(); await load(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  const wizardAccount = wizard?.id ? data?.accounts.find(item => item.id === wizard.id) : undefined;
  return <section className="setting-section execution-accounts">
    <div className="settings-section-heading"><h3>Аккаунты исполнителей</h3>
      <button type="button" className="workspace-icon" aria-label="Обновить аккаунты" disabled={working}
        onClick={() => void action(load)}><RefreshCw size={16} /></button>
    </div>
    <p className="help">Сотрудникам видны модели всех активных аккаунтов — они работают вместе. Неактивные аккаунты скрыты от сотрудников; в этом списке видны всегда.</p>
    {!data && !error && <p role="status">Загрузка…</p>}
    <ul className="settings-records">{data?.accounts.map(account => <li key={account.id}>
      <div><strong>{account.name}</strong><small>{providerLabel(account.provider)} · {account.email ?? (account.signedIn ? 'Вход выполнен' : 'Требуется вход')}</small>
        {account.login?.state === 'error' && <small role="alert">{account.login.error}</small>}
      </div>
      <div className="settings-actions">
        <label className={'check-setting account-active-status' + (account.active ? ' active' : ' inactive')} title={account.active ? 'Модели видны сотрудникам' : 'Модели скрыты от сотрудников'}>
          <input type="checkbox" checked={account.active} disabled={busy || working || !account.signedIn}
            aria-label={'Активен · ' + account.name}
            onChange={event => void action(async () => {
              await request(endpoint + '/' + account.id + '/' + (event.target.checked ? 'activate' : 'deactivate'), { method: 'POST', body: '{}' });
              await changed();
            })} />
          {account.active ? 'Активен' : 'Неактивен'}
        </label>
        <button type="button" className="secondary" disabled={busy || working || account.login?.state === 'waiting'}
          onClick={() => { setAuthorizationCodes(old => ({ ...old, [account.id]: '' })); setGlmKeys(old => ({ ...old, [account.id]: '' }));
            setWizard({ id: account.id, provider: account.provider, name: account.name }); }}>
          {account.provider === 'glm' ? <KeyRound size={15} aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}<span>{account.provider === 'glm' ? 'Ключ' : 'Вход'}</span></button>
        <button type="button" className="workspace-icon" aria-label={'Удалить подключение «' + account.name + '»'} title="Удалить подключение"
          disabled={busy || working} onClick={() => {
            if (!window.confirm('Удалить подключение «' + account.name + '» и сохранённый вход? Чаты и файлы проектов сохранятся.')) return;
            void action(async () => { await request(endpoint + '/' + account.id, { method: 'DELETE' }); await changed(); });
          }}><Trash2 size={16} /></button>
      </div>
    </li>)}</ul>
    <div className="settings-actions">
      <button type="button" className="secondary" disabled={busy || working || (data?.accounts.length ?? 0) >= 20}
        onClick={() => { setAuthorizationCodes({}); setGlmKeys({}); setWizard({ provider: 'codex', name: '' }); }}><Plus size={15} />Добавить аккаунт</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {wizard && <WorkspaceDialog title={wizard.id ? 'Подключение: ' + wizard.name : 'Новый аккаунт исполнителя'} className="account-wizard" close={() => setWizard(null)}>
      {!wizard.id && <div className="setting-section">
        <label htmlFor="account-wizard-type">Тип исполнителя</label>
        <Select id="account-wizard-type" className="settings-select" value={wizard.provider} onChange={value => setWizard({ ...wizard, provider: value as ExecutionProvider })} options={createOptions} />
        <label htmlFor="account-wizard-name">Название</label>
        <input id="account-wizard-name" maxLength={100} value={wizard.name} onChange={e => setWizard({ ...wizard, name: e.target.value })} placeholder="Например, рабочий аккаунт" />
        <div className="settings-actions">
          <button type="button" className="primary" disabled={working || !wizard.name.trim()} onClick={() => void action(async () => {
            const account = await request<ExecutionAccount>(endpoint, { method: 'POST', body: JSON.stringify({ name: wizard.name.trim(), provider: wizard.provider }) });
            setWizard({ id: account.id, provider: account.provider, name: account.name });
          })}>Далее</button>
          <button type="button" className="secondary" onClick={() => setWizard(null)}>Отмена</button>
        </div>
      </div>}
      {wizard.id && wizardAccount && <div className="setting-section">
        {wizardAccount.provider === 'glm'
          ? <div className="execution-device-code">
              <label htmlFor={'glm-key-' + wizardAccount.id}>API-ключ GLM Coding Plan{wizardAccount.signedIn ? ' · замените сохранённый ключ' : ''}</label>
              <input type="password" autoComplete="off" id={'glm-key-' + wizardAccount.id} value={glmKeys[wizardAccount.id] ?? ''}
                onChange={e => setGlmKeys(old => ({ ...old, [wizardAccount.id]: e.target.value }))} placeholder="Ключ из личного кабинета Z.ai" />
              <div className="settings-actions">
                <button type="button" className="primary" disabled={working || !glmKeys[wizardAccount.id]?.trim()} onClick={() => void action(async () => {
                  await request(endpoint + '/' + wizardAccount.id + '/key', { method: 'POST', body: JSON.stringify({ key: glmKeys[wizardAccount.id].trim() }) });
                  setGlmKeys(old => ({ ...old, [wizardAccount.id]: '' }));
                })}>Сохранить и подключить</button>
                <button type="button" className="secondary" onClick={() => setWizard(null)} disabled={working}>Закрыть</button>
              </div>
            </div>
          : <>
              {wizardAccount.login?.state === 'waiting'
                ? <div className="execution-device-code">
                    <p><a href={wizardAccount.login.url} target="_blank" rel="noreferrer">{wizardAccount.provider !== 'codex' ? 'Войти через Google' : 'Войти в ChatGPT'}</a></p>
                    {wizardAccount.login.code && <><code>{wizardAccount.login.code}</code><small>Откройте ссылку в нужном аккаунте и введите код.</small></>}
                    {wizardAccount.login.needsCode && <div>
                      <label htmlFor={'google-code-' + wizardAccount.id}>Код со страницы Google</label>
                      <input type="password" autoComplete="off" id={'google-code-' + wizardAccount.id} value={authorizationCodes[wizardAccount.id] ?? ''} onChange={e => setAuthorizationCodes(old => ({ ...old, [wizardAccount.id]: e.target.value }))} />
                      <div className="settings-actions">
                        <button type="button" className="primary" disabled={working || !authorizationCodes[wizardAccount.id]?.trim()} onClick={() => void action(async () => {
                          await request(endpoint + '/' + wizardAccount.id + '/code', { method: 'POST', body: JSON.stringify({ code: authorizationCodes[wizardAccount.id] }) });
                          setAuthorizationCodes(old => ({ ...old, [wizardAccount.id]: '' }));
                        })}>Подтвердить вход</button>
                      </div>
                    </div>}
                  </div>
                : <div className="settings-actions">
                    <button type="button" className="primary" disabled={working} onClick={() => void action(async () => {
                      await request(endpoint + '/' + wizardAccount.id + '/login', { method: 'POST', body: '{}' });
                    })}>{wizardAccount.signedIn ? 'Войти заново' : 'Начать вход'}</button>
                    <button type="button" className="secondary" onClick={() => setWizard(null)} disabled={working}>Закрыть</button>
                  </div>}
              <p className="help">{wizardAccount.signedIn ? 'После успешного входа аккаунт активируется автоматически.' : 'Вход выполняется по ссылке и одноразовом коду.'}</p>
            </>}
      </div>}
    </WorkspaceDialog>}
  </section>;
}
