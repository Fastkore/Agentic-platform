import { useEffect, useState } from 'react';
import { ArrowRight, Check, KeyRound, LogIn, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { type ExecutionAccount, type ExecutionAccounts, type ExecutionProvider, type GigaChatScope } from '../shared/execution-accounts';
import { Select } from './Select';
import { SettingsSpinner } from './SettingsSpinner';
import { WorkspaceDialog } from './WorkspaceDialog';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const endpoint = '/api/admin/execution/accounts';
const providerLabel = (provider: ExecutionProvider) => provider === 'antigravity' ? 'Antigravity CLI' : provider === 'gemini' ? 'Gemini CLI' : provider === 'glm' ? 'GLM · Z.ai' : provider === 'gigachat' ? 'GigaChat · Сбер' : 'ChatGPT';
const usesKey = (provider: ExecutionProvider) => provider === 'glm' || provider === 'gigachat';
const accountName = (account: ExecutionAccount) => account.provider === 'codex' && account.id === 'default' && account.name === 'Основной Codex' ? 'ChatGPT' : account.name;
// The Gemini CLI type is omitted on purpose: Google has retired it and new logins cannot work.
const createOptions = [{ value: 'codex', label: 'ChatGPT' }, { value: 'antigravity', label: 'Antigravity CLI · Google' }, { value: 'glm', label: 'GLM · Z.ai (ключ)' }, { value: 'gigachat', label: 'GigaChat · Сбер (ключ)' }];
const gigaChatScopeOptions = [
  { value: 'GIGACHAT_API_PERS', label: 'Физлицо · PERS' },
  { value: 'GIGACHAT_API_B2B', label: 'Предоплата · B2B' },
  { value: 'GIGACHAT_API_CORP', label: 'Постоплата · CORP' },
];

type Wizard = { id?: string; provider: ExecutionProvider; name: string; submitted?: boolean; scope?: GigaChatScope };

export function ExecutionAccountsPanel({ request, busy, changed }: { request: Request; busy: boolean; changed: () => Promise<void> }) {
  const [data, setData] = useState<ExecutionAccounts>();
  const [authorizationCodes, setAuthorizationCodes] = useState<Record<string, string>>({});
  const [accountKey, setAccountKey] = useState('');
  const [proxyDraft, setProxyDraft] = useState<string>();
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
    if (!wizard?.id || !wizard.submitted || working) return;
    const account = data?.accounts.find(item => item.id === wizard.id);
    if (account?.signedIn && (usesKey(account.provider) || account.login?.state === 'complete')) {
      setWorking(true);
      void (async () => {
        try {
          if (!account.active) await request(endpoint + '/' + account.id + '/activate', { method: 'POST', body: '{}' });
          await load();
          await changed(); setWizard(null); setError('');
        } catch (e) {
          setError((e as Error).message);
          setWizard(current => current?.id === account.id ? { ...current, submitted: false } : current);
        } finally { setWorking(false); }
      })();
    }
  }, [data, wizard, working, request, changed]);
  async function action(work: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError('');
    try { await work(); await load(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  async function startLogin(id: string) {
    const login = await request<NonNullable<ExecutionAccount['login']>>(endpoint + '/' + id + '/login', { method: 'POST', body: '{}' });
    setData(current => current && ({ ...current, accounts: current.accounts.map(account => account.id === id ? { ...account, login } : account) }));
    setWizard(current => current?.id === id ? { ...current, submitted: true } : current);
  }
  const wizardAccount = wizard?.id ? data?.accounts.find(item => item.id === wizard.id) : undefined;
  const scope = wizard?.scope ?? wizardAccount?.scope ?? 'GIGACHAT_API_PERS';
  return <section className="setting-section execution-accounts">
    <div className="settings-section-heading"><h3>Аккаунты исполнителей</h3>
      <button type="button" className="workspace-icon" aria-label="Обновить аккаунты" disabled={working}
        onClick={() => void action(load)}><RefreshCw size={16} /></button>
    </div>
    <p className="help">Сотрудникам видны модели всех активных аккаунтов — они работают вместе. Неактивные аккаунты скрыты от сотрудников; в этом списке видны всегда.</p>
    {!data && !error && <SettingsSpinner label="Загрузка аккаунтов…" />}
    {data?.proxyUrl !== undefined && <div className="setting-section">
      <label htmlFor="execution-https-proxy">HTTPS-прокси</label>
      <input id="execution-https-proxy" type="url" maxLength={2048} value={proxyDraft ?? data.proxyUrl}
        placeholder="http://host:port" disabled={working} onChange={event => setProxyDraft(event.target.value)} />
      <p className="help">Один адрес для всех агентов этой установки, использующих Codex. Пустое поле включает прямое соединение.</p>
      <div className="settings-actions"><button type="button" className="secondary"
        disabled={busy || working || proxyDraft === undefined || proxyDraft.trim() === data.proxyUrl}
        onClick={() => void action(async () => {
          await request('/api/admin/execution/proxy', { method: 'POST', body: JSON.stringify({ proxyUrl: proxyDraft?.trim() ?? '' }) });
          setProxyDraft(undefined);
        })}><Save size={15} aria-hidden="true" />Сохранить прокси</button></div>
    </div>}
    <ul className="settings-records">{data?.accounts.map(account => <li key={account.id}>
      <div><strong>{accountName(account)}</strong><small>{providerLabel(account.provider)} · {account.email ?? (account.signedIn ? 'Вход выполнен' : 'Требуется вход')}</small>
        {account.login?.state === 'error' && <small role="alert">{account.login.error}</small>}
      </div>
      <div className="settings-actions">
        <label className={'check-setting account-active-status' + (account.active ? ' active' : ' inactive')} title={account.active ? 'При отключении задания этого аккаунта будут остановлены. Сохранённый вход можно использовать снова.' : 'Модели скрыты от сотрудников'}>
          <input type="checkbox" checked={account.active} disabled={working || (!account.active && !account.signedIn)}
            aria-label={'Активен · ' + accountName(account)}
            onChange={event => void action(async () => {
              setData(await request<ExecutionAccounts>(endpoint + '/' + account.id + '/' + (event.target.checked ? 'activate' : 'deactivate'), { method: 'POST', body: '{}' }));
              await changed();
            })} />
          {account.active ? 'Активен' : 'Неактивен'}
        </label>
        <button type="button" className="secondary" disabled={working}
          onClick={() => { setError(''); setAuthorizationCodes(old => ({ ...old, [account.id]: '' })); setAccountKey('');
            setWizard({ id: account.id, provider: account.provider, name: accountName(account), submitted: account.login?.state === 'waiting' }); }}>
          {usesKey(account.provider) ? <KeyRound size={15} aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}<span>{usesKey(account.provider) ? 'Ключ' : account.login?.state === 'waiting' ? 'Продолжить вход' : 'Вход'}</span></button>
        <button type="button" className="workspace-icon" aria-label={'Удалить подключение «' + accountName(account) + '»'} title="Удалить подключение"
          disabled={working} onClick={() => {
            if (!window.confirm('Удалить подключение «' + accountName(account) + '» и сохранённый вход? Выполняющиеся задания этого аккаунта будут остановлены.')) return;
            void action(async () => { setData(await request<ExecutionAccounts>(endpoint + '/' + account.id, { method: 'DELETE' })); await changed(); });
          }}><Trash2 size={16} /></button>
      </div>
    </li>)}</ul>
    <div className="settings-actions">
      <button type="button" className="secondary" disabled={working || (data?.accounts.length ?? 0) >= 20}
        onClick={() => { setError(''); setAuthorizationCodes({}); setAccountKey(''); setWizard({ provider: 'codex', name: '' }); }}><Plus size={15} />Добавить аккаунт</button>
    </div>
    {error && !wizard && <p className="inline-error" role="alert">{error}</p>}
    {wizard && <WorkspaceDialog title={wizard.id ? 'Подключение: ' + wizard.name : 'Новый аккаунт исполнителя'} className="account-wizard" close={() => { setAccountKey(''); setWizard(null); }}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!wizard.id && <div className="setting-section">
        <label htmlFor="account-wizard-type">Тип исполнителя</label>
        <Select id="account-wizard-type" className="settings-select" value={wizard.provider} onChange={value => setWizard({ ...wizard, provider: value as ExecutionProvider })} options={createOptions} />
        <label htmlFor="account-wizard-name">Название</label>
        <input id="account-wizard-name" maxLength={100} value={wizard.name} onChange={e => setWizard({ ...wizard, name: e.target.value })} placeholder="Например, рабочий аккаунт" />
        <div className="settings-actions">
          <button type="button" className="primary" disabled={working || !wizard.name.trim()} onClick={() => void action(async () => {
            const account = await request<ExecutionAccount>(endpoint, { method: 'POST', body: JSON.stringify({ name: wizard.name.trim(), provider: wizard.provider }) });
            setData(current => ({ ...current, accounts: [...(current?.accounts ?? []), { ...account, active: false, signedIn: false }] }));
            setWizard(current => current && { id: account.id, provider: account.provider, name: account.name });
            if (account.provider === 'codex') await startLogin(account.id);
          })}>{wizard.provider === 'codex' ? <><LogIn size={16} aria-hidden="true" />Получить код</> : <>Далее<ArrowRight size={16} aria-hidden="true" /></>}</button>
          <button type="button" className="secondary" onClick={() => setWizard(null)}><X size={16} aria-hidden="true" />Отмена</button>
        </div>
      </div>}
      {wizard.id && wizardAccount && <div className="setting-section">
        {wizardAccount.login?.state === 'error' && <p className="inline-error" role="alert">{wizardAccount.login.error}</p>}
        {usesKey(wizardAccount.provider)
          ? <div className="execution-device-code">
              <label htmlFor={'account-key-' + wizardAccount.id}>{wizardAccount.provider === 'gigachat' ? 'Authorization Key проекта GigaChat API' : 'API-ключ GLM Coding Plan'}{wizardAccount.signedIn ? ' · замените сохранённый ключ' : ''}</label>
              <input type="password" autoComplete="off" id={'account-key-' + wizardAccount.id} value={accountKey}
                onChange={e => setAccountKey(e.target.value)} />
              {wizardAccount.provider === 'gigachat' && <>
                <label htmlFor="gigachat-scope">Тип доступа (Scope)</label>
                <Select id="gigachat-scope" value={scope} options={gigaChatScopeOptions} onChange={value => setWizard({ ...wizard, scope: value as GigaChatScope })} />
              </>}
              <div className="settings-actions">
                <button type="button" className="primary" disabled={working || !accountKey.trim()} onClick={() => void action(async () => {
                  await request(endpoint + '/' + wizardAccount.id + '/key', { method: 'POST', body: JSON.stringify({ key: accountKey.trim(),
                    scope: wizardAccount.provider === 'gigachat' ? scope : undefined }) });
                  setAccountKey('');
                  setWizard(current => current?.id === wizardAccount.id ? { ...current, submitted: true } : current);
                })}><Save size={16} aria-hidden="true" />Сохранить и подключить</button>
                <button type="button" className="secondary" onClick={() => { setAccountKey(''); setWizard(null); }} disabled={working}><X size={16} aria-hidden="true" />Закрыть</button>
              </div>
            </div>
          : <>
              {wizardAccount.login?.state === 'waiting'
                ? <div className="execution-device-code">
                    {wizardAccount.login.url ? <p><a href={wizardAccount.login.url} target="_blank" rel="noreferrer">{wizardAccount.provider !== 'codex' ? 'Войти через Google' : 'Войти в ChatGPT'}</a></p> : <p role="status">Исполнитель запрашивает данные для входа…</p>}
                    {wizardAccount.login.code && <><code>{wizardAccount.login.code}</code><p>Откройте «Войти в ChatGPT», введите этот код на странице OpenAI и подтвердите вход. Затем вернитесь сюда.</p></>}
                    {wizardAccount.login.needsCode && <div>
                      <label htmlFor={'google-code-' + wizardAccount.id}>Код со страницы Google</label>
                      <input type="password" autoComplete="off" id={'google-code-' + wizardAccount.id} value={authorizationCodes[wizardAccount.id] ?? ''} onChange={e => setAuthorizationCodes(old => ({ ...old, [wizardAccount.id]: e.target.value }))} />
                      <div className="settings-actions">
                        <button type="button" className="primary" disabled={working || !authorizationCodes[wizardAccount.id]?.trim()} onClick={() => void action(async () => {
                          await request(endpoint + '/' + wizardAccount.id + '/code', { method: 'POST', body: JSON.stringify({ code: authorizationCodes[wizardAccount.id] }) });
                          setAuthorizationCodes(old => ({ ...old, [wizardAccount.id]: '' }));
                        })}><Check size={16} aria-hidden="true" />Подтвердить вход</button>
                      </div>
                    </div>}
                  </div>
                : <div className="settings-actions">
                    <button type="button" className="primary" disabled={working} onClick={() => void action(() => startLogin(wizardAccount.id))}><LogIn size={16} aria-hidden="true" />{wizardAccount.provider === 'codex' ? (wizardAccount.login?.state === 'error' ? 'Запросить новый код' : 'Получить код') : wizardAccount.signedIn ? 'Войти заново' : 'Начать вход'}</button>
                    <button type="button" className="secondary" onClick={() => setWizard(null)} disabled={working}><X size={16} aria-hidden="true" />Закрыть</button>
                  </div>}
              {wizardAccount.login?.state !== 'error' && (wizardAccount.provider === 'codex'
                ? <p className="help" role="status">{wizardAccount.login?.state === 'complete' && wizard.submitted ? 'Вход подтверждён. Обновляем аккаунт…' : working && !wizard.submitted ? 'Запрашиваем одноразовый код у OpenAI…' : wizardAccount.login?.state === 'waiting' ? 'Ожидаем подтверждения входа.' : 'Одноразовый код появится в этом окне.'}</p>
                : <p className="help">Вход выполняется по ссылке и одноразовому коду.</p>)}
            </>}
      </div>}
    </WorkspaceDialog>}
  </section>;
}
