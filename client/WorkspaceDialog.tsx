import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Settings, X } from 'lucide-react';

export function WorkspaceDialog({ title, className, close, children }: { title: string; className: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-dialog-focus]')?.focus();
    return () => dialog?.close();
  }, []);

  return <dialog ref={ref} className={'workspace-dialog ' + className} aria-labelledby={heading} onCancel={e => {
    e.preventDefault();
    e.stopPropagation();
    close();
  }} onClick={e => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close();
  }}>
    <header><h2 id={heading}>{className === 'workspace-settings' && <Settings size={23} aria-hidden="true" />}{title}</h2><button type="button" className="workspace-icon" onClick={close} aria-label="Закрыть"><X size={19} /></button></header>
    {children}
  </dialog>;
}
