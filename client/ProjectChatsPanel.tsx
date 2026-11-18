import { useEffect, useState, type ReactNode } from 'react';
import type { ChatSummary, ChatView } from '../shared/types';
import { chatTooltip, shortDate } from './chat-date';

type ProjectChatSummary = ChatSummary & { archivedAt?: string };

export function ProjectChatsPanel({ projectId, request, renderChat }: {
  projectId: string;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  renderChat: (chat: ChatView, projectId: string) => ReactNode;
}) {
  const path = '/api/projects/' + encodeURIComponent(projectId) + '/chats';
  const [chats, setChats] = useState<ProjectChatSummary[]>();
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<{ id: string } & ({ chat: ChatView } | { error: string })>();
  const selected = chats?.find(chat => chat.id === selectedId);
  const history = detail?.id === selectedId ? detail : undefined;

  useEffect(() => {
    const controller = new AbortController();
    request<ProjectChatSummary[]>(path + '?includeArchived=true', { signal: controller.signal }).then(list => {
      if (controller.signal.aborted) return;
      const sorted = list.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setChats(sorted);
      setSelectedId(sorted[0]?.id);
    }).catch(error => { if (!controller.signal.aborted) setListError((error as Error).message); });
    return () => controller.abort();
  }, [path, request]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    request<ChatView>(path + '/' + encodeURIComponent(selectedId), { signal: controller.signal }).then(chat => {
      if (!controller.signal.aborted) setDetail({ id: selectedId, chat });
    }).catch(error => { if (!controller.signal.aborted) setDetail({ id: selectedId, error: (error as Error).message }); });
    return () => controller.abort();
  }, [path, request, selectedId]);

  if (listError) return <p className="inline-error" role="alert">{listError}</p>;
  if (!chats) return <p className="help" role="status">Загрузка чатов…</p>;
  if (!chats.length) return <p className="help">В проекте пока нет чатов.</p>;

  return <div className="project-chats-layout">
    <nav className="project-chats-list" aria-label="Чаты проекта">
      {chats.map(chat => <button key={chat.id} type="button" className="workspace-row archive-row"
        aria-current={chat.id === selectedId || undefined} title={chatTooltip(chat)} onClick={() => setSelectedId(chat.id)}>
        <span><strong>{chat.title}</strong>{chat.ownerName && <small>{chat.ownerName}</small>}</span>
        <time dateTime={chat.updatedAt}>{shortDate(chat.updatedAt)}</time>
      </button>)}
    </nav>
    {selected && <section key={selected.id} className="project-chat-history" aria-label={'История чата «' + selected.title + '»'} tabIndex={0}>
      <header><h3>{selected.title}</h3>{selected.archivedAt && <span className="project-chat-archived">Архив</span>}</header>
      {!history ? <p className="help" role="status">Загрузка истории…</p> : 'error' in history
        ? <p className="inline-error" role="alert">{history.error}</p>
        : history.chat.messages.length ? renderChat(history.chat, projectId) : <p className="help">В чате пока нет сообщений.</p>}
    </section>}
  </div>;
}
