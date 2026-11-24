import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BarChart3, Bot, Calculator, ChevronDown, ChevronLeft, Database, FileText, Folder, Layers3, MessageCircle, Paperclip, Pencil, Plus, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { agentToolIds, agentTools } from '../shared/agent-tools';
import { specialistFileLimits, specialistIcons, type AgentProfile, type Dataset, type ModelCatalog, type SpecialistIcon } from '../shared/types';
import { hasAdjustableEffort } from '../shared/execution-accounts';
import { isAutomaticModel } from '../shared/model-selection';
import { Checks } from './CorporatePanel';
import { Select } from './Select';
import { PermissionSwitch as Toggle } from './PermissionSwitch';
import './specialists.css';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
type Profile = AgentProfile & { unavailableReason?: string };
const icons = { bot: Bot, message: MessageCircle, calculator: Calculator, settings: Settings2, database: Database, chart: BarChart3, file: FileText, search: Search };
const iconLabels: Record<SpecialistIcon, string> = { bot: 'Помощник', message: 'Диалог', calculator: 'Расчёты', settings: 'Настройки', database: 'Данные', chart: 'Аналитика', file: 'Документы', search: 'Поиск' };
const builtInIcons: Partial<Record<string, SpecialistIcon>> = { universal: 'message', estimator: 'calculator', technologist: 'settings', accountant: 'database' };
const toolIcons = { 'chat-files': Paperclip };
const newProfile: AgentProfile = { id: '', name: '', description: '', instructions: '', enabled: false, autoConnect: false, model: '', reasoningEffort: 'high', operationIds: ['chat'], datasetIds: [], skillIds: [], allowWrite: false, revision: 0, toolIds: [] };
const editorTabs = [
  { id: 'general', label: 'Основное', icon: Bot },
  { id: 'instructions', label: 'Инструкции', icon: FileText },
  { id: 'tools', label: 'Инструменты', icon: Layers3 },
  { id: 'model', label: 'Модель', icon: Settings2 },
] as const;
type EditorTab = typeof editorTabs[number]['id'];

