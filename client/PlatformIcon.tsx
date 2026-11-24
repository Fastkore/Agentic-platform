import { useId } from 'react';

export type PlatformIconName =
  | 'folder' | 'folder-open' | 'cloud' | 'database' | 'hard-drive' | 'file' | 'file-text' | 'files'
  | 'image' | 'table' | 'archive' | 'search' | 'filter' | 'settings' | 'users' | 'user' | 'shield'
  | 'key' | 'lock' | 'link' | 'external-link' | 'upload' | 'download' | 'refresh-cw' | 'plus'
  | 'check' | 'x' | 'chevron-right' | 'pencil' | 'trash';

export function PlatformIcon({ name, size = 16, label }: { name: PlatformIconName; size?: number; label?: string }) {
  const titleId = useId();
  return <svg width={size} height={size} viewBox="0 0 24 24" focusable="false" role={label ? 'img' : undefined}
    aria-hidden={label ? undefined : true} aria-labelledby={label ? titleId : undefined}>
    {label && <title id={titleId}>{label}</title>}
    <use href={'/icons/platform.svg#' + name} />
  </svg>;
}
