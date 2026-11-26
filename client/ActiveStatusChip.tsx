export function ActiveStatusChip({ checked, disabled, label, accessibleLabel, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  accessibleLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return <label className={'active-status-chip' + (checked ? ' active' : '')}>
    <input type="checkbox" checked={checked} disabled={disabled} aria-label={accessibleLabel}
      onChange={event => onChange(event.target.checked)} />
    {label}
  </label>;
}
