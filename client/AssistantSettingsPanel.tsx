import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { FileText, Search, Settings2, ShieldCheck, Users } from 'lucide-react';
import { assistantAvatars, assistantAvatarSrc, assistantName, defaultAssistantAvatar, type AssistantSettings, type FastkoreRolePermissions, type FastkoreRoleSummary, type ReasoningEffort } from '../shared/types';
import { hasAdjustableEffort } from '../shared/execution-accounts';
import { Select } from './Select';
import { SettingsSpinner } from './SettingsSpinner';
import { SettingsTabStrip } from './SettingsTabs';
import { reasoningOptions } from './ChatModelControls';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const assistantTabs = [
  ['general', 'Настройки', Settings2],
  ['instructions', 'Инструкция', FileText],
  ['permissions', 'Разрешения', ShieldCheck],
] as const;
type AssistantTab = typeof assistantTabs[number][0];

export function AssistantSettingsPanel({ request, models, onChanged }: {
  request: Request;
  models: { value: string; label: string }[];
  onChanged?: () => void;
}) {
  const tabId = useId();
  const [tab, setTab] = useState<AssistantTab>('general');
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
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const instructionsDirty = !!settings && instructions.trim() !== (settings.instructions ?? '').trim();

  useLayoutEffect(() => {
    const el = instructionsRef.current;
    if (!el || tab !== 'instructions') return;
    el.style.height = 'auto';
    el.style.height = Math.max(160, el.scrollHeight) + 'px';
  }, [instructions, tab]);

  return <div className="settings-server fastis-settings-panel">
    <div className="fastis-panel-heading">
      <img src={assistantAvatarSrc(settings?.avatar)} alt="" className="fastis-settings-avatar" />
      <h2 id="settings-section-title">{assistantName}</h2>
      <p className="help">Общесистемный помощник вне проектов. Работает по правам и разрешениям CLI/MCP роли сотрудника в Fastkore, с общей базой знаний и без доступа к проектным библиотекам.</p>
    </div>
    {!settings && !error && <SettingsSpinner label="Загрузка настроек Финиста…" />}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {settings && <>
      <SettingsTabStrip sections={assistantTabs} value={tab} select={setTab} id={tabId} label="Разделы настроек Финиста"
        counts={roles ? { permissions: enabledCount } : undefined}
        panelId={key => tabId + key + '-panel'} className="server-settings-tabs" />

      {tab === 'general' && <section className="setting-section settings-models" role="tabpanel" id={tabId + 'general-panel'} aria-labelledby={tabId + 'general'}>
        <h3>Внешний вид и модель</h3>
        <div className="settings-model-row">
          <label htmlFor="fastis-avatar">Иконка для всех</label>
          <Select id="fastis-avatar" className="settings-select" value={settings.avatar ?? defaultAssistantAvatar} disabled={busy}
            options={assistantAvatars.map(option => ({ value: option.id, label: option.label, image: option.src }))}
            onChange={value => { if (value !== (settings.avatar ?? defaultAssistantAvatar)) void saveSettings({ avatar: value as AssistantSettings['avatar'] }); }} />
        </div>
        <div className="settings-model-row">
          <label htmlFor="fastis-model">Модель по умолчанию</label>
          <Select id="fastis-model" className="settings-select" value={model} options={modelChoices} disabled={busy}
            onChange={value => { setModel(value); if (value !== (settings.model ?? '')) void saveSettings({ model: value }); }} />
        </div>
        {(!model || hasAdjustableEffort(model)) && <div className="settings-model-row">
          <label htmlFor="fastis-reasoning">Рассуждение</label>
          <Select id="fastis-reasoning" className="settings-select" value={reasoningEffort} options={reasoningOptions} disabled={busy}
            onChange={value => { const next = value as ReasoningEffort; setReasoningEffort(next); if (next !== (settings.reasoningEffort ?? 'high')) void saveSettings({ reasoningEffort: next }); }} />
        </div>}
      </section>}

      {tab === 'instructions' && <form className="fastis-settings-form" role="tabpanel" id={tabId + 'instructions-panel'} aria-labelledby={tabId + 'instructions'}
        onSubmit={e => { e.preventDefault(); if (instructionsDirty) void saveSettings({ instructions }); }}>
        <section className="setting-section fastis-instructions-section">
          <h3><label htmlFor="fastis-instructions">Дополнительные правила для Финиста</label></h3>
          <p className="help" id="fastis-instructions-help">Например, бизнес-определения метрик, ограничения тематики или формат сводок. Действуют поверх общих инструкций платформы.</p>
          <textarea ref={instructionsRef} id="fastis-instructions" aria-describedby="fastis-instructions-help" maxLength={8000}
            value={instructions} disabled={busy} placeholder="Например: при подсчёте просроченных заказов исключай отменённые и черновики…"
            onChange={e => { setSaved(false); setInstructions(e.target.value); }} />
          <div className="settings-instructions-actions">
            {saved && <span role="status" className="help">Инструкция сохранена.</span>}
            <button type="submit" className="primary" disabled={busy || !instructionsDirty}>Сохранить</button>
          </div>
        </section>
      </form>}

      {tab === 'permissions' && <section className="setting-section" role="tabpanel" id={tabId + 'permissions-panel'} aria-labelledby={tabId + 'permissions'}>
        <div className="fastis-roles-heading">
          <h3>Доступ по ролям Fastkore</h3>
          {roles && roles.length > 0 && <span className="help">Активно: {enabledCount} из {roles.length}</span>}
        </div>
        <p className="help">Выберите роли, которым показывать {assistantName} в боковой панели. Если отключить все роли, помощник будет скрыт от сотрудников.</p>
        {roles && roles.length > 4 && <div className="roles-filters">
          <div className="audit-search"><Search size={18} aria-hidden="true" /><input aria-label="Поиск по ролям" placeholder="Поиск по ролям…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        </div>}
        {!roles && !error && <SettingsSpinner label="Загрузка ролей…" />}
        {filteredRoles && !filteredRoles.length && <p role="status" className="help">{roles?.length ? 'По выбранным условиям ролей нет.' : 'Роли появятся после входа сотрудников из Fastkore.'}</p>}
        {filteredRoles && filteredRoles.length > 0 && <ul className="settings-records fastis-role-list" aria-label="Роли с доступом к Финисту">
          {filteredRoles.map(role => {
            const allowed = role.permissions?.assistant === true;
            return <li key={role.installationId + '/' + role.id}>
              <div className="fastis-role-row-main">
                <span className="fastis-role-row-icon"><ShieldCheck size={16} aria-hidden="true" /></span>
                <strong>{role.name}</strong>
                {legacySources && <span className="fastis-role-row-meta">{role.installationName}</span>}
                <span className="fastis-role-users" title="Сотрудников с ролью"><Users size={13} aria-hidden="true" />{role.userCount}</span>
              </div>
              <label className={'check-setting account-active-status' + (allowed ? ' active' : ' inactive')}>
                <input type="checkbox" checked={allowed} disabled={busy}
                  aria-label={'Активен · ' + role.name}
                  onChange={e => void toggleRole(role, e.target.checked)} />
                {allowed ? 'Активен' : 'Неактивен'}
              </label>
            </li>;
          })}
        </ul>}
      </section>}
    </>}
  </div>;
}
