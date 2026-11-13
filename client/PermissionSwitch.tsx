import './permission-switch.css';

export function PermissionSwitch({ name, checked, disabled, onChange }: {
  name: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  return <input className="permission-switch" type="checkbox" role="switch" aria-label={name}
    checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}
