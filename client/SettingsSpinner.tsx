export function ProgressRing({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <svg className={('win11-ring ' + className).trim()} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle className="win11-ring-arc" cx="8" cy="8" r="6.25" pathLength={100} />
  </svg>;
}

export function SettingsSpinner({ label = 'Загрузка…', inline = false, className = '' }: {
  label?: string;
  inline?: boolean;
  className?: string;
}) {
  if (inline) {
    return <span className={('settings-inline-loading ' + className).trim()} role="status" aria-live="polite">
      <ProgressRing size={16} />
      <span>{label}</span>
    </span>;
  }
  return <div className={('settings-list-loading ' + className).trim()} role="status" aria-live="polite">
    <ProgressRing size={28} />
    <span>{label}</span>
  </div>;
}
