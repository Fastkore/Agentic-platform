import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AtSign, Bot, Check, X } from 'lucide-react';
import type { AgentSummary } from '../shared/types';
import { interfaceScale } from './interface-scale';

interface Mention { start: number; end: number; query: string }

function mentionAt(text: string, caret: number): Mention | null {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1];
  const suffix = /^[\p{L}\p{N}_-]*/u.exec(text.slice(caret))![0];
  return { start: caret - query.length - 1, end: caret + suffix.length, query };
}

export function ComposerInput({ input, draft, placeholder, editable, pickerEnabled, agents, specialistId,
  onDraft, onSpecialist, onSend, controls }: {
  input: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  placeholder: string;
  editable: boolean;
  pickerEnabled: boolean;
  agents: AgentSummary[];
  specialistId?: string;
  onDraft: (text: string) => void;
  onSpecialist: (id?: string) => void;
  onSend: () => void;
  controls: (pickerButton: ReactNode) => ReactNode;
}) {
  const listId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const nextCaret = useRef<number | null>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<CSSProperties>();
  const expanded = pickerEnabled && !!mention;
  const query = mention?.query.toLocaleLowerCase() ?? '';
  const matches = expanded ? agents.filter(agent => [agent.name, agent.id].some(value => value.toLocaleLowerCase().includes(query))) : [];
  const activeIndex = Math.min(active, matches.length - 1);
  const specialist = agents.find(agent => agent.id === specialistId);

  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [draft, mention, input]);

  useLayoutEffect(() => {
    if (!expanded) return;
    function measure(event?: Event) {
      if (event?.target === menu.current) return;
      const field = input.current;
      if (!field) return;
      const rect = field.getBoundingClientRect();
      const scale = interfaceScale(field);
      const viewportWidth = innerWidth / scale, viewportHeight = innerHeight / scale;
      const width = Math.min(340, rect.width / scale, viewportWidth - 16);
      const above = rect.top / scale - 14, below = viewportHeight - rect.bottom / scale - 14;
      const opensUp = above >= 220 || above >= below;
      setPlacement({
        width, left: Math.max(8, Math.min(rect.left / scale, viewportWidth - width - 8)),
        maxHeight: Math.max(0, Math.min(260, opensUp ? above : below)),
        ...(opensUp ? { bottom: viewportHeight - rect.top / scale + 6 } : { top: rect.bottom / scale + 6 }),
      });
    }
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true); };
  }, [expanded, input]);

  useEffect(() => {
    if (expanded && activeIndex >= 0) menu.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, expanded, placement]);

  function choose(agent: AgentSummary) {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(mention.end);
    nextCaret.current = before.length;
    onDraft(before + (before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after));
    onSpecialist(agent.id);
    setMention(null);
    input.current?.focus();
  }

  function togglePicker() {
    const area = input.current;
    if (!area) return;
    area.focus();
    if (expanded) { setMention(null); return; }
    const caret = area.selectionEnd;
    const existing = mentionAt(draft, caret);
    setActive(0);
    if (existing) { setMention(existing); return; }
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const prefix = before && !/\s$/.test(before) ? ' @' : '@';
    const suffix = after && !/^\s/.test(after) ? ' ' : '';
    const text = before + prefix + suffix + after;
    nextCaret.current = before.length + prefix.length;
    onDraft(text);
    setMention(mentionAt(text, nextCaret.current));
  }

  function handleKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (expanded) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setMention(null); return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (matches.length) {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActive((activeIndex + step + matches.length) % matches.length);
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat && matches[activeIndex]) choose(matches[activeIndex]);
        else if (!event.repeat) setMention(null);
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) setMention(null);
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) onSend();
    }
  }

  const shell = input.current?.closest('.workspace-shell');
  return <>
    {specialistId && <div className="composer-specialist">
      <span role="status" title="Рекомендованный специалист"><AtSign size={14} aria-hidden="true" />{specialist?.name ?? 'Специалист недоступен'}</span>
      <button type="button" className="workspace-icon" aria-label="Убрать специалиста" title="Убрать специалиста"
        disabled={!editable} onClick={() => { onSpecialist(); input.current?.focus(); }}><X size={14} /></button>
    </div>}
    <textarea ref={input} rows={2} value={draft} placeholder={placeholder} disabled={!editable} aria-label="Сообщение Codex"
      aria-autocomplete="list" aria-controls={expanded ? listId : undefined}
      aria-activedescendant={activeIndex >= 0 ? listId + '-' + activeIndex : undefined}
      onChange={event => {
        const { value, selectionStart } = event.currentTarget;
        onDraft(value);
        setMention(pickerEnabled ? mentionAt(value, selectionStart) : null);
        setActive(0);
      }}
      onClick={() => setMention(null)} onBlur={() => setMention(null)} onKeyDown={handleKeys} />
    {controls(agents.length ? <button type="button" className="workspace-icon composer-mention-button"
      aria-label="Выбрать специалиста" title="Выбрать специалиста · @" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined} disabled={!pickerEnabled || !agents.length}
      onPointerDown={event => event.preventDefault()} onClick={togglePicker}><AtSign size={17} /></button> : null)}
    {expanded && shell && placement && createPortal(<div ref={menu} className="workspace-select-menu composer-mention-menu"
      id={listId} role="listbox" aria-label="Специалисты" style={placement} onPointerDown={event => event.preventDefault()}>
      {matches.map((agent, index) => <div key={agent.id} id={listId + '-' + index} role="option"
        aria-selected={agent.id === specialistId} data-active={index === activeIndex}
        onPointerMove={() => setActive(index)} onClick={() => choose(agent)}>
        <Bot size={16} aria-hidden="true" />
        <span><strong>{agent.name}</strong>{agent.description && <small>{agent.description}</small>}</span>
        {agent.id === specialistId && <Check size={15} aria-hidden="true" />}
      </div>)}
      {!matches.length && <div className="composer-mention-empty" role="status">{agents.length ? 'Специалисты не найдены' : 'Нет доступных специалистов'}</div>}
    </div>, shell)}
  </>;
}
