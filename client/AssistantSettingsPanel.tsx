import { useEffect, useState } from 'react';
import { Search, ShieldCheck, Users } from 'lucide-react';
import { assistantName, type AssistantSettings, type FastkoreRolePermissions, type FastkoreRoleSummary, type ReasoningEffort } from '../shared/types';
import { hasAdjustableEffort } from '../shared/execution-accounts';
import { PermissionSwitch } from './PermissionSwitch';
import { Select } from './Select';
import { SettingsSpinner } from './SettingsSpinner';
import { reasoningOptions } from './ChatModelControls';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;

export function AssistantSettingsPanel({ request, models, onChanged }: {
  request: Request;
  models: { value: string; label: string }[];
  onChanged?: () => void;
}) {
  const [settings, setSettings] = useState<AssistantSettings>();
  const [roles, setRoles] = useState<FastkoreRoleSummary[]>();
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('high');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      request<AssistantSettings>('/api/admin/assistant/settings', { signal: controller.signal }),
      request<FastkoreRoleSummary[]>('/api/admin/erp-roles', { signal: controller.signal }),
    ]).then(([config, roleList]) => {
      if (controller.signal.aborted) return;
      setSettings(config);
      setInstructions(config.instructions ?? '');
      setModel(config.model ?? '');
      setReasoningEffort(config.reasoningEffort ?? 'high');
      setRoles(roleList);
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [request]);

  async function saveSettings(patch: Partial<Omit<AssistantSettings, 'revision'>>) {
    if (!settings || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const next = await request<AssistantSettings>('/api/admin/assistant/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...patch, revision: settings.revision }),
      });
      setSettings(next);
      setInstructions(next.instructions ?? '');
      setModel(next.model ?? '');
      setReasoningEffort(next.reasoningEffort ?? 'high');
      setSaved(true);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
      void request<AssistantSettings>('/api/admin/assistant/settings').then(fresh => {
        setSettings(fresh);
        setInstructions(fresh.instructions ?? '');
        setModel(fresh.model ?? '');
        setReasoningEffort(fresh.reasoningEffort ?? 'high');
      }).catch(() => {});
    } finally { setBusy(false); }
  }

  async function toggleRole(role: FastkoreRoleSummary, enabled: boolean) {
    if (busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const current = role.permissions ?? { mcp: true, cli: true, readOnly: false, webRead: false, webRequests: false, revision: 0 };
      const updated = await request<FastkoreRolePermissions>(
        '/api/admin/erp-roles/' + encodeURIComponent(role.installationId) + '/' + encodeURIComponent(role.id) + '/permissions',
        { method: 'PATCH', body: JSON.stringify({ ...current, assistant: enabled }) },
      );
      setRoles(items => items?.map(item => item.id === role.id && item.installationId === role.installationId
        ? { ...item, permissions: updated } : item));
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
      void request<FastkoreRoleSummary[]>('/api/admin/erp-roles').then(setRoles).catch(() => {});
    } finally { setBusy(false); }
  }

  const query = search.trim().toLocaleLowerCase('ru-RU');
  const legacySources = new Set(roles?.map(role => role.installationId)).size > 1;
  const filteredRoles = roles?.filter(role => (role.name + (legacySources ? ' ' + role.installationName : '')).toLocaleLowerCase('ru-RU').includes(query));
  const enabledCount = roles?.filter(role => role.permissions?.assistant).length ?? 0;
  const modelChoices = [
    { value: '', label: 'Модель сервера по умолчанию' },
    ...(model && !models.some(item => item.value === model) ? [{ value: model, label: model }] : []),
    ...models,
  ];
  const formDirty = !!settings && (
    instructions.trim() !== (settings.instructions ?? '').trim() ||
    model !== (settings.model ?? '') ||
    reasoningEffort !== (settings.reasoningEffort ?? 'high')
  );

  return <div className="erp-roles-panel fastis-settings-panel">
    {!settings && !error && <SettingsSpinner label="Загрузка настроек Финиста…" />}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {settings && <>
      <section className="setting-section fastis-settings-card">
        <div className="fastis-settings-header">
          <img src="/icons/fastis-robot.png" alt="" className="fastis-settings-avatar" />
          <div className="fastis-settings-summary">
            <h3>{assistantName}</h3>
            <p className="help">Общесистемный помощник вне проектов. Работает по правам сотрудника в Fastkore в режиме только чтения, с общей базой знаний и без доступа к проектным библиотекам.</p>
          </div>
          <label className="erp-role-permission fastis-master-switch">
            <PermissionSwitch name={'Включить ' + assistantName} checked={settings.enabled} disabled={busy}
              onChange={enabled => void saveSettings({ enabled })} />
            <span>{settings.enabled ? 'Включён' : 'Отключён'}</span>
          </label>
        </div>
      </section>

      <section className="setting-section">
        <div className="fastis-roles-heading">
          <h3>Доступ по ролям Fastkore</h3>
          {roles && roles.length > 0 && <span className="help">Выбрано ролей: {enabledCount} из {roles.length}</span>}
        </div>
        <p className="help">Выберите роли, которым показывать {assistantName} в боковой панели. Администраторам платформы помощник доступен, пока включён выше.</p>
        {roles && roles.length > 4 && <div className="roles-filters">
          <div className="audit-search"><Search size={18} aria-hidden="true" /><input aria-label="Поиск по ролям" placeholder="Поиск по ролям…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        </div>}
        {!roles && !error && <SettingsSpinner label="Загрузка ролей…" />}
        {filteredRoles && !filteredRoles.length && <p role="status" className="help">{roles?.length ? 'По выбранным условиям ролей нет.' : 'Роли появятся после входа сотрудников из Fastkore.'}</p>}
        {filteredRoles && filteredRoles.length > 0 && <ul className="erp-role-cards fastis-role-cards" aria-label="Роли с доступом к Финисту">
          {filteredRoles.map(role => {
            const allowed = role.permissions?.assistant === true;
            return <li key={role.installationId + '/' + role.id}>
              <div className="erp-role-heading">
                <span className="erp-role-icon"><ShieldCheck size={22} aria-hidden="true" /></span>
                <div>
                  <h3>{role.name}</h3>
                  {legacySources && <p>{role.installationName}</p>}
                </div>
                <span className="fastis-role-users"><Users size={15} aria-hidden="true" />{role.userCount}</span>
                <label className="erp-role-permission">
                  <PermissionSwitch name={'Показывать ' + assistantName + ' · ' + role.name} checked={allowed} disabled={busy || !settings.enabled}
                    onChange={enabled => void toggleRole(role, enabled)} />
                  <span>{allowed ? 'Показывать' : 'Скрыт'}</span>
                </label>
              </div>
            </li>;
          })}
        </ul>}
      </section>

      <section className="setting-section">
        <h3>Инструкции и модель</h3>
        <form className="fastis-settings-form" onSubmit={e => { e.preventDefault(); if (formDirty) void saveSettings({ instructions, model, reasoningEffort }); }}>
          <div className="settings-model-row">
            <label htmlFor="fastis-model">Модель по умолчанию</label>
            <Select id="fastis-model" className="settings-select" value={model} options={modelChoices} disabled={busy}
              onChange={value => { setSaved(false); setModel(value); }} />
          </div>
          {(!model || hasAdjustableEffort(model)) && <div className="settings-model-row">
            <label htmlFor="fastis-reasoning">Рассуждение</label>
            <Select id="fastis-reasoning" className="settings-select" value={reasoningEffort} options={reasoningOptions} disabled={busy}
              onChange={value => { setSaved(false); setReasoningEffort(value as ReasoningEffort); }} />
          </div>}
          <label htmlFor="fastis-instructions">Дополнительные правила для Финиста</label>
          <p className="help" id="fastis-instructions-help">Например, бизнес-определения метрик, ограничения тематики или формат сводок. Действуют поверх общих инструкций платформы.</p>
          <textarea id="fastis-instructions" aria-describedby="fastis-instructions-help" rows={5} maxLength={8000}
            value={instructions} disabled={busy} placeholder="Например: при подсчёте просроченных заказов исключай отменённые и черновики…"
            onChange={e => { setSaved(false); setInstructions(e.target.value); }} />
          <div className="settings-instructions-actions">
            {saved && <span role="status" className="help">Настройки Финиста сохранены.</span>}
            <button type="submit" className="primary" disabled={busy || !formDirty}>Сохранить</button>
          </div>
        </form>
      </section>
    </>}
  </div>;
}
