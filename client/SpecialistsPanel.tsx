import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BarChart3, Bot, Calculator, ChevronDown, ChevronLeft, Database, FileText, Folder, Layers3, MessageCircle, Paperclip, Pencil, Plus, Search, Settings2, X } from 'lucide-react';
import { agentToolIds, agentTools } from '../shared/agent-tools';
import { specialistFileLimits, specialistIcons, type AgentProfile, type Dataset, type SpecialistIcon } from '../shared/types';
import { Checks, operations } from './CorporatePanel';
import { Select } from './Select';
import { PermissionSwitch as Toggle } from './PermissionSwitch';
import './specialists.css';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
type Profile = AgentProfile & { unavailableReason?: string };
const icons = { bot: Bot, message: MessageCircle, calculator: Calculator, settings: Settings2, database: Database, chart: BarChart3, file: FileText, search: Search };
const iconLabels: Record<SpecialistIcon, string> = { bot: 'Помощник', message: 'Диалог', calculator: 'Расчёты', settings: 'Настройки', database: 'Данные', chart: 'Аналитика', file: 'Документы', search: 'Поиск' };
const builtInIcons: Partial<Record<string, SpecialistIcon>> = { universal: 'message', estimator: 'calculator', technologist: 'settings', accountant: 'database' };
const toolIcons = { 'project-files': Folder, 'chat-files': Paperclip, fastkore: Database };
const newProfile: AgentProfile = { id: '', name: '', description: '', instructions: '', enabled: false, model: '', reasoningEffort: 'high', operationIds: ['chat'], datasetIds: [], skillIds: [], allowWrite: false, outputMode: 'chat', revision: 0, toolIds: [] };

