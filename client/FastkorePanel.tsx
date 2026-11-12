import { useEffect, useState } from 'react';
import { Check, Link2, Plus } from 'lucide-react';
import { Select } from './Select';
import { SettingsAction } from './SettingsAction';
import { normalizeFastkoreTicketUrl } from '../shared/fastkore-url';
import type { ExternalIdentity, FastkoreInstallation, FastkoreTlsInfo, User } from '../shared/types';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const endpoint = '/api/admin/fastkore/installations';
const identitiesEndpoint = '/api/admin/fastkore/identities';
const tlsEndpoint = '/api/admin/fastkore/tls/check';
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

function installationStatus(item: FastkoreInstallation) {
  if (item.tlsConfirmationRequired) return 'Подтвердите CA ERP';
  if (item.pairingStatus === 'pending') return 'Ожидает подтверждения';
  if (item.pairingStatus === 'manual') return item.enabled ? 'Вход включён вручную' : 'Ручная настройка';
  if (item.pairingStatus === 'paired') return item.enabled ? 'Подключено' : 'Вход приостановлен';
  return 'Нужен код из ERP';
}

function TlsFingerprint({ certificate, previous }: { certificate: FastkoreTlsInfo; previous?: string }) {
  return <div className="fastkore-certificate">
    <small>{certificate.subject}</small>
    <b>Отпечаток CA SHA-256</b>
    <code>{certificate.fingerprint}</code>
    {previous && previous !== certificate.fingerprint && <><b>Ранее подтверждённый отпечаток</b><code>{previous}</code></>}
    <p className="help">Сверьте отпечаток с разделом «Сертификат TLS и отпечаток CA» в консоли ERP.</p>
  </div>;
}

