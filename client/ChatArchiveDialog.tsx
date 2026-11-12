import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArchiveRestore, Trash2 } from 'lucide-react';
import type { ArchivedChatSummary, Chat } from '../shared/types';
import { WorkspaceDialog } from './WorkspaceDialog';

export function ChatArchiveDialog({ request, close, renderChat, onRestore }: {
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  close: () => void;
  renderChat: (chat: Chat, projectId: string) => ReactNode;
  onRestore: (projectId: string) => void;
}) {
  const [list, setList] = useState<ArchivedChatSummary[]>();
  const [selected, setSelected] = useState<ArchivedChatSummary>();
  const [chat, setChat] = useState<Chat>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const url = selected && `/api/projects/${selected.projectId}/chats/${selected.id}`;

  useEffect(() => {
    const controller = new AbortController();
    request<ArchivedChatSummary[]>('/api/admin/chats/archive', { signal: controller.signal })
      .then(items => { if (!controller.signal.aborted) setList(items); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [request]);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    request<Chat>(url, { signal: controller.signal }).then(item => {
      if (controller.signal.aborted) return;
      if (!item.archivedAt) throw new Error('Чат уже восстановлен.');
      setChat(item);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [request, url]);

  function back() { setSelected(undefined); setChat(undefined); setError(''); setConfirmDelete(false); }
  async function update(remove: boolean) {
    if (!selected || !url || pending) return;
    setPending(true); setError('');
    try {
      if (remove) await request(url, { method: 'DELETE' });
      else {
        await request(url + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: false }) });
        onRestore(selected.projectId);
      }
      setList(items => items?.filter(item => item.id !== selected.id));
      back();
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  return <WorkspaceDialog title="Архив чатов" className="chat-archive-dialog" close={() => { if (!pending) close(); }}>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {selected ? <>
      <button type="button" className="secondary archive-back" onClick={back} disabled={pending}><ArrowLeft size={16} />К списку</button>
      <h3>{selected.title}</h3>
      <p className="archive-meta">{selected.projectName} · {selected.ownerName}</p>
      {chat ? <>
        <div className="archive-history">{chat.messages.length ? renderChat(chat, selected.projectId) : <p className="help">В чате нет сообщений.</p>}</div>
        {confirmDelete ? <div className="archive-confirm">
          <p>Удалить этот чат и его сообщения навсегда? Восстановить их будет нельзя.</p>
          <div className="archive-actions">
            <button type="button" className="secondary" disabled={pending} onClick={() => setConfirmDelete(false)}>Отмена</button>
            <button type="button" className="secondary archive-danger" disabled={pending} onClick={() => void update(true)}>Удалить навсегда</button>
          </div>
        </div> : <div className="archive-actions">
          <button type="button" className="secondary" disabled={pending} onClick={() => void update(false)}><ArchiveRestore size={16} />Восстановить</button>
          <button type="button" className="secondary archive-danger" disabled={pending} onClick={() => setConfirmDelete(true)}><Trash2 size={16} />Удалить</button>
        </div>}
      </> : !error && <p role="status">Загрузка…</p>}
    </> : <div className="archive-list">
      {list?.map(item => <button type="button" className="workspace-row archive-row" key={item.id} onClick={() => { setError(''); setSelected(item); }}>
        <span><strong>{item.title}</strong><small>{item.projectName} · {item.ownerName}</small></span>
        <time dateTime={item.archivedAt}>{new Date(item.archivedAt).toLocaleDateString('ru-RU')}</time>
      </button>)}
      {!list?.length && !error && <p className="help" role="status">{list ? 'Архив пуст.' : 'Загрузка…'}</p>}
    </div>}
  </WorkspaceDialog>;
}
