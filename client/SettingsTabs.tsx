import { useId, useState, type ReactNode } from 'react';
import { Activity, Cpu, FolderOpen, Settings2, type LucideIcon } from 'lucide-react';
import './specialists.css';

export function SettingsTabStrip<T extends string>({ sections, value, select, id, label, panelId, className = '', disabled, counts }: {
  sections: readonly (readonly [T, string, LucideIcon])[];
  value: T;
  select: (value: T) => void;
  id: string;
  label: string;
  panelId: (value: T) => string;
  className?: string;
  disabled?: boolean;
  counts?: Partial<Record<T, number>>;
}) {
  return <div className={`specialist-tabs ${className}`} role="tablist" aria-label={label} onKeyDown={event => {
    if (disabled) return;
    const current = sections.findIndex(([key]) => key === value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : event.key === 'ArrowRight'
      ? (current + 1) % sections.length : event.key === 'ArrowLeft' ? (current + sections.length - 1) % sections.length : -1;
    if (next < 0) return;
    event.preventDefault();
    select(sections[next][0]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>
    {sections.map(([key, title, Icon]) => <button key={key} id={id + key} type="button" role="tab" aria-selected={key === value}
      aria-controls={panelId(key)} tabIndex={key === value ? 0 : -1} disabled={disabled} onClick={() => select(key)}>
      <Icon size={17} aria-hidden="true" />{title}
      {counts?.[key] !== undefined && <span className="settings-tab-count">{counts[key]}</span>}
    </button>)}
  </div>;
}

const serverTabs = [['general', 'Модель и голос', Settings2], ['models', 'Подключения к AI', Cpu], ['files', 'Файлы', FolderOpen], ['diagnostics', 'Диагностика', Activity]] as const;
type ServerTab = typeof serverTabs[number][0];

export function ServerSettingsTabs(panels: Record<ServerTab, ReactNode>) {
  const id = useId();
  const [tab, setTab] = useState<ServerTab>('general');
  const panelId = (key: ServerTab) => id + key + '-panel';
  return <>
    <SettingsTabStrip sections={serverTabs} value={tab} select={setTab} id={id} label="Настройки сервера"
      panelId={panelId} className="server-settings-tabs" />
    {serverTabs.map(([key]) => <div key={key} id={panelId(key)} role="tabpanel" aria-labelledby={id + key}
      tabIndex={0} hidden={key !== tab}>{panels[key]}</div>)}
  </>;
}
