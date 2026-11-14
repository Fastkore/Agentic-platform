import { useEffect, useRef, type ReactNode } from 'react';
import { ShieldCheck, X } from 'lucide-react';

export function ChatAccessPopover({ writable, children }: { writable: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  return <details ref={ref} className="composer-access" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
  }}>
    <summary className={'composer-access-trigger' + (writable ? ' write' : '')} title="Доступные инструменты чата" aria-label="Доступные инструменты чата">
      <ShieldCheck size={16} aria-hidden="true" /><span>{writable ? 'Запись разрешена' : 'Только чтение'}</span>
    </summary>
    <div className="composer-access-popover" role="region" aria-label="Доступные инструменты чата">
      <header><strong>Доступ в чате</strong><button type="button" className="workspace-icon" aria-label="Закрыть доступы" onClick={() => {
        if (ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); }
      }}><X size={16} /></button></header>
      {children}
    </div>
  </details>;
}
