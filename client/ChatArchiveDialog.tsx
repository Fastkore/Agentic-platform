import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArchiveRestore, Trash2, X } from 'lucide-react';
import type { ArchivedChatSummary, Chat } from '../shared/types';
import { assistantProjectId } from '../shared/types';
import { WorkspaceDialog } from './WorkspaceDialog';
import { SettingsSpinner } from './SettingsSpinner';
import { chatTooltip, shortDate } from './chat-date';

export function ChatArchiveDialog({ request, close, renderChat, onRestore, onOpenChat, manage, assistantOnly }: {
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  close: () => void;
  renderChat: (chat: Chat, projectId: string) => ReactNode;
  onRestore: (projectId: string) => Promise<unknown> | void;
  onOpenChat?: (projectId: string, chatId: string) => void;
  manage: boolean;
  assistantOnly?: boolean;
}) {
  const [list, setList] = useState<ArchivedChatSummary[]>();
  const [selected, setSelected] = useState<ArchivedChatSummary>();
  const [chat, setChat] = useState<Chat>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const url = selected && (selected.projectId === assistantProjectId
    ? `/api/assistant/chats/${selected.id}`
    : `/api/projects/${selected.projectId}/chats/${selected.id}`);

  useEffect(() => {
    const controller = new AbortController();
    const endpoint = assistantOnly ? '/api/chats/archive' : (manage ? '/api/admin/chats/archive' : '/api/chats/archive');
    request<ArchivedChatSummary[]>(endpoint, { signal: controller.signal })
      .then(items => {
        if (controller.signal.aborted) return;
        setList(assistantOnly ? items.filter(item => item.projectId === assistantProjectId) : items);
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [request, manage, assistantOnly]);
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
  async function update(remove: boolean, openAfterRestore = false) {
    if (!selected || !url || pending) return;
    const restoredProject = selected.projectId;
    const restoredId = selected.id;
    setPending(true); setError('');
    try {
      if (remove) await request(url, { method: 'DELETE' });
      else {
        await request(url + '/archive', { method: 'PATCH', body: JSON.stringify({ archived: false }) });
        await onRestore(restoredProject);
        if (openAfterRestore && onOpenChat) {
          onOpenChat(restoredProject, restoredId);
          return;
        }
      }
      setList(items => items?.filter(item => item.id !== restoredId));
      back();
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  const canRestoreSelected = !!(selected && (manage || selected.projectId === assistantProjectId));

  return <WorkspaceDialog title={assistantOnly ? 'Закрытые чаты Финиста' : 'Архив чатов'} className="chat-archive-dialog" close={() => { if (!pending) close(); }}>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {selected ? <>
      <button type="button" className="secondary archive-back" onClick={back} disabled={pending}><ArrowLeft size={16} />К списку</button>
      <h3>{selected.title}</h3>
      {!assistantOnly && <p className="archive-meta">{selected.projectName} · {selected.ownerName}</p>}
      {chat ? <>
        <div className="archive-history">{chat.messages.length ? renderChat(chat, selected.projectId) : <p className="help">В чате нет сообщений.</p>}</div>
        {canRestoreSelected && (confirmDelete ? <div className="archive-confirm">
          <p>Удалить этот чат и его сообщения навсегда? Восстановить их будет нельзя.</p>
          <div className="archive-actions">
            <button type="button" className="secondary" disabled={pending} onClick={() => setConfirmDelete(false)}><X size={16} aria-hidden="true" />Отмена</button>
            <button type="button" className="secondary archive-danger" disabled={pending} onClick={() => void update(true)}><Trash2 size={16} aria-hidden="true" />Удалить навсегда</button>
          </div>
        </div> : <div className="archive-actions">
          {selected.projectId === assistantProjectId && onOpenChat
            ? <button type="button" className="primary" disabled={pending} onClick={() => void update(false, true)}><ArchiveRestore size={16} />Поднять чат</button>
            : <button type="button" className="secondary" disabled={pending} onClick={() => void update(false)}><ArchiveRestore size={16} />Восстановить</button>}
          {manage && <button type="button" className="secondary archive-danger" disabled={pending} onClick={() => setConfirmDelete(true)}><Trash2 size={16} />Удалить</button>}
        </div>)}
      </> : !error && <SettingsSpinner label="Загрузка истории…" />}
    </> : <div className="archive-list">
      {list?.map(item => <button type="button" className="workspace-row archive-row" key={item.id} title={chatTooltip(item, item.archivedAt)} onClick={() => { setError(''); setSelected(item); }}>
        <span><strong>{item.title}</strong>{!assistantOnly && <small>{item.projectName} · {item.ownerName}</small>}</span>
        <time dateTime={item.archivedAt}>{shortDate(item.archivedAt)}</time>
      </button>)}
      {!list && !error && <SettingsSpinner label="Загрузка архива…" />}
      {list && !list.length && !error && <p className="help" role="status">{assistantOnly ? 'Закрытых чатов с Финистом пока нет.' : 'Архив пуст.'}</p>}
    </div>}
  </WorkspaceDialog>;
}
