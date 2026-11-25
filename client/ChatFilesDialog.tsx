import { useEffect, useState } from 'react';
import { Download, FileText, Paperclip, Trash2 } from 'lucide-react';
import type { Attachment } from '../shared/types';
import { SettingsSpinner } from './SettingsSpinner';
import { WorkspaceDialog } from './WorkspaceDialog';

type StoredFile = Pick<Attachment, 'id' | 'name' | 'size'> & { messageId: string; canDelete: boolean };
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;

export function ChatFilesDialog({ projectId, chatId, request, close, attach, changed, download, canAttach, busy }: {
  projectId: string; chatId: string; request: Request; close: () => void; attach: (file: Attachment) => void;
  changed: (fileId: string) => Promise<void>; download: (url: string, name: string) => Promise<void>; canAttach: boolean; busy: boolean;
}) {
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`;
  const [files, setFiles] = useState<StoredFile[]>();
  const [removing, setRemoving] = useState<StoredFile>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<StoredFile[]>(endpoint + '/files', { signal: controller.signal }).then(setFiles).catch(cause => {
      if (!controller.signal.aborted) setError((cause as Error).message);
    });
    return () => controller.abort();
  }, [endpoint, request]);
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true); setError('');
    try { await action(); } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }
  return <WorkspaceDialog title="Файлы чата" className="chat-files-dialog" close={() => { if (!pending) close(); }}>
    {removing ? <>
      <p>Удалить «{removing.name}» из хранилища и сообщений этого чата навсегда? Восстановление недоступно.</p>
      <div className="settings-dialog-actions">
        <button type="button" className="secondary" disabled={pending} onClick={() => setRemoving(undefined)}>Отмена</button>
        <button type="button" className="primary" disabled={pending || busy} onClick={() => void run(async () => {
          await request(endpoint + '/files/' + removing.id, { method: 'DELETE' });
          setFiles(items => items?.filter(file => file.id !== removing.id));
          setRemoving(undefined);
          await changed(removing.id);
        })}>Удалить навсегда</button>
      </div>
    </> : <>
      <p className="help">Загруженные файлы, изображения и результаты этого чата. Сохраняются после остановки задания и перезапуска.</p>
      {!files && !error && <SettingsSpinner label="Загружаем файлы…" />}
      {files?.length === 0 && <p>В этом чате пока нет файлов.</p>}
      <div className="chat-stored-files">{files?.map(file => <div key={file.id} className="chat-stored-file">
        <FileText size={20} aria-hidden="true" />
        <div><b>{file.name}</b><small>{(file.size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ</small></div>
        <button type="button" className="workspace-icon" disabled={pending} title="Скачать" aria-label={'Скачать ' + file.name}
          onClick={() => void run(() => download(endpoint + '/files/' + file.id, file.name))}><Download size={17} /></button>
        <button type="button" className="workspace-icon" disabled={pending || !canAttach} title="Прикрепить к следующему сообщению" aria-label={'Прикрепить ' + file.name}
          onClick={() => void run(async () => { attach(await request<Attachment>(endpoint + '/files/' + file.id + '/attach', { method: 'POST' })); close(); })}><Paperclip size={17} /></button>
        {file.canDelete && <button type="button" className="workspace-icon" disabled={pending || busy} title="Удалить навсегда" aria-label={'Удалить ' + file.name}
          onClick={() => setRemoving(file)}><Trash2 size={17} /></button>}
      </div>)}</div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </WorkspaceDialog>;
}