function profileIcon(profile: AgentProfile): SpecialistIcon {
  return profile.icon ?? (Object.hasOwn(builtInIcons, profile.id) ? builtInIcons[profile.id]! : 'bot');
}
function IconTile({ icon }: { icon: SpecialistIcon }) {
  const Icon = icons[icon];
  return <span className="specialist-icon" aria-hidden="true"><Icon size={23} strokeWidth={1.8} /></span>;
}
export function SpecialistsPanel({ request, globalInstructions }: { request: Request; globalInstructions: string }) {
  const [profiles, setProfiles] = useState<Profile[]>();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [editing, setEditing] = useState<Profile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('default');
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editingProfile = !!editing;

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      request<Profile[]>('/api/admin/profiles', { signal: controller.signal }),
      request<Dataset[]>('/api/admin/datasets', { signal: controller.signal }),
    ]).then(([list, sources]) => {
      if (!controller.signal.aborted) { setProfiles(list); setDatasets(sources); }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [request]);
  useEffect(() => { if (editingProfile) heading.current?.focus(); }, [editingProfile]);

  const visible = (profiles ?? []).filter(profile => {
    const search = query.trim().toLocaleLowerCase('ru');
    return (filter === 'all' || profile.enabled === (filter === 'enabled')) &&
      [profile.name, profile.description, profile.id].some(value => value.toLocaleLowerCase('ru').includes(search));
  });
  if (sort === 'name') visible.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  if (sort === 'enabled') visible.sort((left, right) => Number(right.enabled) - Number(left.enabled));

  function edit(profile?: Profile) { setError(''); setEditing(profile ? { ...profile } : undefined); }
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
      <div><h2 id="settings-section-title">Специалисты</h2><p>Помощники для отдельных задач проекта</p></div>
      <button type="button" className="primary" disabled={!profiles || busy} onClick={() => edit(newProfile)}><Plus size={17} />Добавить специалиста</button>
    </header>
    <div className="specialist-filters">
      <label className="specialist-search"><Search size={17} aria-hidden="true" />
        <input type="search" aria-label="Поиск специалистов" placeholder="Поиск специалистов" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <Select className="settings-select" label="Статус специалистов" value={filter} onChange={setFilter}
        options={[{ value: 'all', label: 'Все специалисты' }, { value: 'enabled', label: 'Включённые' }, { value: 'disabled', label: 'Выключенные' }]} />
      <Select className="settings-select" label="Порядок специалистов" value={sort} onChange={setSort}
        options={[{ value: 'default', label: 'По умолчанию' }, { value: 'name', label: 'По названию' }, { value: 'enabled', label: 'Включённые сверху' }]} />
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!profiles && !error && <p role="status" className="help">Загрузка…</p>}
    {profiles && !visible.length && <p role="status" className="help">{profiles.length ? 'Специалисты не найдены' : 'Добавьте первого специалиста'}</p>}
    {!!visible.length && <ul className="specialist-list">{visible.map(profile => <li key={profile.id}>
      <IconTile icon={profileIcon(profile)} />
      <div className="specialist-summary">
        <button type="button" className="specialist-name" onClick={() => edit(profile)} disabled={busy}>{profile.name}</button>
        {profile.description && <p>{profile.description}</p>}
        <div className="specialist-meta">
          <span className="specialist-status" data-enabled={profile.enabled}>{profile.enabled ? 'Включён' : 'Выключен'}</span>
          <span className="specialist-tool-summary"><Layers3 size={15} aria-hidden="true" />{agentTools.filter(tool => (profile.toolIds ?? agentToolIds).includes(tool.id)).map(tool => tool.name).join(', ') || 'Без инструментов'}</span>
        </div>
        {profile.enabled && profile.unavailableReason && <p className="specialist-unavailable">{profile.unavailableReason}</p>}
      </div>
      <div className="specialist-row-actions">
        <Toggle name={'Включить специалиста «' + profile.name + '»'} checked={profile.enabled} disabled={busy}
          onChange={enabled => void save({ ...profile, enabled }, false)} />
        <button type="button" className="secondary specialist-configure" onClick={() => edit(profile)} disabled={busy}
          aria-label={'Настроить специалиста «' + profile.name + '»'}><Pencil size={15} /><span>Настроить</span></button>
      </div>
    </li>)}</ul>}
  </div>;

  const profile = editing;
  const files = profile.instructionFiles ?? [];
  const selectedTools = profile.toolIds ?? agentToolIds;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) void save(profile, true); };
  return <div className="specialist-page">
    <button type="button" className="specialist-back" disabled={busy} onClick={() => edit()}><ChevronLeft size={17} />Все специалисты</button>
    <header className="specialist-header">
      <IconTile icon={profileIcon(profile)} />
      <div><h2 ref={heading} id="settings-section-title" tabIndex={-1}>{profile.revision ? 'Редактирование специалиста' : 'Новый специалист'}</h2>
        {profile.revision ? <p>{profile.name}</p> : null}</div>
    </header>
    <form className="specialist-form" onSubmit={submit}>
      <section className="specialist-card">
        <h3>Основная информация</h3>
        <div className="specialist-columns">
          <div><label htmlFor="config-name">Название</label><input id="config-name" maxLength={100} required value={profile.name} onChange={event => update({ name: event.target.value })} /></div>
          <div><label htmlFor="profile-description">Когда подключать специалиста</label>
            <input id="profile-description" maxLength={1000} required value={profile.description} aria-describedby="profile-description-help"
              placeholder="Например, для проверки расчётов" onChange={event => update({ description: event.target.value })} />
            <p id="profile-description-help" className="help">Codex использует это описание при выборе специалиста.</p>
          </div>
          {!profile.revision && <div><label htmlFor="config-id">Идентификатор латиницей</label>
            <input id="config-id" pattern="[a-z][a-z0-9_\-]{1,63}" value={profile.id} required onChange={event => update({ id: event.target.value })} />
          </div>}
        </div>
        <div className="specialist-basics">
          <label className="specialist-enabled"><Toggle name="Специалист включён" checked={profile.enabled} onChange={enabled => update({ enabled })} />
            {profile.enabled ? 'Специалист включён' : 'Специалист выключен'}</label>
          <div className="specialist-icon-select"><label htmlFor="specialist-icon">Иконка</label>
            <Select id="specialist-icon" className="settings-select" value={profileIcon(profile)} onChange={icon => update({ icon: icon as SpecialistIcon })}
              options={specialistIcons.map(value => ({ value, label: iconLabels[value] }))} />
          </div>
        </div>
      </section>
      <div className="specialist-columns">
        <section className="specialist-card specialist-instructions">
          <h3><FileText size={18} aria-hidden="true" /><label htmlFor="config-rules">Инструкции специалиста</label></h3>
          <textarea id="config-rules" rows={6} maxLength={20000} value={profile.instructions}
            placeholder="Опишите задачу, порядок действий и ожидаемый результат." onChange={event => update({ instructions: event.target.value })} />
        </section>
        <section className="specialist-card">
          <h3><Layers3 size={19} aria-hidden="true" />Инструменты специалиста</h3>
          <p className="help">Доступ к источникам уточняется в настройках проекта.</p>
          <div className="specialist-tool-list">
            {agentTools.map(tool => {
              const Tool = toolIcons[tool.id];
              return <label key={tool.id}>
                <input type="checkbox" checked={selectedTools.includes(tool.id)}
                  onChange={event => update({ toolIds: event.target.checked ? [...selectedTools, tool.id] : selectedTools.filter(id => id !== tool.id) })} />
                <Tool size={20} aria-hidden="true" /><span><strong>{tool.name}</strong><small>{tool.description}</small></span>
              </label>;
            })}
          </div>
        </section>
      </div>
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
      <details className="specialist-card specialist-disclosure">
        <summary><ChevronDown size={17} aria-hidden="true" />Модель и дополнительные настройки</summary>
        <div className="specialist-advanced">
          <label htmlFor="profile-model">Модель</label><input id="profile-model" maxLength={128} value={profile.model} placeholder="Модель диалога" onChange={event => update({ model: event.target.value })} />
          <label htmlFor="profile-effort">Уровень рассуждения</label><Select id="profile-effort" className="settings-select" value={profile.reasoningEffort}
            onChange={reasoningEffort => update({ reasoningEffort: reasoningEffort as AgentProfile['reasoningEffort'] })}
            options={[{ value: 'low', label: 'Низкий' }, { value: 'medium', label: 'Средний' }, { value: 'high', label: 'Высокий' }, { value: 'xhigh', label: 'Очень высокий' }]} />
          <Checks label="Разрешённые операции" values={profile.operationIds} options={Object.entries(operations).map(([id, name]) => ({ id, name }))} change={operationIds => update({ operationIds })} />
          <label htmlFor="profile-output">Выдача результата</label><Select id="profile-output" className="settings-select" value={profile.outputMode}
            onChange={outputMode => update({ outputMode: outputMode as AgentProfile['outputMode'] })}
            options={[{ value: 'chat', label: 'Обычный чат проекта' }, { value: 'restricted', label: 'Проверяемый результат закрытой операции' }]} />
          <label className="check-setting"><input type="checkbox" checked={profile.allowWrite} onChange={event => update({ allowWrite: event.target.checked })} />Разрешить запись, если она включена на сервере</label>
          <Checks label="Библиотеки специалиста" values={profile.datasetIds} options={datasets} change={datasetIds => update({ datasetIds })} />
          <label htmlFor="profile-skills">Идентификаторы утверждённых Skills через запятую</label>
          <input id="profile-skills" value={profile.skillIds.join(', ')} onChange={event => update({ skillIds: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} />
        </div>
      </details>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="settings-dialog-actions"><button type="button" className="secondary" onClick={() => edit()} disabled={busy}>Отмена</button>
        <button type="submit" className="primary" disabled={busy}>Сохранить</button></div>
    </form>
  </div>;
}
