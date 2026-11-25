import { useEffect, useState } from 'react';
import { Check, Link2, Plus, X } from 'lucide-react';
import { SettingsAction } from './SettingsAction';
import { SettingsSpinner } from './SettingsSpinner';
import { normalizeFastkoreTicketUrl } from '../shared/fastkore-url';
import type { FastkoreConnectionCheck, FastkoreInstallation, FastkoreTlsInfo } from '../shared/types';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const endpoint = '/api/admin/fastkore/installations';
const tlsEndpoint = '/api/admin/fastkore/tls/check';
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

function ConnectionChecks({ request, url, installation }: { request: Request; url: string; installation: unknown }) {
  const [checks, setChecks] = useState<FastkoreConnectionCheck[]>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setChecks(undefined);
    setError('');
    void request<FastkoreConnectionCheck[]>(url, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setChecks(value);
    }).catch(cause => {
      if (!controller.signal.aborted) setError((cause as Error).message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, url, installation, refresh]);
  const labels = { sso: 'Вход из ERP', mcp: 'Fastkore MCP', cli: 'Fastkore CLI' };
  return <div className="fastkore-checks" aria-busy={loading}>
    {checks?.map(check => <div key={check.id} className="fastkore-check" data-ready={check.ready}>
      {check.ready ? <Check size={17} aria-hidden="true" /> : <X size={17} aria-hidden="true" />}
      <div><b>{labels[check.id]} · {check.ready ? 'Настроено' : 'Требует настройки'}</b><p>{check.message}</p></div>
    </div>)}
    {loading && <SettingsSpinner inline label="Проверяем настройки подключения…" />}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <button type="button" className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Проверить настройки</button>
  </div>;
}

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

export function FastkorePanel({ request, currentInstallationOnly }: { request: Request; currentInstallationOnly: boolean }) {
  return currentInstallationOnly ? <FastkoreMcpSettings request={request} /> : <FastkoreInstallations request={request} />;
}

