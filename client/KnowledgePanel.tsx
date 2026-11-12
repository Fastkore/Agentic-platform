import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, FileText, Pencil, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { KnowledgeFile, KnowledgeOverview, KnowledgeSection } from '../shared/knowledge';
import './knowledge.css';

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function KnowledgePanel({ section, request, download, dirtyChanged }: {
  section: KnowledgeSection;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  download: (url: string) => Promise<Blob>;
  dirtyChanged: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<KnowledgeOverview>();
  const [summary, setSummary] = useState('');
  const [editor, setEditor] = useState<{ file: KnowledgeFile; original: string; text: string }>();
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const replacement = useRef<KnowledgeFile | undefined>(undefined);
  const route = '/api/admin/knowledge/' + section;
  const fileRoute = (file: KnowledgeFile) => route + '/files/' + encodeURIComponent(file.id);
  const dirty = summary !== (data?.summary ?? '') || !!editor && editor.text !== editor.original;
  useEffect(() => { dirtyChanged(dirty); return () => dirtyChanged(false); }, [dirty, dirtyChanged]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    request<KnowledgeOverview>(route, { signal: controller.signal }).then(value => { setData(value); setSummary(value.summary); })
      .catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [route, request]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function reload() { setData(await request<KnowledgeOverview>(route)); }
  async function upload(file: File, existing?: KnowledgeFile) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Максимальный размер файла — 20 МБ.');
    const form = new FormData(); form.append('file', file);
    await request(existing ? fileRoute(existing) + '?revision=' + encodeURIComponent(existing.revision) : route + '/files', {
      method: existing ? 'PUT' : 'POST', body: form,
    });
    await reload();
  }
  async function open(file: KnowledgeFile) {
    const text = await (await download(fileRoute(file))).text();
    setEditor({ file, original: text, text }); setPreview(false);
  }
  function closeEditor() {
    if (editor && editor.text !== editor.original && !window.confirm('Закрыть документ и удалить несохранённые изменения?')) return;
    setEditor(undefined);
  }
  return <div className="knowledge-panel">
    <p className="help">{section === 'fastkore'
      ? 'Общие руководства входят в поставку платформы. Обновляйте их по мере развития Fastkore.'
      : 'Материалы компании доступны всем агентам этой установки. Загружайте регламенты, справочники и другие рабочие документы.'}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p role="status">Загрузка…</p> : editor ? <div className="knowledge-editor">
      <div className="knowledge-toolbar"><h3>{editor.file.name}</h3><button className="secondary" disabled={busy} onClick={closeEditor}>К списку</button></div>
      <div className="knowledge-toolbar">
        <div className="button-pair"><button className="secondary" aria-pressed={!preview} onClick={() => setPreview(false)}>Текст</button>
          <button className="secondary" aria-pressed={preview} onClick={() => setPreview(true)}>Просмотр</button></div>
        <button className="secondary" onClick={() => downloadBlob(new Blob([editor.text], { type: 'text/plain;charset=utf-8' }), editor.file.name)}>Скачать текст</button>
      </div>
      {preview ? <div className="knowledge-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{editor.text}</ReactMarkdown></div>
        : <textarea aria-label={'Текст ' + editor.file.name} spellCheck={false} value={editor.text} disabled={busy}
          onChange={event => setEditor({ ...editor, text: event.target.value })} />}
      <div className="knowledge-toolbar"><button className="primary" disabled={busy || editor.text === editor.original} onClick={() => void action(async () => {
        await upload(new File([editor.text], editor.file.name, { type: 'text/plain' }), editor.file);
        setEditor(undefined); setNotice('Документ обновлён. Поиск и оглавление перестроены.');
      })}>Сохранить</button></div>
    </div> : <>
      <form className="knowledge-summary" onSubmit={event => { event.preventDefault(); void action(async () => {
        const updated = await request<KnowledgeOverview>(route, { method: 'PUT', body: JSON.stringify({ summary, revision: data.revision }) });
        setData(updated); setSummary(updated.summary); setNotice('Памятка сохранена.');
      }); }}>
        <label htmlFor={'knowledge-summary-' + section}>Краткая памятка агенту</label>
        <p className="help" id="knowledge-summary-help">Что нужно знать о среде и какие материалы искать. Памятка и каталог передаются при открытии сессии и после обновлений. Подробности агент читает по запросу.</p>
        <textarea id={'knowledge-summary-' + section} aria-describedby="knowledge-summary-help" rows={5} maxLength={4000} value={summary} disabled={busy} onChange={event => setSummary(event.target.value)} />
        <button className="secondary" disabled={busy || summary === data.summary}>Сохранить памятку</button>
      </form>
      <div className="knowledge-toolbar"><h3>Файлы</h3><button className="primary" disabled={busy} onClick={() => { replacement.current = undefined; picker.current?.click(); }}><Upload size={16} />Загрузить</button></div>
      <input type="file" ref={picker} hidden multiple onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []), existing = replacement.current;
        event.currentTarget.value = '';
        if (existing && files.length !== 1) { setError('Для замены выберите один файл.'); return; }
        if (files.length) void action(async () => {
          for (const file of files) await upload(file, existing);
          setNotice('Файлы загружены. Поиск и оглавление обновлены.');
        });
      }} />
      {!data.files.length && <p className="help">Добавьте первый файл с информацией о компании.</p>}
      <ul className="knowledge-files">
        {data.files.map(file => <li key={file.id}>
          <FileText size={20} aria-hidden="true" />
          <div className="knowledge-file-info"><strong>{file.name}</strong>
            <small>{new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(file.size / 1024)} КБ · {new Date(file.updatedAt).toLocaleDateString('ru')}
              {file.extraction === 'excerpt' && ' · Агенту доступна выдержка'}{file.extraction === 'unavailable' && ' · Извлечение текста недоступно'}</small></div>
          <div className="knowledge-file-actions">
            {file.editable && <button className="workspace-icon" aria-label={'Редактировать ' + file.name} title="Редактировать" disabled={busy} onClick={() => void action(() => open(file))}><Pencil size={16} /></button>}
            <button className="workspace-icon" aria-label={'Заменить ' + file.name} title="Заменить файлом" disabled={busy} onClick={() => { replacement.current = file; picker.current?.click(); }}><RefreshCw size={16} /></button>
            <button className="workspace-icon" aria-label={'Скачать ' + file.name} title="Скачать" disabled={busy} onClick={() => void action(async () => downloadBlob(await download(fileRoute(file)), file.name))}><Download size={16} /></button>
            <button className="workspace-icon" aria-label={'Удалить ' + file.name} title="Удалить" disabled={busy} onClick={() => setRemoving(file.id)}><Trash2 size={16} /></button>
          </div>
          {removing === file.id && <div className="knowledge-delete"><span>Удалить документ из базы знаний?</span><button className="secondary" disabled={busy} onClick={() => setRemoving(undefined)}>Отмена</button><button className="danger" disabled={busy} onClick={() => void action(async () => {
            await request(fileRoute(file), { method: 'DELETE', body: JSON.stringify({ revision: file.revision }) });
            setRemoving(undefined); await reload();
          })}>Удалить</button></div>}
        </li>)}
      </ul>
      <p className="help">До 20 МБ на файл. Текстовые файлы UTF-8 доступны агенту полностью по фрагментам. Из PDF и XLSX извлекается краткая выдержка. Оригиналы всех файлов можно скачать.</p>
    </>}
  </div>;
}
