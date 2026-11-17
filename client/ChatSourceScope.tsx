import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import type { Request } from './source-upload';

interface ScopeView { pinned?: string; current: string; differs: boolean; events: { at: string; previous?: string; next: string }[]; sources: number }
/** Version set used by the chat; an employee may only switch the chat to the project's current set. */
export function ChatSourceScope({ request, projectId, chatId, canSwitch, revision }: { request: Request; projectId: string; chatId: string; canSwitch: boolean; revision?: string | number }) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}/source-scope`;
  const [view, setView] = useState<ScopeView>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void request<ScopeView>(url).then(v => { if (active) setView(v); }).catch(() => { if (active) setView(undefined); });
    return () => { active = false; };
  }, [request, url, revision]);
  if (!view || (!view.sources && !view.pinned)) return null;
  const history = view.events.map(e => `${new Date(e.at).toLocaleString('ru')}: ${e.previous ?? '—'} → ${e.next}`).join('\n');
  return <span className="chat-consultants chat-source-scope">
    <span className="chat-consultant" title={(history ? 'История версий:\n' + history : 'Набор версий источников этого чата')}>
      <Layers size={13} aria-hidden="true" /><span>{view.pinned ?? view.current}</span>
    </span>
    {view.differs && <span className="chat-consultant-notice">в проекте: {view.current}</span>}
    {view.differs && canSwitch && <button type="button" className="secondary chat-source-switch" disabled={pending} onClick={() => {
      setPending(true);
      void request<ScopeView>(url + '/switch', { method: 'POST', body: '{}' }).then(setView).finally(() => setPending(false));
    }}>Переключить чат</button>}
  </span>;
}
