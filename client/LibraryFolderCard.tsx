import { useCallback, useEffect, useState } from 'react';
import { FilePlus2, FileText, Folder, FolderOpen, ListX, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { LibraryFolderSummary, OperationMode } from '../shared/library';
import { externalLabels, type ExternalSelection } from '../shared/library';
import { ExternalLibraryPicker, driveSessionExpired } from './ExternalLibraryPicker';
import { formatBytes, type Request } from './library-upload';
import { LibraryUploadPanel } from './LibraryUploadPanel';

interface Problems { counts: Record<string, number>; files: { path: string; state: string; note: string | null }[] }
interface Tree { path: string; entries: { name: string; type: 'dir' | 'file'; fileId?: string; size?: number; extraction?: string }[]; next?: string }
type FileView = { kind: 'tree'; tree: Tree } | { kind: 'problems'; failed: boolean; data: Problems };
export const problemStates: Record<string, string> = {
  timeout: 'Таймаут', failed: 'Ошибка извлечения', unsupported_encoding: 'Кодировка не поддерживается', unsupported_format: 'Формат не поддерживается',
  ocr_required: 'Требуется распознавание', pending: 'Ожидает обработки',
};
const date = (value?: string) => value ? new Date(value).toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' }) : '';

/** One line about the folder: current content, update in progress, last failure. */
export function folderLine(folder: LibraryFolderSummary) {
  const parts: string[] = [];
  if (folder.external) parts.push(externalLabels[folder.external.provider] + ' · только чтение');
  const op = folder.operation;
  if (folder.current) {
    parts.push(`Файлы: ${folder.current.files.toLocaleString('ru')} · ${formatBytes(folder.current.bytes)}`);
    const without = folder.current.unsupported + folder.current.errors;
    if (without) parts.push(`без поиска ${without}`);
    if (folder.updatedAt) parts.push('обновлено ' + date(folder.updatedAt));
  } else if (folder.external?.preparingFiles !== undefined) {
    parts.push(`Найдено файлов: ${folder.external.preparingFiles.toLocaleString('ru')} · подготовка к поиску`);
  } else if (folder.external?.syncing) {
    parts.push('Получаем файлы с диска');
  } else if (folder.external?.error || folder.failed) {
    parts.push('Материалы ещё не опубликованы');
  } else if (folder.external) {
    parts.push('Ожидаем первую синхронизацию');
  } else parts.push('Материалов пока нет');
  if (op?.status === 'open') parts.push('незавершённая загрузка');
  if (op?.status === 'preparing') parts.push(op.processing ? `подготовка ${op.processing.coverage.indexed + op.processing.coverage.unsupported + op.processing.coverage.errors} из ${op.processing.coverage.files}` : 'подготовка');
  if (folder.failed && !op) parts.push('последнее обновление не опубликовано');
  return parts.join(' · ');
}

export function useLibraryRefresh(folders: LibraryFolderSummary[] | undefined, load: () => Promise<void>) {
  const processing = folders?.some(folder => folder.external?.syncing || folder.operation?.status === 'preparing');
  useEffect(() => {
    if (!processing) return;
    let active = true;
    async function refresh() {
      await load();
      if (active) timer = window.setTimeout(refresh, 4000);
    }
    let timer = window.setTimeout(refresh, 4000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [processing, load]);
}

/** Folder card shared by platform and project settings: upload, update, files and errors. */
export function LibraryFolderCard({ request, folder, isAdmin, reload }: { request: Request; folder: LibraryFolderSummary; isAdmin: boolean; reload: () => void }) {
  const base = '/api/library/' + encodeURIComponent(folder.id);
  const [upload, setUpload] = useState<OperationMode>();
  const [view, setView] = useState<FileView>();
  const tree = view?.kind === 'tree' ? view.tree : undefined;
  const problems = view?.kind === 'problems' ? view : undefined;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [selection, setSelection] = useState<ExternalSelection>();
  const canManage = folder.canManage || isAdmin;
  const preparing = folder.operation?.status === 'preparing' || folder.external?.syncing;
  async function act(work: () => Promise<unknown>, done?: string) {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try { await work(); reload(); if (done) setNotice(done); } catch (e) {
      if (reconnecting && driveSessionExpired(e)) { setSelection(undefined); setAttempt(n => n + 1); }
      setError((e as Error).message); reload();
    } finally { setPending(false); }
  }
  const post = (url: string, body: unknown = {}) => request(url, { method: 'POST', body: JSON.stringify(body) });
  const browse = useCallback(async (path: string) => {
    setView({ kind: 'tree', tree: await request<Tree>(`${base}/tree?path=${encodeURIComponent(path)}`) });
  }, [base, request]);
  const showProblems = (failed: boolean) => act(async () => {
    setView({ kind: 'problems', failed, data: await request<Problems>(`${base}/problems${failed ? '?failed=1' : ''}`) });
  });
  const projects = folder.projects.map(p => p.name ?? p.id);
  const removeFile = (path: string) => {
    const where = projects.length ? `\nФайл исчезнет во всех подключённых проектах: ${projects.join(', ')}.` : '';
    if (!confirm(`Удалить «${path}» из папки «${folder.name}»?${where}`)) return;
    void act(async () => { await post(`${base}/remove-files`, { paths: [path] }); if (tree) await browse(tree.path); }, 'Файл удалён из папки.');
  };
  const crumbs = tree ? tree.path.split('/').filter(Boolean) : [];

  return <div className="library-card-body">
    {folder.external && <div>
      <p className="help">{externalLabels[folder.external.provider]} / {folder.external.folder} · только чтение
        {folder.external.checkedAt && ' · проверено ' + date(folder.external.checkedAt)}</p>
      {folder.external.error && <p className="inline-error" role="alert">{folder.external.error}</p>}
      {preparing && <p className="help" role="status">Идёт синхронизация и подготовка к поиску…</p>}
      <div className="settings-actions">
        {canManage && <button type="button" className="secondary" disabled={pending || preparing} onClick={() => void act(() => post(base + '/external/sync'))}>Синхронизировать</button>}
        {isAdmin && <button type="button" className="secondary" onClick={() => { setReconnecting(!reconnecting); setSelection(undefined); }}> {reconnecting ? 'Отмена' : 'Восстановить связь'}</button>}
      </div>
      {reconnecting && <><ExternalLibraryPicker key={attempt} provider={folder.external.provider} request={request} onSelect={setSelection} />
        <button type="button" className="secondary" disabled={pending || !selection} onClick={() => void act(async () => { await post(base + '/external/reconnect', selection); setReconnecting(false); }, 'Связь восстановлена.')}>Подключить исходную папку</button></>}
    </div>}
    {upload && !folder.external ? <LibraryUploadPanel request={request} folder={folder} mode={upload} canDecideSecrets={canManage} close={() => setUpload(undefined)} done={reload} /> : <>
      {folder.failed && !folder.operation && <p className="library-warning" role="status">
        Последнее обновление не опубликовано: {folder.failed.failure === 'conflict' ? 'папку уже обновила другая операция.'
          : `не обработано файлов ${folder.failed.coverage.errors}.`}</p>}
      {folder.operation?.status === 'preparing' && <p className="help" role="status">Идёт подготовка к поиску. До её окончания агент использует прежнее содержимое папки.</p>}
      <div className="settings-actions library-card-actions">
        {folder.canUpload && <>
          <button type="button" className={folder.current ? 'secondary' : 'primary'} disabled={pending || preparing} onClick={() => setUpload('replace')}>
            {folder.operation?.status === 'open' ? <><Upload size={16} aria-hidden="true" />Продолжить загрузку</>
              : <><FolderOpen size={16} aria-hidden="true" />{folder.current ? 'Обновить из папки' : 'Загрузить папку'}</>}</button>
          {folder.operation?.status !== 'open' && <button type="button" className="secondary" disabled={pending} onClick={() => setUpload('add')}><FilePlus2 size={16} aria-hidden="true" />Добавить файлы</button>}
        </>}
        {folder.current && <button type="button" className="secondary" aria-expanded={!!tree} disabled={pending} onClick={() => tree ? setView(undefined) : void act(() => browse(''))}>
          <Folder size={16} aria-hidden="true" />Файлы</button>}
        {!!folder.current && folder.current.unsupported + folder.current.errors > 0 && <button type="button" className="secondary" disabled={pending}
          aria-expanded={!!problems && !problems.failed} onClick={() => problems && !problems.failed ? setView(undefined) : void showProblems(false)}><ListX size={16} aria-hidden="true" />Файлы без поиска</button>}
        {folder.failed && !folder.operation && <button type="button" className="secondary" disabled={pending}
          aria-expanded={!!problems?.failed} onClick={() => problems?.failed ? setView(undefined) : void showProblems(true)}><ListX size={16} aria-hidden="true" />Что не обработано</button>}
        {(folder.canUpload || folder.external && canManage) && !preparing && !folder.operation && (folder.failed || folder.current?.errors) ? <button type="button" className="secondary" disabled={pending}
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