function FastkoreMcpSettings({ request }: { request: Request }) {
  type Installation = Pick<FastkoreInstallation, 'name' | 'mcpUrl'>;
  const endpoint = '/api/admin/fastkore/mcp';
  const [installation, setInstallation] = useState<Installation>();
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<Installation>(endpoint, { signal: controller.signal }).then(item => {
      if (controller.signal.aborted) return;
      setInstallation(item);
      setUrl(item.mcpUrl ?? '');
    }).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [request]);
  async function save() {
    if (busy || saved || !installation || url.trim() === (installation.mcpUrl ?? '')) return;
    setBusy(true);
    setError('');
    try {
      const item = await request<Installation>(endpoint, json('PATCH', { mcpUrl: url.trim() }));
      setInstallation(item);
      setUrl(item.mcpUrl ?? '');
      setSaved(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="setting-section">
    {installation && <ConnectionChecks request={request} url={endpoint + '/checks'} installation={installation} />}
    {installation ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>Подключение ERP</h3>
      <label htmlFor="current-installation-mcp">HTTPS-адрес MCP</label>
      <input id="current-installation-mcp" type="url" value={url} placeholder="https://erp.example.ru/webapi/mcp"
        maxLength={2048} required disabled={busy || saved} onChange={event => setUrl(event.target.value)} />
      {saved ? <p role="status">Адрес сохранён. Откройте помощника заново из Fastkore.</p> : <>
        <p className="help">Смена адреса завершит текущие сеансы этой установки.</p>
        <p className="help">Новый домен MCP указывается при локальном входе администратора.</p>
        <div className="settings-dialog-actions"><button className="primary" disabled={busy || url.trim() === (installation.mcpUrl ?? '')}>Сохранить</button></div>
      </>}
    </form> : !error && <SettingsSpinner label="Загрузка настроек…" />}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </section>;
}

function FastkoreInstallations({ request }: { request: Request }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installations, setInstallations] = useState<FastkoreInstallation[]>([]);
  const [error, setError] = useState('');
  async function reload() { setInstallations(await request<FastkoreInstallation[]>(endpoint)); }
  useEffect(() => {
    let alive = true;
    void Promise.all([
      request<{ fastkoreEnabled: boolean }>('/api/auth/browser-session'),
      request<FastkoreInstallation[]>(endpoint).catch((cause: Error) => cause),
    ]).then(([config, items]) => {
      if (!alive) return;
      setAvailable(config.fastkoreEnabled);
      if (config.fastkoreEnabled) {
        if (items instanceof Error) { setError(items.message); return; }
        setInstallations(items);
      }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [request]);

  if (error) return <p className="inline-error" role="alert">{error}</p>;
  if (available === null) return <SettingsSpinner label="Загрузка подключения…" />;
  if (!available) return <p className="help">Для подключения ERP настройте ключ шифрования Fastkore на сервере.</p>;
  if (!installations.length) return <FastkoreConnection request={request} reload={reload} />;
  // Older databases may have multiple installations. Keep each existing binding manageable by its original ID.
  return <>{installations.map(item => <FastkoreConnection key={item.id} installation={item} request={request} reload={reload} />)}</>;
}

function FastkoreConnection({ request, installation, reload }: {
  request: Request; installation?: FastkoreInstallation; reload: () => Promise<void>;
}) {
  const [registering, setRegistering] = useState(false);
  const [url, setUrl] = useState('');
  const [checkingInstallation, setCheckingInstallation] = useState(false);
  const [certificate, setCertificate] = useState<FastkoreTlsInfo | null>(null);
  const [code, setCode] = useState(''), [rotate, setRotate] = useState(false), [reconnect, setReconnect] = useState(false);
  const [editing, setEditing] = useState<FastkoreInstallation | null>(null), [confirmUrl, setConfirmUrl] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);

  const rotating = rotate || installation?.pairingRotationPending === true;
  const editedUrl = editing && normalizeFastkoreTicketUrl(editing.validateTicketUrl);
  const urlChanged = !!editedUrl && editedUrl !== installation?.validateTicketUrl;

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      await reload();
    } catch (e) {
      setError(old => old || (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closeRegistration() {
    setRegistering(false);
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
    await request<FastkoreInstallation>(route, json('POST', { pairingCode }));
    setCode('');
    setRotate(false);
    setReconnect(false);
    setNotice(rotateKey ? 'Ключ заменён. Прежние сеансы установки отозваны.' : 'Подключение подтверждено ERP.');
  }

  const actionOpen = registering || editing || checkingInstallation || confirmPause;
  return <section className="setting-section fastkore-settings">
    {!installation && !actionOpen && <div className="fastkore-heading">
      <button type="button" className="secondary" disabled={busy} onClick={() => { setError(''); setRegistering(true); }}><Plus size={15} /> Подключить ERP</button>
    </div>}
    {error && !registering && !checkingInstallation && !editing && !confirmPause && <div className="inline-error" role="alert">{error}</div>}
    {notice && <p className="fastkore-notice" role="status">{notice}</p>}

    <>
      {!installation && !registering && <p>ERP пока не подключена.</p>}
      {registering && <SettingsAction title="Подключить ERP">
        <form onSubmit={e => {
          e.preventDefault();
          if (!certificate) { void checkTls(url); return; }
          void run(async () => {
            await request<FastkoreInstallation>(endpoint, json('POST', {
              validateTicketUrl: url.trim(), setup: 'pairing', tlsFingerprint: certificate.fingerprint,
            }));
            closeRegistration();
          });
        }}>
          <label htmlFor="sso-url">HTTPS-адрес TLS API ERP</label>
          <p className="help">Укажите TLS-порт Fastkore из настроек сервера, например https://erp.example.ru:17027.</p>
          <input id="sso-url" data-settings-focus inputMode="url" autoCapitalize="none" spellCheck={false} disabled={busy} value={url}
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

      {!actionOpen && installation && <article className="access-user fastkore-card">
        <div className="fastkore-card-top">
          <div><h4>Подключение ERP</h4><small className="fastkore-url">{installation.validateTicketUrl}</small>
            {installation.mcpUrl && <small className="fastkore-url">MCP · {installation.mcpUrl}</small>}</div>
          <span className="fastkore-state" data-connected={installation.enabled}>
            {installation.pairingStatus === 'paired' && installation.enabled && <Check size={14} />}{installationStatus(installation)}
          </span>
        </div>

        <div className="settings-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(installation); setConfirmUrl(false); setError(''); }}>Настроить подключение</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => {
            setCheckingInstallation(true);
            void checkTls(installation.validateTicketUrl);
          }}>Проверить сертификат TLS</button>
        </div>
        <ConnectionChecks request={request} url={endpoint + '/' + installation.id + '/checks'} installation={installation} />

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
          <label htmlFor="sso-edit-url">HTTPS-адрес TLS API ERP</label>
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
          {certificate ? <TlsFingerprint certificate={certificate} previous={installation.tlsFingerprint} /> : busy && <SettingsSpinner inline label="Проверяем TLS…" />}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeTlsCheck}>Отмена</button>
            {error && <button type="button" className="secondary" disabled={busy} onClick={() => void checkTls(installation.validateTicketUrl)}>Проверить заново</button>}
            {certificate && <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
              await request<FastkoreInstallation>(endpoint + '/' + installation.id + '/tls', json('POST', { fingerprint: certificate.fingerprint }));
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

    </>
  </section>;
}