export function FastkorePanel({ request }: { request: Request }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installations, setInstallations] = useState<FastkoreInstallation[]>([]);
  const [users, setUsers] = useState<User[]>([]), [identities, setIdentities] = useState<ExternalIdentity[]>([]);
  const [installationId, setInstallationId] = useState('');
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState(''), [url, setUrl] = useState('');
  const [checkingInstallation, setCheckingInstallation] = useState(false);
  const [certificate, setCertificate] = useState<FastkoreTlsInfo | null>(null);
  const [code, setCode] = useState(''), [rotate, setRotate] = useState(false), [reconnect, setReconnect] = useState(false);
  const [editing, setEditing] = useState<FastkoreInstallation | null>(null), [confirmUrl, setConfirmUrl] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [externalUserId, setExternalUserId] = useState(''), [userId, setUserId] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);

  const installation = installations.find(item => item.id === installationId);
  const rotating = rotate || installation?.pairingRotationPending === true;
  const editedUrl = editing && normalizeFastkoreTicketUrl(editing.validateTicketUrl);
  const urlChanged = !!editedUrl && editedUrl !== installation?.validateTicketUrl;

  async function load(preferredId?: string) {
    const [items, links] = await Promise.all([
      request<FastkoreInstallation[]>(endpoint),
      request<ExternalIdentity[]>(identitiesEndpoint),
    ]);
    setInstallations(items);
    setIdentities(links);
    setInstallationId(old => preferredId ?? (items.some(item => item.id === old) ? old : items[0]?.id ?? ''));
  }

  useEffect(() => {
    let alive = true;
    void request<{ fastkoreEnabled: boolean }>('/api/auth/browser-session').then(async config => {
      if (!alive) return;
      setAvailable(config.fastkoreEnabled);
      if (config.fastkoreEnabled) {
        const [items, links, accounts] = await Promise.all([
          request<FastkoreInstallation[]>(endpoint),
          request<ExternalIdentity[]>(identitiesEndpoint),
          request<User[]>('/api/users'),
        ]);
        if (!alive) return;
        setInstallations(items);
        setIdentities(links);
        setUsers(accounts);
        setInstallationId(items[0]?.id ?? '');
      }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [request]);

  async function run(work: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    let preferredId: string | undefined;
    try {
      preferredId = (await work()) || undefined;
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      await load(preferredId);
    } catch (e) {
      setError(old => old || (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function selectInstallation(id: string) {
    setInstallationId(id);
    setEditing(null);
    setCode('');
    setRotate(false);
    setReconnect(false);
    setNotice('');
    setError('');
  }

  function closeRegistration() {
    setRegistering(false);
    setName('');
    setUrl('');
    setCertificate(null);
    setError('');
  }

  async function checkTls(validateTicketUrl: string) {
    if (busy) return;
    setCertificate(null);
    setBusy(true);
    setError('');
    try {
      setCertificate(await request<FastkoreTlsInfo>(tlsEndpoint, json('POST', { validateTicketUrl })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closeTlsCheck() {
    setCheckingInstallation(false);
    setCertificate(null);
    setError('');
  }

  async function setEnabled(item: FastkoreInstallation, enabled: boolean) {
    await request(endpoint + '/' + item.id, json('PATCH', { enabled }));
    setConfirmPause(false);
    setNotice(enabled ? 'Вход разрешён.' : 'Вход приостановлен. Сеансы установки отозваны.');
  }

  function closeConfirmation() {
    setConfirmPause(false);
    setError('');
  }

  async function pairInstallation(id: string, pairingCode: string, rotateKey = false) {
    const route = endpoint + '/' + id + (rotateKey ? '/pair/rotate-key' : '/pair');
    const updated = await request<FastkoreInstallation>(route, json('POST', { pairingCode }));
    setInstallations(items => items.map(item => item.id === id ? updated : item));
    setCode('');
    setRotate(false);
    setReconnect(false);
    setNotice(rotateKey ? 'Ключ заменён. Прежние сеансы установки отозваны.' : 'Подключение подтверждено ERP.');
    return id;
  }

  const actionOpen = registering || editing || checkingInstallation || confirmPause;
  return <section className="setting-section fastkore-settings">
    {available && !actionOpen && <div className="fastkore-heading">
      <button type="button" className="secondary" disabled={busy} onClick={() => { setError(''); setRegistering(true); }}><Plus size={15} /> Добавить установку</button>
    </div>}
    {available === false && <p className="help">Для подключения ERP настройте ключ шифрования Fastkore на сервере.</p>}
    {available === null && !error && <p role="status">Загрузка настроек…</p>}
    {error && !registering && !checkingInstallation && !editing && !confirmPause && <div className="inline-error" role="alert">{error}</div>}
    {notice && <p className="fastkore-notice" role="status">{notice}</p>}

    {available && <>
      {!installations.length && !registering && <p>Установок ERP пока нет.</p>}
      {registering && <SettingsAction title="Добавить установку ERP">
        <form onSubmit={e => {
          e.preventDefault();
          if (!certificate) { void checkTls(url); return; }
          void run(async () => {
            const installation = await request<FastkoreInstallation>(endpoint, json('POST', {
              name: name.trim(), validateTicketUrl: url.trim(), setup: 'pairing', tlsFingerprint: certificate.fingerprint,
            }));
            selectInstallation(installation.id);
            setInstallations(items => [...items, installation]);
            closeRegistration();
            return installation.id;
          });
        }}>
          <label htmlFor="sso-name">Название установки</label>
          <input id="sso-name" data-settings-focus value={name} onChange={e => setName(e.target.value)} maxLength={100} required />
          <label htmlFor="sso-url">Адрес ERP</label>
          <input id="sso-url" inputMode="url" autoCapitalize="none" spellCheck={false} disabled={busy} value={url}
            onChange={e => { setUrl(e.target.value); setCertificate(null); setError(''); }} maxLength={2048} placeholder="erp.example.ru" required />
          {certificate && <TlsFingerprint certificate={certificate} />}
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeRegistration}>Отмена</button>
            {certificate && <button type="button" className="secondary" disabled={busy} onClick={() => void checkTls(url)}>Проверить заново</button>}
            <button className="primary" disabled={busy || !url.trim()}>{certificate ? 'Отпечаток совпадает' : busy ? 'Проверяем TLS…' : 'Проверить подключение'}</button>
          </div>
          {error && <div className="inline-error" role="alert">{error}</div>}
        </form>
      </SettingsAction>}

      {!actionOpen && !!installations.length && <div>
        <label htmlFor="sso-installation">Установка ERP</label>
        <Select id="sso-installation" className="settings-select" value={installationId} onChange={selectInstallation}
          disabled={busy} options={installations.map(item => ({ value: item.id, label: item.name }))} />
      </div>}

      {!actionOpen && installation && <article className="access-user fastkore-card">
        <div className="fastkore-card-top">
          <div><h4>{installation.name}</h4><small className="fastkore-url">{installation.validateTicketUrl}</small>
            {installation.mcpUrl && <small className="fastkore-url">MCP · {installation.mcpUrl}</small>}</div>
          <span className="fastkore-state" data-connected={installation.enabled}>
            {installation.pairingStatus === 'paired' && installation.enabled && <Check size={14} />}{installationStatus(installation)}
          </span>
        </div>

        <div className="settings-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => {
            setCheckingInstallation(true);
            void checkTls(installation.validateTicketUrl);
          }}>Проверить подключение</button>
        </div>

        {!installation.tlsConfirmationRequired && (installation.pairingStatus !== 'paired' || rotating || reconnect) && <form className="fastkore-pair-form" onSubmit={e => {
          e.preventDefault();
          void run(() => pairInstallation(installation.id, code, rotating));
        }}>
          <label htmlFor="sso-pair-code">{rotating ? 'Код для замены ключа' : 'Одноразовый код из ERP'}</label>
          <p className="help">{rotating ? 'Получите новый код в ERP. После замены ключа сотрудникам потребуется войти заново.' : 'Нажмите «Подключить» в карточке Agent Platform в Fastkore и скопируйте код сюда.'}</p>
          <input id="sso-pair-code" type="password" autoComplete="off" spellCheck={false} minLength={43} maxLength={43}
            value={code} onChange={e => setCode(e.target.value.trim())} required />
          <div className="button-pair">
            <button className="primary" disabled={busy || code.length !== 43}><Link2 size={15} />{busy ? 'Подключаем…' : rotating ? 'Заменить ключ' : installation.pairingStatus === 'pending' ? 'Повторить подключение' : 'Подключить'}</button>
            {(rotate || reconnect) && installation.pairingStatus !== 'pending' && <button type="button" className="secondary" disabled={busy} onClick={() => { setRotate(false); setReconnect(false); setCode(''); setNotice(''); }}>Отмена</button>}
          </div>
        </form>}

        <details className="fastkore-advanced">
          <summary>Управление установкой</summary>
          <small className="fastkore-url">ID установки · {installation.id}</small>
          <div className="button-pair">
            {(installation.enabled || installation.pairingStatus === 'paired' || installation.pairingStatus === 'manual') && <button className="secondary" disabled={busy} onClick={() => {
              if (installation.enabled) { setError(''); setConfirmPause(true); }
              else void run(() => setEnabled(installation, true));
            }}>{installation.enabled ? 'Приостановить вход' : 'Разрешить вход'}</button>}
            <button className="secondary" disabled={busy} onClick={() => { setEditing(installation); setConfirmUrl(false); setError(''); }}>Изменить установку</button>
            {installation.pairingStatus === 'paired' && <button className="secondary" disabled={busy || reconnect || rotating} onClick={() => {
              setReconnect(true); setCode(''); setNotice('');
            }}>Подключить заново</button>}
            {(installation.pairedAt || installation.pairingStatus === 'manual') && <button className="secondary" disabled={busy || rotating} onClick={() => {
              setRotate(true); setCode(''); setNotice('');
            }}>Ротация ключа</button>}
          </div>
        </details>
      </article>}

      {installation && editing?.id === installation.id && <SettingsAction title="Изменить установку ERP">
        <form onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            await request(endpoint + '/' + installation.id, json('PATCH', {
              name: editing.name.trim(),
              validateTicketUrl: editing.validateTicketUrl.trim(),
              mcpUrl: editing.mcpUrl?.trim() ?? '',
              mcpEnabled: editing.mcpEnabled !== false,
              cliEnabled: editing.cliEnabled !== false,
              confirmValidateTicketUrl: confirmUrl,
            }));
            setEditing(null);
            setNotice('Настройки установки сохранены.');
          });
        }}>
          <label htmlFor="sso-edit-name">Название установки</label>
          <input id="sso-edit-name" data-settings-focus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} maxLength={100} required />
          <label htmlFor="sso-edit-url">Адрес ERP</label>
          <input id="sso-edit-url" inputMode="url" autoCapitalize="none" spellCheck={false} disabled={installation.enabled} value={editing.validateTicketUrl}
            onChange={e => { setEditing({ ...editing, validateTicketUrl: e.target.value }); setConfirmUrl(false); }} maxLength={2048} required />
          {installation.enabled && <p className="help">Чтобы изменить адрес, приостановите вход.</p>}
          {urlChanged && <label className="check-setting"><input type="checkbox" checked={confirmUrl} onChange={e => setConfirmUrl(e.target.checked)} />Подтверждаю новый HTTPS-адрес ERP</label>}
          <label htmlFor="sso-mcp-url">HTTPS-адрес MCP</label>
          <input id="sso-mcp-url" type="url" value={editing.mcpUrl ?? ''} placeholder="https://erp.example.ru/webapi/mcp"
            onChange={e => setEditing({ ...editing, mcpUrl: e.target.value })} maxLength={2048} />
          <label className="check-setting"><input type="checkbox" checked={editing.mcpEnabled !== false}
            onChange={e => setEditing({ ...editing, mcpEnabled: e.target.checked })} />Разрешить Fastkore MCP</label>
          <label className="check-setting"><input type="checkbox" checked={editing.cliEnabled !== false}
            onChange={e => setEditing({ ...editing, cliEnabled: e.target.checked })} />Разрешить Fastkore CLI</label>
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(null); setError(''); }}>Отмена</button>
            <button className="primary" disabled={busy || (urlChanged && !confirmUrl)}>Сохранить</button>
          </div>
          {error && <div className="inline-error" role="alert">{error}</div>}
        </form>
      </SettingsAction>}

      {installation && checkingInstallation && <SettingsAction title="Проверить подключение ERP">
        <div>
          {certificate ? <TlsFingerprint certificate={certificate} previous={installation.tlsFingerprint} /> : busy && <p role="status">Проверяем TLS…</p>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeTlsCheck}>Отмена</button>
            {error && <button type="button" className="secondary" disabled={busy} onClick={() => void checkTls(installation.validateTicketUrl)}>Проверить заново</button>}
            {certificate && <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
              const updated = await request<FastkoreInstallation>(endpoint + '/' + installation.id + '/tls', json('POST', { fingerprint: certificate.fingerprint }));
              setInstallations(items => items.map(item => item.id === updated.id ? updated : item));
              closeTlsCheck();
              setNotice('TLS-соединение с ERP проверено.');
            })}>Отпечаток совпадает</button>}
          </div>
        </div>
      </SettingsAction>}

      {installation && confirmPause && <SettingsAction title="Приостановить вход из ERP">
        <div>
          <p>Сеансы установки «{installation.name}» будут отозваны.</p>
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" data-settings-focus disabled={busy} onClick={closeConfirmation}>Отмена</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void run(() => setEnabled(installation, false))}>Приостановить вход</button>
          </div>
          {error && <div className="inline-error" role="alert">{error}</div>}
        </div>
      </SettingsAction>}

      {!actionOpen && installation && <details className="fastkore-advanced">
        <summary>Связь с учётной записью платформы</summary>
        <form onSubmit={e => { e.preventDefault(); void run(async () => {
          await request(identitiesEndpoint, json('PUT', { installationId, externalUserId, userId }));
          setExternalUserId(''); setNotice('Связь сохранена. Сотруднику нужно открыть помощника заново.');
        }); }}>
          <label htmlFor="sso-external-user">ID сотрудника в ERP</label>
          <input id="sso-external-user" value={externalUserId} maxLength={36} onChange={e => setExternalUserId(e.target.value.trim().toLowerCase())} required />
          <label htmlFor="sso-platform-user">Учётная запись платформы</label>
          <Select id="sso-platform-user" className="settings-select" value={userId} onChange={setUserId} placeholder="Выберите сотрудника"
            options={users.filter(u => !u.disabled).map(u => ({ value: u.id, label: u.name + ' · ' + u.username }))} />
          <button className="secondary w-full" disabled={busy || !userId}>Сохранить связь</button>
        </form>
        <div className="access-list">{identities.filter(item => item.installationId === installationId).map(item => <div className="access-row" key={item.externalUserId}>
          <span><b>{users.find(u => u.id === item.userId)?.name ?? 'Неизвестная учётная запись'}</b><small>{item.externalUserId}</small></span>
        </div>)}</div>
      </details>}
    </>}
  </section>;
}
