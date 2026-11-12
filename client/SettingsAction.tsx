import { useEffect, useRef, type ReactNode } from 'react';

export function SettingsAction({ title, children }: { title: string; children: ReactNode }) {
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    (section.current?.querySelector<HTMLElement>('[data-settings-focus]') ?? heading.current)?.focus();
  }, []);
  return <section className="settings-inline-action" ref={section}>
    <h3 ref={heading} tabIndex={-1}>{title}</h3>
    {children}
  </section>;
}
