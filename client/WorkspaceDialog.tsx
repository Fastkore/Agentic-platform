import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ArrowLeft, Settings, X } from 'lucide-react';

export function WorkspaceDialog({ title, className, close, back, closeOnBackdrop = true, children }: {
  title: string; className: string; close: () => void; back?: () => void; closeOnBackdrop?: boolean; children: ReactNode;
}) {
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
    if (!closeOnBackdrop || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close();
  }}>
    <header>
      <div className="workspace-dialog-heading">
        {back && <button type="button" className="workspace-icon" onClick={back} title="К разделам настроек" aria-label="К разделам настроек">
          <ArrowLeft size={19} aria-hidden="true" />
        </button>}
        <h2 id={heading}>{className.split(' ').includes('workspace-settings') && <Settings size={23} aria-hidden="true" />}{title}</h2>
      </div>
      <button type="button" className="workspace-icon" onClick={close} aria-label="Закрыть"><X size={19} /></button>
    </header>
    {children}
  </dialog>;
}
