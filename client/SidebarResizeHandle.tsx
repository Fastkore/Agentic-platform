import { useLayoutEffect, useRef, useState } from 'react';

const storageKey = 'bridge-sidebar-width';
const minWidth = 230;
const maxWidth = () => Math.max(minWidth, Math.floor(Math.min(520, innerWidth * 0.45)));

export function SidebarResizeHandle() {
  const handle = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(minWidth);
  const [maximum, setMaximum] = useState(maxWidth);
  const drag = useRef<{ id: number; x: number; width: number; previous: string } | undefined>(undefined);

  useLayoutEffect(() => {
    const element = handle.current?.parentElement;
    if (!element) return;
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= minWidth && saved <= 520) {
      element.style.setProperty('--sidebar-width', saved + 'px');
    }
    const measure = () => {
      const size = Math.round(element.getBoundingClientRect().width);
      if (size >= minWidth) setWidth(size);
      setMaximum(maxWidth());
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  function resize(next: number, save: boolean) {
    const size = Math.max(minWidth, Math.min(maxWidth(), Math.round(next)));
    handle.current?.parentElement?.style.setProperty('--sidebar-width', size + 'px');
    setWidth(size);
    if (save) localStorage.setItem(storageKey, String(size));
  }

  return <div ref={handle} className="workspace-sidebar-resize" role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label="Ширина боковой панели" aria-controls="workspace-sidebar"
    aria-valuemin={minWidth} aria-valuemax={maximum} aria-valuenow={width}
    onKeyDown={event => {
      const values: Record<string, number> = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minWidth, End: maxWidth() };
      if (!Object.hasOwn(values, event.key)) return;
      event.preventDefault();
      resize(values[event.key], true);
    }}
    onPointerDown={event => {
      const element = event.currentTarget.parentElement;
      if (!element || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width: element.getBoundingClientRect().width,
        previous: element.style.getPropertyValue('--sidebar-width') };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.id === event.pointerId) resize(start.width + event.clientX - start.x, false);
    }}
    onPointerUp={event => {
      const start = drag.current;
      if (start?.id !== event.pointerId) return;
      drag.current = undefined;
      resize(start.width + event.clientX - start.x, true);
    }}
    onLostPointerCapture={event => {
      const start = drag.current;
      if (start?.id !== event.pointerId) return;
      drag.current = undefined;
      event.currentTarget.parentElement?.style.setProperty('--sidebar-width', start.previous);
    }} />;
}
