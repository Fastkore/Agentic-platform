import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import type { ProjectFile, ProjectSummary } from '../shared/types';
import { WorkspaceDialog } from './WorkspaceDialog';

const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
function fileSize(size: number) {
  if (size < 1024) return number.format(size) + ' Б';
  if (size < 1_048_576) return number.format(size / 1024) + ' КБ';
  return number.format(size / 1_048_576) + ' МБ';
}

export function ProjectFilesDialog({ project, request, download, close }: {
  project: ProjectSummary; request: <T>(url: string, init?: RequestInit) => Promise<T>;
  download: (url: string) => Promise<Blob>; close: () => void;
}) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/files';
  const fileRoute = (id: string) => route + '/' + encodeURIComponent(id);
  useEffect(() => {
    const controller = new AbortController();
    request<ProjectFile[]>(route, { signal: controller.signal })
      .then(setFiles)
      .catch(err => { if (!controller.signal.aborted) setError((err as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [route, request]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await work(); } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function upload(files: File[]) {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw new Error(file.name + ' превышает 20 МБ.');
      const data = new FormData();
      data.append('file', file);
      const uploaded = await request<ProjectFile>(route, { method: 'POST', body: data });
      setFiles(current => [uploaded, ...current]);
    }
  }
  async function save(file: ProjectFile) {
    const blob = await download(fileRoute(file.id));
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function remove(file: ProjectFile) {
    await request(fileRoute(file.id), { method: 'DELETE' });
    setFiles(current => current.filter(item => item.id !== file.id));
    setConfirm('');
  }
  return <WorkspaceDialog title="Файлы проекта" className="project-files-dialog" close={close}>
    <div className="project-files-toolbar">
      <strong title={project.name}>{project.name}</strong>
      <button type="button" className="primary" data-dialog-focus disabled={busy || loading} onClick={() => picker.current?.click()}>
        <Upload size={16} />Загрузить
      </button>
      <input type="file" ref={picker} hidden multiple onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = '';
        if (files.length) void action(() => upload(files));
      }} />
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading ? <p role="status">Загрузка…</p> : !files.length ? <p>В проекте пока нет файлов.</p> :
      <ul className="project-files-list" aria-label="Файлы">
        {files.map(file => <li key={file.id}>
          <div className="project-file-row">
            <FileText size={16} />
            <div className="project-file-name"><strong title={file.name}>{file.name}</strong><small>{fileSize(file.size)}</small></div>
            <button type="button" className="workspace-icon" disabled={busy} aria-label={'Скачать ' + file.name} title="Скачать" onClick={() => void action(() => save(file))}><Download size={16} /></button>
            <button type="button" className="workspace-icon" disabled={busy} aria-label={'Удалить ' + file.name} title="Удалить" onClick={() => setConfirm(file.id)}><Trash2 size={16} /></button>
          </div>
          {confirm === file.id && <div className="project-file-confirm">
            <span>Удалить файл из проекта?</span>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm('')}>Отмена</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void action(() => remove(file))}>Удалить</button>
          </div>}
        </li>)}
      </ul>}
  </WorkspaceDialog>;
}
