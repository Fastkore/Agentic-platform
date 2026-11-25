import { useId, useLayoutEffect, useRef, useState, useEffect, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { interfaceScale } from './interface-scale';

export function InfoHint({ label, children, descriptionId }: { label: string; children: ReactNode; descriptionId?: string }) {
  const fallback = useId();
  const id = descriptionId ?? fallback;
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reveal = () => { clearTimeout(timeout.current); setOpen(true); };
  const leave = () => { clearTimeout(timeout.current); timeout.current = setTimeout(() => setOpen(false), 120); };
  useEffect(() => () => clearTimeout(timeout.current), []);
  useLayoutEffect(() => {
    if (!open || !button.current || !tip.current) return;
    const hint = tip.current, trigger = button.current;
    hint.showPopover();
    function place() {
      const anchor = trigger.getBoundingClientRect(), box = hint.getBoundingClientRect();
      const scale = interfaceScale(trigger);
      hint.style.left = Math.max(4, Math.min(anchor.left, innerWidth - box.width - 4)) / scale + 'px';
      hint.style.top = Math.max(4, anchor.bottom + box.height + 6 < innerHeight ? anchor.bottom + 4 : anchor.top - box.height - 4) / scale + 'px';
    }
    const outside = (e: PointerEvent) => { if (!trigger.contains(e.target as Node) && !hint.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    place();
    document.addEventListener('keydown', escape, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      hint.hidePopover();
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return <>
    <button ref={button} type="button" className="workspace-icon" aria-label={label} aria-describedby={open ? id : undefined}
      onPointerEnter={reveal} onPointerLeave={leave} onFocus={reveal} onBlur={leave} onClick={reveal}><Info size={15} /></button>
    <div ref={tip} id={id} role="tooltip" popover="manual" className="settings-info-hint" onPointerEnter={reveal} onPointerLeave={leave}>
      {children}
    </div>
  </>;
}
