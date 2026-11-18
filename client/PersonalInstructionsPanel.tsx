import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Download, FileText, Folder, Layers, Plus, Search, Trash2, Undo2, Upload, Users } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { instructionTile, personalInstructionLimits as limits, type PersonalInstructions, type PersonalInstructionsEdit, type PersonalInstructionsView, type SharedWorkNote, type WorkNote } from '../shared/personal-instructions';
import type { FastkoreContext } from '../shared/fastkore-context';
import { PermissionSwitch } from './PermissionSwitch';

const personalEndpoint = '/api/me/instructions';
const adminEndpoint = '/api/admin/instructions';
type Scope = NonNullable<WorkNote['scope']>['kind'];
type DraftNote = Omit<WorkNote, 'id'> & { id?: string; key: string; pendingScope?: Scope };
type Draft = Omit<PersonalInstructions, 'notes'> & { notes: DraftNote[] };
type Author = { id: string; name: string; role?: string };
type TreeNote = DraftNote & { authorName?: string };
const toDraft = ({ text, autoInstructions, revision, notes }: PersonalInstructions): Draft =>
  ({ text, autoInstructions, revision, notes: notes.map(note => ({ ...note, key: note.id })) });

function downloadNote(note: TreeNote) {
  const title = note.title.trim().replace(/\s+/g, ' ');
  const name = 'work-note-' + (note.id?.slice(0, 8) ?? Date.now().toString(36));
  const skill = `---\nname: ${name}\ndescription: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n${note.text.trim()}\n`;
  const url = URL.createObjectURL(new Blob([skill], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'SKILL.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PersonalInstructionsPanel({ request, project, erp, context, administration, dirtyChanged }: {
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  project?: { id: string; name: string };
  erp: boolean;
  context?: FastkoreContext;
  administration?: boolean;
  dirtyChanged: (dirty: boolean) => void;
}) {
  const [scopeContext] = useState(context);
  const tile = instructionTile(scopeContext);
  const currentComponent = scopeContext?.view !== 'none' ? scopeContext?.entity_set_name : undefined;
  const [saved, setSaved] = useState<Draft>();
  const [draft, setDraft] = useState<Draft>();
  const [sharedNotes, setSharedNotes] = useState<SharedWorkNote[]>([]);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [authors, setAuthors] = useState<Author[]>([]);
  const [authorId, setAuthorId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const endpoint = administration ? authorId && adminEndpoint + '/' + encodeURIComponent(authorId) : personalEndpoint;
  useEffect(() => { dirtyChanged(dirty); return () => dirtyChanged(false); }, [dirty, dirtyChanged]);

  function load(signal?: AbortSignal) {
    setBusy(true); setError(''); setNotice('');
    return request<PersonalInstructionsView>(endpoint, { signal }).then(document => {
      if (signal?.aborted) return;
      const next = toDraft(document);
      setSaved(next); setDraft(next); setSharedNotes(document.sharedNotes ?? []); setSelected('');
      setSearch(''); setCollapsed(new Set()); setConflict(false);
    }).catch(cause => {
      if (!signal?.aborted) setError((cause as Error).message);
    }).finally(() => { if (!signal?.aborted) setBusy(false); });
  }
  useEffect(() => {
    if (!administration) return;
    const controller = new AbortController();
    request<Author[]>(adminEndpoint, { signal: controller.signal }).then(list => {
      if (controller.signal.aborted) return;
      setAuthors(list); setAuthorId(list[0]?.id ?? ''); setBusy(!!list.length);
    }).catch(cause => {
      if (!controller.signal.aborted) { setError((cause as Error).message); setBusy(false); }
    });
    return () => controller.abort();
  }, [request, administration]);
  useEffect(() => {
    if (!endpoint) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [request, endpoint]);

  const notes: TreeNote[] = [...(draft?.notes ?? []), ...sharedNotes.map(note => ({ ...note, key: 'shared-' + note.id }))];
  const note = notes.find(item => item.key === selected);
  const canEdit = !note?.authorName;
  const groups = new Map<string, { label: string; hint?: string; notes: TreeNote[] }>([['general', { label: 'Общие', notes: [] }]]);
  for (const item of notes) {
    const kind = item.scope?.kind ?? item.pendingScope;
    const id = item.scope?.id ?? (kind === 'project' ? project?.id : '');
    const source = item.tile ?? (item.pendingScope === 'erp' ? tile : undefined);
    const component = item.component?.name ?? (item.pendingScope === 'erp' ? currentComponent : undefined);
    const componentId = item.component?.entitySetId ?? (item.pendingScope === 'erp' && scopeContext?.view !== 'none' ? scopeContext?.entity_set_id : undefined);
    const types = item.component?.types ?? (item.pendingScope === 'erp' && scopeContext?.view !== 'none' ? scopeContext?.entity_types : undefined);
    const typeIds = item.component?.typeIds ?? types?.map(type => type.id);
    const typeNames = types?.map(type => type.name).join(', ');
    const key = kind ? [kind, id, componentId ?? source?.tileId, typeIds?.join(',')].join(':') : 'general';
    const label = item.scope?.label ?? (kind === 'project' ? project?.name ?? 'Проект' : 'Fastkore');
    const group = groups.get(key) ?? { label: component && typeNames ? component + ' · ' + typeNames : component ?? source?.tileName ?? label,
      hint: component || source ? label : undefined, notes: [] };
    group.notes.push(item);
    groups.set(key, group);
  }
  const text = note?.text ?? draft?.text ?? '';
  const change = (next: Draft) => { setDraft(next); setNotice(''); };
  function updateNote(changes: Partial<DraftNote>) {
    if (draft) change({ ...draft, notes: draft.notes.map(item => item.key === selected ? { ...item, ...changes } : item) });
  }
  function addNote(title = 'Новый приём', text = '') {
    if (!draft || draft.notes.length >= limits.notes) return;
    const key = 'new-' + ++counter.current;
    const pendingScope = erp && scopeContext && scopeContext.view !== 'none' ? 'erp' : undefined;
    change({ ...draft, notes: [...draft.notes, { key, title, text, pendingScope }] });
    setSearch(''); setCollapsed(new Set());
    setSelected(key); setError('');
  }
  async function importNote(file: File) {
    try {
      if (file.size > 8_000) throw new Error('Выберите Markdown-файл с одним коротким приёмом.');
      const markdown = (await file.text()).replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim();
      const body = markdown.replace(/^---\n[\s\S]*?\n---\s*/, '');
      const heading = /^#\s+([^\n]+)\n*/.exec(body);
      const title = (heading?.[1] ?? file.name.replace(/\.md$/i, '')).trim();
      const text = body.slice(heading?.[0].length ?? 0).trim();
      if (!title || title.length > limits.title || !text || text.length > limits.note) throw new Error('В приёме помещается до 100 символов в названии и до 600 в тексте.');
      addNote(title, text);
    } catch (cause) { setError((cause as Error).message); }
  }
  async function save() {
    if (!draft) return;
    setBusy(true); setError(''); setNotice(''); setConflict(false);
    const payload: PersonalInstructionsEdit = {
      text: draft.text, autoInstructions: draft.autoInstructions, revision: draft.revision,
      notes: draft.notes.map(({ id, text, title, pendingScope, common }) => ({
        id, text, title, scope: pendingScope, common: administration ? !!common : undefined,
      })),
      projectId: draft.notes.some(item => item.pendingScope === 'project') ? project?.id : undefined,
      context: draft.notes.some(item => item.pendingScope === 'erp') ? scopeContext : undefined,
    };
    try {
      const document = await request<PersonalInstructionsView>(endpoint, { method: 'PUT', body: JSON.stringify(payload) });
      const next = toDraft(document);
      const index = draft.notes.findIndex(item => item.key === selected);
      setSaved(next); setDraft(next); setSharedNotes(document.sharedNotes ?? []);
      if (!note?.authorName) setSelected(next.notes[index]?.key ?? '');
      setNotice('Сохранено');
    } catch (cause) {
      setConflict((cause as { status?: number }).status === 409);
      setError((cause as Error).message);
    } finally { setBusy(false); }
  }

  const query = search.trim().toLocaleLowerCase('ru');
  const matches = (...values: string[]) => !query || values.some(value => value.toLocaleLowerCase('ru').includes(query));
  const visibleGroups = [...groups].map(([key, group]) => ({
    key, ...group, hasInstructions: key === 'general' && matches('Указания', draft?.text ?? '', group.label),
    visible: group.notes.filter(item => matches(item.title, item.text, item.authorName ?? '', group.label, group.hint ?? '')),
  })).filter(group => group.hasInstructions || group.visible.length);
  const canSave = draft && !busy && dirty && draft.notes.every(item => item.title.trim() && item.text.trim());
  const title = note ? note.title || 'Новый приём' : 'Указания';
  const textLabel = note ? 'Текст приёма' : 'Текст указаний';
  const textLimit = note ? limits.note : limits.instructions;

  function revert() {
    if (!saved) return;
    change(saved); setError(''); setConflict(false);
    if (note && canEdit && !saved.notes.some(item => item.key === note.key)) setSelected('');
  }

  function remove() {
    if (!draft || !canEdit) return;
    if (note) {
      change({ ...draft, notes: draft.notes.filter(item => item.key !== note.key) });
      setSelected('');
    } else change({ ...draft, text: '' });
  }

  return <div className="personal-settings">
    <aside className="personal-sidebar">
      <div className="personal-sidebar-top">
        {administration && <div className="personal-sidebar-title">
          <span className="personal-file-icon"><Layers size={23} aria-hidden="true" /></span>
          <h2>Инструкции сотрудников</h2>
          {draft && <span className="personal-badge">{notes.length + 1}</span>}
        </div>}
        {administration ? <select aria-label="Сотрудник" value={authorId} disabled={busy || !authors.length} onChange={event => {
          if (dirty && !window.confirm('Перейти к другому сотруднику и сбросить правки?')) return;
          setDraft(undefined); setSaved(undefined); setAuthorId(event.target.value);
        }}>
          {!authors.length && <option value="">Сотрудники</option>}
          {authors.map(author => <option key={author.id} value={author.id}>{author.name}{author.role ? ' · ' + author.role : ''}</option>)}
        </select> : <div className="personal-add-actions">
          <button type="button" className="secondary" disabled={busy || !draft || draft.notes.length >= limits.notes} onClick={() => addNote()}>
            <Plus size={17} aria-hidden="true" />Добавить
          </button>
          <button type="button" className="secondary" disabled={busy || !draft || draft.notes.length >= limits.notes} onClick={() => upload.current?.click()}>
            <Upload size={17} aria-hidden="true" />Импорт
          </button>
          <input ref={upload} type="file" hidden accept=".md,text/markdown,text/plain" onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importNote(file);
          }} />
        </div>}
        <div className="personal-search">
          <Search size={17} aria-hidden="true" />
          <input type="search" aria-label="Поиск по инструкциям" placeholder="Поиск по инструкциям…" value={search}
            disabled={!draft} onChange={event => { setSearch(event.target.value); setCollapsed(new Set()); }} />
        </div>
      </div>
      {draft && <nav className="personal-tree" aria-label="Дерево инструкций">
        {visibleGroups.map(group => <details key={group.key} open={!collapsed.has(group.key)}>
          <summary title={group.hint} onClick={event => {
            event.preventDefault();
            setCollapsed(current => {
              const next = new Set(current);
              if (next.has(group.key)) next.delete(group.key);
              else next.add(group.key);
              return next;
            });
          }}>
            <ChevronRight className="personal-group-arrow" size={16} aria-hidden="true" />
            <Folder size={19} aria-hidden="true" /><span className="personal-group-name">{group.label}</span>
            <span className="personal-badge">{group.visible.length + Number(group.hasInstructions)}</span>
          </summary>
          {group.hasInstructions && <button type="button" className="workspace-row" aria-current={!selected ? 'page' : undefined}
            onClick={() => setSelected('')}><FileText size={16} aria-hidden="true" /><span>Указания</span></button>}
          {group.visible.map(item => <button type="button" className="workspace-row" key={item.key} title={item.title}
            aria-current={selected === item.key ? 'page' : undefined} onClick={() => setSelected(item.key)}>
            <FileText size={16} aria-hidden="true" /><span>{item.title || 'Новый приём'}</span>
            {item.authorName && <Users className="personal-shared-icon" size={15} aria-label="Приём коллеги" />}
          </button>)}
        </details>)}
        {query && !visibleGroups.length && <p className="help">Ничего не найдено.</p>}
      </nav>}
      {!administration && draft && <label className="personal-toggle">
        <PermissionSwitch name="Автоинструкции" checked={draft.autoInstructions} disabled={busy}
          onChange={autoInstructions => change({ ...draft, autoInstructions })} />
        <strong>Автоинструкции</strong>
        <small>Агент сохраняет проверенный<br />способ работы из ваших чатов.</small>
      </label>}
    </aside>
    <section className="personal-editor" aria-label={note ? 'Рабочий приём' : 'Указания сотрудника'}>
      {draft && <header className="personal-editor-header">
        <span className="personal-file-icon"><FileText size={30} aria-hidden="true" /></span>
        <div className="personal-heading">
          {note && canEdit ? <textarea className="personal-title-input" aria-label="Название" placeholder="Новый приём"
            rows={1} value={note.title} maxLength={limits.title} disabled={busy}
            onChange={event => updateNote({ title: event.target.value.replace(/[\r\n]+/g, ' ') })} /> : <h3>{title}</h3>}
        </div>
        <div className="personal-editor-actions">
          {canEdit && <button type="button" className="workspace-icon personal-save" aria-label="Сохранить" title="Сохранить" disabled={!canSave}
            onClick={() => void save()}><Check size={22} aria-hidden="true" /></button>}
          {canEdit && <button type="button" className="workspace-icon" aria-label="Отменить правки" title="Отменить правки" disabled={!dirty || busy}
            onClick={revert}><Undo2 size={20} aria-hidden="true" /></button>}
          {note && <button type="button" className="workspace-icon" aria-label="Скачать SKILL.md" title="Скачать SKILL.md"
            disabled={!note.title.trim() || !note.text.trim()} onClick={() => downloadNote(note)}><Download size={19} aria-hidden="true" /></button>}
          {canEdit && <button type="button" className="workspace-icon personal-delete" aria-label={note ? 'Удалить приём' : 'Очистить указания'}
            title={note ? 'Удалить приём' : 'Очистить указания'} disabled={busy || !note && !text}
            onClick={remove}><Trash2 size={19} aria-hidden="true" /></button>}
        </div>
      </header>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      {conflict && <button type="button" className="secondary personal-reload" onClick={() => {
        if (window.confirm('Загрузить актуальную версию и сбросить черновик?')) void load();
      }}>Загрузить актуальную версию</button>}
      {!draft && (busy ? <p role="status">Загрузка…</p> : error && endpoint ?
        <button type="button" className="secondary personal-reload" onClick={() => void load()}>Повторить</button> :
        !error && <p className="help">Сохранённых инструкций пока нет.</p>)}
      {draft && administration && note && <label className="personal-publish">
        <PermissionSwitch name="Доступен всем ролям" checked={!!note.common} disabled={busy}
          onChange={checked => updateNote({ common: checked ? true : undefined })} />
        <span>Доступен всем ролям</span>
      </label>}
      {draft && (canEdit ? <>
        {note && !note.id && <div className="personal-fields">
          <label>Применение
            <select value={note.pendingScope ?? ''} disabled={busy} onChange={event => updateNote({ pendingScope: event.target.value as Scope || undefined })}>
              <option value="">Все личные чаты</option>
              {project && <option value="project">Проект · {project.name}</option>}
              {erp && <option value="erp">{currentComponent ?? 'Текущая установка Fastkore'}</option>}
            </select></label>
        </div>}
        <textarea className="personal-text" aria-label={textLabel} value={text} maxLength={textLimit} disabled={busy}
          onChange={event => note ? updateNote({ text: event.target.value }) : change({ ...draft, text: event.target.value })} />
      </> : <div className="markdown personal-preview">
        {text.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{text}</ReactMarkdown> :
          <p className="help">{note ? 'Добавьте описание приёма.' : 'Добавьте указания здесь или скажите в личном чате «Запиши в мою инструкцию…».'}</p>}
      </div>)}
      {draft && (notice || text.length > 0) && <footer className="personal-editor-footer">
        <small role="status">{notice}</small>
        <small>{text.length} / {textLimit}</small>
      </footer>}
    </section>
  </div>;
}
