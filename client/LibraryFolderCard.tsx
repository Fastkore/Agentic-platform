import { useCallback, useEffect, useState } from 'react';
import { FilePlus2, FileText, Folder, FolderOpen, ListX, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { LibraryFolderSummary, OperationMode } from '../shared/library';
import { formatBytes, type Request } from './library-upload';
import { LibraryUploadPanel } from './LibraryUploadPanel';

interface Problems { counts: Record<string, number>; files: { path: string; state: string; note: string | null }[] }
interface Tree { path: string; entries: { name: string; type: 'dir' | 'file'; fileId?: string; size?: number; extraction?: string }[]; next?: string }
export const problemStates: Record<string, string> = {
  timeout: 'Таймаут', failed: 'Ошибка извлечения', unsupported_encoding: 'Кодировка не поддерживается', unsupported_format: 'Формат не поддерживается',
  ocr_required: 'Требуется распознавание', pending: 'Ожидает обработки',
};
const date = (value?: string) => value ? new Date(value).toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' }) : '';

/** One line about the folder: current content, update in progress, last failure. */
export function folderLine(folder: LibraryFolderSummary) {
  const parts: string[] = [];
  const op = folder.operation;
  if (folder.current) {
    parts.push(`${folder.current.files.toLocaleString('ru')} файлов · ${formatBytes(folder.current.bytes)}`);
    const without = folder.current.unsupported + folder.current.errors;
    if (without) parts.push(`без поиска ${without}`);
    if (folder.updatedAt) parts.push('обновлено ' + date(folder.updatedAt));
  } else parts.push('Материалов пока нет');
  if (op?.status === 'open') parts.push('незавершённая загрузка');
  if (op?.status === 'preparing') parts.push(op.processing ? `подготовка ${op.processing.coverage.indexed + op.processing.coverage.unsupported + op.processing.coverage.errors} из ${op.processing.coverage.files}` : 'подготовка');
  if (folder.failed && !op) parts.push('последнее обновление не опубликовано');
  return parts.join(' · ');
}

/** Folder card shared by «Настройки → Библиотека» and «Проект → Библиотека»: upload, update, files, errors. */
export function LibraryFolderCard({ request, folder, isAdmin, reload }: { request: Request; folder: LibraryFolderSummary; isAdmin: boolean; reload: () => void }) {
  const base = '/api/library/' + encodeURIComponent(folder.id);
  const [upload, setUpload] = useState<OperationMode>();
  const [problems, setProblems] = useState<{ failed: boolean; data: Problems }>();
  const [tree, setTree] = useState<Tree>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const canManage = folder.canManage || isAdmin;
  const preparing = folder.operation?.status === 'preparing';
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, [preparing, reload]);
  async function act(work: () => Promise<unknown>, done?: string) {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try { await work(); reload(); if (done) setNotice(done); } catch (e) { setError((e as Error).message); reload(); } finally { setPending(false); }
  }
  const post = (url: string, body: unknown = {}) => request(url, { method: 'POST', body: JSON.stringify(body) });
  const browse = useCallback(async (path: string) => { setTree(await request<Tree>(`${base}/tree?path=${encodeURIComponent(path)}`)); }, [base, request]);
  const showProblems = (failed: boolean) => act(async () => setProblems({ failed, data: await request<Problems>(`${base}/problems${failed ? '?failed=1' : ''}`) }));
  const projects = folder.projects.map(p => p.name ?? p.id);
  const removeFile = (path: string) => {
    const where = projects.length ? `\nФайл исчезнет во всех подключённых проектах: ${projects.join(', ')}.` : '';
    if (!confirm(`Удалить «${path}» из папки «${folder.name}»?${where}`)) return;
    void act(async () => { await post(`${base}/remove-files`, { paths: [path] }); if (tree) await browse(tree.path); }, 'Файл удалён из папки.');
  };
  const crumbs = tree ? tree.path.split('/').filter(Boolean) : [];

  return <div className="library-card-body">
    {upload ? <LibraryUploadPanel request={request} folder={folder} mode={upload} canDecideSecrets={canManage} close={() => setUpload(undefined)} done={reload} /> : <>
      {folder.failed && !folder.operation && <p className="library-warning" role="status">
        Последнее обновление не опубликовано: {folder.failed.failure === 'conflict' ? 'папку уже обновила другая операция.'
          : `не обработано файлов ${folder.failed.coverage.errors}. Агент пока использует прежнее содержимое.`}</p>}
      {folder.operation?.status === 'preparing' && <p className="help" role="status">Идёт подготовка к поиску. До её окончания агент использует прежнее содержимое папки.</p>}
      <div className="settings-actions library-card-actions">
        {folder.canUpload && <>
          <button type="button" className="secondary" disabled={pending || preparing} onClick={() => setUpload('replace')}>
            {folder.operation?.status === 'open' ? <><Upload size={16} aria-hidden="true" />Продолжить загрузку</>
              : <><FolderOpen size={16} aria-hidden="true" />{folder.current ? 'Обновить из папки' : 'Загрузить папку'}</>}</button>
          {folder.operation?.status !== 'open' && <button type="button" className="secondary" disabled={pending || preparing} onClick={() => setUpload('add')}><FilePlus2 size={16} aria-hidden="true" />Добавить файлы</button>}
        </>}
        {folder.current && <button type="button" className="secondary" aria-expanded={!!tree} disabled={pending} onClick={() => tree ? setTree(undefined) : void act(() => browse(''))}>
          <Folder size={16} aria-hidden="true" />Файлы</button>}
        {!!folder.current && folder.current.unsupported + folder.current.errors > 0 && <button type="button" className="secondary" disabled={pending}
          onClick={() => problems && !problems.failed ? setProblems(undefined) : void showProblems(false)}><ListX size={16} aria-hidden="true" />Файлы без поиска</button>}
        {folder.failed && !folder.operation && <button type="button" className="secondary" disabled={pending}
          onClick={() => problems?.failed ? setProblems(undefined) : void showProblems(true)}><ListX size={16} aria-hidden="true" />Что не обработано</button>}
        {folder.canUpload && !folder.operation && (folder.failed || folder.current?.errors) ? <button type="button" className="secondary" disabled={pending}
          onClick={() => void act(() => post(`${base}/retry`), 'Повторная обработка запущена.')}><RefreshCw size={16} aria-hidden="true" />Повторить обработку</button> : null}
        {canManage && folder.failed?.failure === 'partial_index' && !folder.operation && <button type="button" className="secondary" disabled={pending} onClick={() => {
          if (confirm('Опубликовать обновление с необработанными файлами? Агент будет предупреждён о неполном покрытии.')) void act(() => post(`${base}/accept-coverage`), 'Обновление опубликовано с неполным покрытием.');
        }}>Принять с неполным покрытием</button>}
      </div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    {problems && <div className="library-problems">
      <p className="help">{Object.entries(problems.data.counts).map(([state, n]) => `${problemStates[state] ?? state}: ${n}`).join(' · ') || 'Все файлы обработаны.'}</p>
      <ul>{problems.data.files.map(f => <li key={f.path}><b>{problemStates[f.state] ?? f.state}</b> <code>{f.path}</code>{f.note ? ` — ${f.note}` : ''}</li>)}</ul>
      {problems.data.files.length >= 500 && <p className="help">Показаны первые 500 файлов.</p>}
    </div>}
    {tree && <div className="library-browser">
      <nav className="library-breadcrumb" aria-label="Путь">
        <button type="button" onClick={() => void act(() => browse(''))}>{folder.name}</button>
        {crumbs.map((name, i) => <span key={i}>/ <button type="button" onClick={() => void act(() => browse(crumbs.slice(0, i + 1).join('/')))}>{name}</button></span>)}
      </nav>
      <ul className="library-files">{tree.entries.map(entry => <li key={entry.name}>
        {entry.type === 'dir' ? <><Folder size={15} aria-hidden="true" /><span><button type="button" className="library-dir" onClick={() => void act(() => browse(tree.path + entry.name))}>{entry.name}</button></span></>
          : <><FileText size={15} aria-hidden="true" /><span>{entry.name} <small>{formatBytes(entry.size ?? 0)}{entry.extraction && !['indexed', 'limited'].includes(entry.extraction) ? ' · ' + (problemStates[entry.extraction] ?? entry.extraction) : ''}</small></span>
            {folder.canUpload && <button type="button" className="workspace-icon" title="Удалить файл" aria-label={'Удалить ' + entry.name} disabled={pending || !!folder.operation}
              onClick={() => removeFile(tree.path + entry.name)}><Trash2 size={15} /></button>}</>}
      </li>)}</ul>
      {tree.next && <p className="help">Показаны первые 200 записей каталога.</p>}
    </div>}
  </div>;
}