function profileIcon(profile: AgentProfile): SpecialistIcon {
  return profile.icon ?? (Object.hasOwn(builtInIcons, profile.id) ? builtInIcons[profile.id]! : 'bot');
}
function IconTile({ icon }: { icon: SpecialistIcon }) {
  const Icon = icons[icon];
  return <span className="specialist-icon" aria-hidden="true"><Icon size={23} strokeWidth={1.8} /></span>;
}
export function SpecialistsPanel({ request, globalInstructions, initialProfileId }: {
  request: Request;
  globalInstructions: string;
  initialProfileId?: string;
}) {
  const [profiles, setProfiles] = useState<Profile[]>();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [editing, setEditing] = useState<Profile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('default');
  const [tab, setTab] = useState<EditorTab>('general');
  const [models, setModels] = useState<ModelCatalog>();
  const [modelError, setModelError] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const tabs = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editingProfile = !!editing;

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      request<Profile[]>('/api/admin/profiles', { signal: controller.signal }),
      request<Dataset[]>('/api/admin/datasets', { signal: controller.signal }),
    ]).then(([list, sources]) => {
      if (controller.signal.aborted) return;
      setProfiles(list);
      setDatasets(sources);
      if (initialProfileId) {
        const profile = list.find(item => item.id === initialProfileId);
        if (profile) setEditing({ ...profile });
        else setError('Агент недоступен.');
      }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [initialProfileId, request]);
  useEffect(() => { if (editingProfile) heading.current?.focus(); }, [editingProfile]);
  useEffect(() => {
    if (!editingProfile || tab !== 'model') return;
    const controller = new AbortController();
    setModelsLoading(true);
    setModelError('');
    request<ModelCatalog>(modelRefresh ? '/api/models/refresh' : '/api/models', {
      signal: controller.signal, ...(modelRefresh ? { method: 'POST', body: '{}' } : {}),
    }).then(value => {
      if (!controller.signal.aborted) setModels(value);
    }).catch(error => {
      if (!controller.signal.aborted) setModelError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [request, editingProfile, tab, modelRefresh]);

  const visible = (profiles ?? []).filter(profile => {
    const search = query.trim().toLocaleLowerCase('ru');
    return (filter === 'all' || profile.enabled === (filter === 'enabled')) &&
      [profile.name, profile.description, profile.id].some(value => value.toLocaleLowerCase('ru').includes(search));
  });
  visible.sort((left, right) => {
    if (left.id === 'universal' || right.id === 'universal') return Number(right.id === 'universal') - Number(left.id === 'universal');
    if (sort === 'name') return left.name.localeCompare(right.name, 'ru');
    if (sort === 'enabled') return Number(right.enabled) - Number(left.enabled);
    return 0;
  });

  function edit(profile?: Profile) { setError(''); setTab('general'); setEditing(profile ? { ...profile } : undefined); }
  function update(next: Partial<AgentProfile>) { setEditing(profile => profile ? { ...profile, ...next } : profile); }

  async function save(profile: Profile, close: boolean) {
    setBusy(true);
    setError('');
    try {
      const { id, revision, unavailableReason, ...body } = profile;
      const saved = await request<AgentProfile>('/api/admin/profiles/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ ...body, ...(revision ? { revision } : {}) }),
      });
      setProfiles(current => {
        const list = current ?? [];
        return list.some(item => item.id === id) ? list.map(item => item.id === id ? { ...saved, unavailableReason } : item) : [...list, saved];
      });
      if (close) setEditing(undefined);
      setProfiles(await request<Profile[]>('/api/admin/profiles'));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function addInstructionFiles(files: FileList | null) {
    if (!files || !editing) return;
    const current = editing.instructionFiles ?? [];
    const selected = Array.from(files);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
    if (current.length + selected.length > specialistFileLimits.count ||
      selected.some(file => !/\.(md|txt)$/i.test(file.name) || file.name.length > 120 || file.size > specialistFileLimits.characters * 4)) {
      setError('Добавьте до пяти файлов .md или .txt общим объёмом до 6 000 символов.');
      return;
    }
    setBusy(true);
    try {
      const imported = await Promise.all(selected.map(async file => ({
        name: file.name,
        text: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()),
      })));
      const next = [...current, ...imported];
      if (new Set(next.map(file => file.name.toLowerCase())).size !== next.length ||
        next.some(file => !file.text.trim() || file.text.includes('\0')) ||
        next.reduce((sum, file) => sum + file.text.length, 0) > specialistFileLimits.characters) {
        throw new Error('Выберите непустые файлы с разными именами общим объёмом до 6 000 символов.');
      }
      update({ instructionFiles: next });
    } catch (error) { setError(error instanceof TypeError ? 'Сохраните текстовые файлы в кодировке UTF-8.' : (error as Error).message); }
    finally { setBusy(false); }
  }

  if (!editing) return <div className="specialist-page">
    <header className="specialist-header">
      <IconTile icon="bot" />
      <div><h2 id="settings-section-title">Агенты</h2><p>Помощники для отдельных задач проекта</p></div>
      <button type="button" className="primary" disabled={!profiles || busy} onClick={() => edit(newProfile)}><Plus size={17} />Добавить агента</button>
    </header>
    <div className="specialist-filters">
      <label className="specialist-search"><Search size={17} aria-hidden="true" />
        <input type="search" aria-label="Поиск агентов" placeholder="Поиск агентов" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <Select className="settings-select" label="Статус агентов" value={filter} onChange={setFilter}
        options={[{ value: 'all', label: 'Все агенты' }, { value: 'enabled', label: 'Включённые' }, { value: 'disabled', label: 'Выключенные' }]} />
      <Select className="settings-select" label="Порядок агентов" value={sort} onChange={setSort}
        options={[{ value: 'default', label: 'По умолчанию' }, { value: 'name', label: 'По названию' }, { value: 'enabled', label: 'Включённые сверху' }]} />
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!profiles && !error && <p role="status" className="help">Загрузка…</p>}
    {profiles && !visible.length && <p role="status" className="help">{profiles.length ? 'Агенты не найдены' : 'Добавьте первого агента'}</p>}
    {!!visible.length && <ul className="specialist-list">{visible.map(profile => <li key={profile.id}>
      <IconTile icon={profileIcon(profile)} />
      <div className="specialist-summary">
        <button type="button" className="specialist-name" onClick={() => edit(profile)} disabled={busy}>{profile.name}</button>
        {profile.description && <p>{profile.description}</p>}
        <div className="specialist-meta">
          <span className="specialist-status" data-enabled={profile.enabled}>{profile.id === 'universal' ? 'Встроенный · по умолчанию в чате' : profile.enabled ? 'Включён' : 'Выключен'}</span>
          <span className="specialist-tool-summary"><Layers3 size={15} aria-hidden="true" />{agentTools.filter(tool => tool.id !== 'fastkore' && (profile.toolIds ?? agentToolIds).includes(tool.id)).map(tool => tool.name).join(', ') || 'Без файловых инструментов'}</span>
        </div>
        {profile.enabled && profile.unavailableReason && <p className="specialist-unavailable">{profile.unavailableReason}</p>}
      </div>
      <div className="specialist-row-actions">
        {profile.id !== 'universal' && <Toggle name={'Включить агента «' + profile.name + '»'} checked={profile.enabled} disabled={busy}
          onChange={enabled => void save({ ...profile, enabled }, false)} />}
        <button type="button" className="secondary specialist-configure" onClick={() => edit(profile)} disabled={busy}
          aria-label={'Настроить агента «' + profile.name + '»'}><Pencil size={15} /><span>Настроить</span></button>
      </div>
    </li>)}</ul>}
  </div>;

  const profile = editing;
  const files = profile.instructionFiles ?? [];
  const selectedTools = profile.toolIds ?? agentToolIds;
  const availableModels = models?.models.filter(model => !isAutomaticModel(model.id)) ?? [];
  const modelOptions = [
    { value: '', label: 'Модель диалога' },
    ...(profile.model && !availableModels.some(model => model.id === profile.model)
      ? [{ value: profile.model, label: profile.model + (models ? ' · недоступна' : '') }] : []),
    ...availableModels.map(model => ({ value: model.id, label: model.name })),
  ];
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) void save(profile, true); };
  return <div className="specialist-page specialist-editor">
    <header className="specialist-header">
      <button type="button" className="workspace-icon" disabled={busy} onClick={() => edit()} title="Все агенты" aria-label="Все агенты"><ChevronLeft size={18} /></button>
      <IconTile icon={profileIcon(profile)} />
      <div><h2 ref={heading} id="settings-section-title" tabIndex={-1}>{profile.name || 'Новый агент'}</h2></div>
    </header>
    <form className="specialist-form specialist-editor-form" onSubmit={submit} onInvalid={event => {
      const input = event.target as HTMLInputElement;
      const panel = input.closest('[role="tabpanel"]');
      const destination = editorTabs.find(item => panel?.id === 'specialist-panel-' + item.id);
      if (destination) { setTab(destination.id); requestAnimationFrame(() => input.focus()); }
    }}>
      <div ref={tabs} className="specialist-tabs" role="tablist" aria-label="Настройки агента" onKeyDown={event => {
        const current = editorTabs.findIndex(item => item.id === tab);
        const next = event.key === 'ArrowRight' ? (current + 1) % editorTabs.length : event.key === 'ArrowLeft'
          ? (current + editorTabs.length - 1) % editorTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? editorTabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        setTab(editorTabs[next].id);
        tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {editorTabs.map(({ id, label, icon: Icon }) => <button key={id} id={'specialist-tab-' + id} type="button" role="tab"
          aria-selected={tab === id} aria-controls={'specialist-panel-' + id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
          <Icon size={16} aria-hidden="true" />{label}
        </button>)}
      </div>
      <div role="tabpanel" id="specialist-panel-general" aria-labelledby="specialist-tab-general" className="specialist-tabpanel" hidden={tab !== 'general'} tabIndex={0}>
      <section className="specialist-card">
        <h3>Основная информация</h3>
        <div className="specialist-columns">
          <div><label htmlFor="config-name">Название</label><input id="config-name" maxLength={100} required readOnly={profile.id === 'universal'} value={profile.name} onChange={event => update({ name: event.target.value })} /></div>
          <div><label htmlFor="profile-description">Когда подключать агента</label>
            <input id="profile-description" maxLength={1000} required value={profile.description} aria-describedby="profile-description-help"
              placeholder="Например, для проверки расчётов" onChange={event => update({ description: event.target.value })} />
            <p id="profile-description-help" className="help">{profile.id === 'universal' ? 'Ведёт новые чаты в проектах, где подключён.' : 'Основной агент использует это описание при выборе консультанта.'}</p>
          </div>
          {!profile.revision && <div><label htmlFor="config-id">Идентификатор латиницей</label>
            <input id="config-id" pattern="[a-z][a-z0-9_\-]{1,63}" value={profile.id} required onChange={event => update({ id: event.target.value })} />
          </div>}
        </div>
        <div className="specialist-basics">
          {profile.id === 'universal' ? <span>Встроенный агент</span> : <label className="specialist-enabled">
            <Toggle name="Агент включён" checked={profile.enabled} onChange={enabled => update({ enabled })} />
            {profile.enabled ? 'Агент включён' : 'Агент выключен'}</label>}
          <div className="specialist-icon-select"><label htmlFor="specialist-icon">Иконка</label>
            <Select id="specialist-icon" className="settings-select" value={profileIcon(profile)} onChange={icon => update({ icon: icon as SpecialistIcon })}
              options={specialistIcons.map(value => ({ value, label: iconLabels[value] }))} />
          </div>
          <label className="specialist-enabled"><Toggle name="Автоматически подключать к новым проектам" checked={profile.autoConnect === true}
            disabled={busy} onChange={autoConnect => update({ autoConnect })} />
            Автоматически подключать к новым проектам</label>
        </div>
      </section>
      </div>

      <div role="tabpanel" id="specialist-panel-instructions" aria-labelledby="specialist-tab-instructions" className="specialist-tabpanel" hidden={tab !== 'instructions'} tabIndex={0}>
        <section className="specialist-card specialist-instructions">
          <h3><FileText size={18} aria-hidden="true" /><label htmlFor="config-rules">Инструкции агента</label></h3>
          <textarea id="config-rules" rows={6} maxLength={20000} value={profile.instructions}
            placeholder="Опишите задачу, порядок действий и ожидаемый результат." onChange={event => update({ instructions: event.target.value })} />
        </section>
      <section className="specialist-card specialist-files">
        <div className="specialist-file-header">
          <div><h3><Paperclip size={18} aria-hidden="true" />Файлы инструкций</h3><p className="help">До пяти файлов Markdown или TXT, всего до 6 000 символов.</p></div>
          <input ref={fileInput} type="file" accept=".md,.txt" multiple hidden onChange={event => void addInstructionFiles(event.target.files)} />
          <button type="button" className="secondary" onClick={() => fileInput.current?.click()} disabled={busy || files.length >= specialistFileLimits.count}><Plus size={15} />Добавить файлы</button>
        </div>
        {!!files.length && <ul>{files.map(file => <li key={file.name}>
          <details><summary>{file.name}</summary><pre>{file.text}</pre></details>
          <button type="button" className="workspace-icon" aria-label={'Убрать файл ' + file.name}
            onClick={() => update({ instructionFiles: files.filter(item => item.name !== file.name) })} disabled={busy}><X size={15} /></button>
        </li>)}</ul>}
      </section>
      <details className="specialist-card specialist-disclosure">
        <summary><ChevronDown size={17} aria-hidden="true" />Общие инструкции</summary>
        <pre>{globalInstructions}</pre>
      </details>
      <section className="specialist-card">
          <label htmlFor="profile-skills">Идентификаторы утверждённых Skills через запятую</label>
          <input id="profile-skills" value={profile.skillIds.join(', ')} onChange={event => update({ skillIds: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} />
      </section>
      </div>

      <div role="tabpanel" id="specialist-panel-tools" aria-labelledby="specialist-tab-tools" className="specialist-tabpanel" hidden={tab !== 'tools'} tabIndex={0}>
        <section className="specialist-card">
          <h3><Layers3 size={19} aria-hidden="true" />Инструменты агента</h3>
          <p className="help">Доступ к источникам уточняется в настройках проекта.</p>
          <div className="specialist-tool-list">
            {agentTools.filter(tool => tool.id !== 'fastkore').map(tool => {
              const Tool = toolIcons[tool.id];
              return <label key={tool.id}>
                <input type="checkbox" checked={selectedTools.includes(tool.id)}
                  onChange={event => update({ toolIds: event.target.checked ? [...selectedTools, tool.id] : selectedTools.filter(id => id !== tool.id) })} />
                <Tool size={20} aria-hidden="true" /><span><strong>{tool.name}</strong><small>{tool.description}</small></span>
              </label>;
            })}
          </div>
        </section>
        <section className="specialist-card">
          <Checks label="Библиотеки агента" values={profile.datasetIds} options={datasets} change={datasetIds => update({ datasetIds })} />
        </section>
      </div>

      <div role="tabpanel" id="specialist-panel-model" aria-labelledby="specialist-tab-model" className="specialist-tabpanel" hidden={tab !== 'model'} tabIndex={0}>
      <section className="specialist-card">
          <label htmlFor="profile-model">Модель</label>
          <div className="specialist-model-picker">
            <Select id="profile-model" label="Модель агента" className="settings-select" value={profile.model}
              options={modelOptions} disabled={busy} onChange={model => update({ model })} />
            <button type="button" className="workspace-icon" aria-label="Обновить модели" title="Обновить модели" disabled={modelsLoading}
              onClick={() => setModelRefresh(value => value + 1)}><RefreshCw size={16} className={modelsLoading ? 'spin' : undefined} /></button>
          </div>
          {modelsLoading && <p className="help" role="status">Загрузка моделей…</p>}
          {modelError && <p className="inline-error" role="alert">{modelError}</p>}
          {hasAdjustableEffort(profile.model) && <><label htmlFor="profile-effort">Уровень рассуждения</label><Select id="profile-effort" className="settings-select" value={profile.reasoningEffort}
            onChange={reasoningEffort => update({ reasoningEffort: reasoningEffort as AgentProfile['reasoningEffort'] })}
            options={[{ value: 'low', label: 'Низкий' }, { value: 'medium', label: 'Средний' }, { value: 'high', label: 'Высокий' }, { value: 'xhigh', label: 'Очень высокий' }]} /></>}
      <p className="help">Настройки модели в чате имеют приоритет.</p>
      </section>
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="settings-dialog-actions"><button type="button" className="secondary" onClick={() => edit()} disabled={busy}>Отмена</button>
        <button type="submit" className="primary" disabled={busy}>Сохранить</button></div>
    </form>
  </div>;
}
