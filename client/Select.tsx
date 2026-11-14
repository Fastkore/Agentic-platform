import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { interfaceScale } from './interface-scale';

export interface SelectOption { value: string; label: string; disabled?: boolean; detail?: string; detailTitle?: string }
interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
  className?: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  fitContent?: boolean;
}

export function Select({ options, value, onChange, id, label, className = '', placeholder, title, disabled, fitContent }: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<CSSProperties>();
  const typed = useRef({ prefix: '', until: 0 });
  const selected = options.findIndex(option => option.value === value);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const expanded = open && !disabled && !!enabled.length;

  function reveal(index = selected) {
    setActive(enabled.includes(index) ? index : enabled[0] ?? -1);
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onChange(option.value);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key;
    if (key === 'Tab') { setOpen(false); return; }
    if (key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (expanded) choose(active); else reveal();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) { reveal(key === 'ArrowUp' && selected < 0 ? enabled.at(-1) : selected); return; }
      const direction = key === 'ArrowDown' ? 1 : -1;
      const position = enabled.indexOf(active);
      setActive(enabled[(position + direction + enabled.length) % enabled.length]);
      return;
    }
    if (expanded && (key === 'Home' || key === 'End')) {
      event.preventDefault();
      setActive(key === 'Home' ? enabled[0] : enabled.at(-1)!);
      return;
    }
    if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = Date.now(), letter = key.toLocaleLowerCase();
    const prefix = (typed.current.until > now ? typed.current.prefix : '') + letter;
    typed.current = { prefix, until: now + 700 };
    const index = enabled.find(item => options[item].label.toLocaleLowerCase().startsWith(prefix));
    if (index !== undefined) { event.preventDefault(); reveal(index); }
  }

  useLayoutEffect(() => {
    if (!expanded) return;
    const button = trigger.current;
    if (!button) return;
    const measure = (event?: Event) => {
      if (event?.target === menu.current) return;
      const rect = button.getBoundingClientRect();
      const scale = interfaceScale(button);
      const viewportWidth = innerWidth / scale, viewportHeight = innerHeight / scale;
      const width = Math.min(Math.max(fitContent ? 340 : 180, rect.width / scale), viewportWidth - 16);
      const contentHeight = menu.current ? menu.current.scrollHeight + 2 : options.length * 36 + 10;
      const idealHeight = fitContent ? contentHeight : Math.min(270, contentHeight);
      const below = viewportHeight - rect.bottom / scale - 14, above = rect.top / scale - 14;
      const opensUp = idealHeight > below && above > below;
      setPlacement({
        width,
        left: Math.max(8, Math.min(rect.left / scale, viewportWidth - width - 8)),
        maxHeight: Math.max(0, Math.min(idealHeight, opensUp ? above : below)),
        ...(opensUp ? { bottom: viewportHeight - rect.top / scale + 6 } : { top: rect.bottom / scale + 6 }),
      });
    };
    measure();
    const observer = new ResizeObserver(() => measure());
    if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true); };
  }, [expanded, options.length, fitContent, !!placement]);

  useEffect(() => {
    if (expanded) menu.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active, placement]);

  useEffect(() => {
    if (!expanded) return;
    function closeOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [expanded]);

  const portal = trigger.current?.closest('dialog, .workspace-shell');
  return <>
    <button ref={trigger} type="button" role="combobox" id={id} aria-label={label} title={title ?? options[selected]?.label}
      aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && active >= 0 ? listId + '-' + active : undefined}
      disabled={disabled || !enabled.length} className={'workspace-select ' + className}
      onClick={() => { if (expanded) setOpen(false); else reveal(); }}
      onBlur={() => setOpen(false)} onKeyDown={onKeyDown}>
      <span>{options[selected]?.label ?? placeholder ?? 'Выберите'}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {expanded && portal && placement && createPortal(<div ref={menu} className="workspace-select-menu" id={listId} role="listbox" aria-label={label} style={placement}>
      {options.map((option, index) => <div id={listId + '-' + index} key={option.value} role="option"
        aria-selected={value === option.value} aria-disabled={option.disabled || undefined} data-active={active === index}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }}
        onClick={() => choose(index)}>
        <span>{option.label}</span>{option.detail && <small className="select-option-detail" title={option.detailTitle}>{option.detail}</small>}{value === option.value && <Check size={15} aria-hidden="true" />}
      </div>)}
    </div>, portal)}
  </>;
}
