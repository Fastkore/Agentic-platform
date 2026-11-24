import { useId } from 'react';
import {
  Archive, Check, ChevronRight, Cloud, Database, Download, ExternalLink, File, Files, FileText,
  Filter, Folder, FolderOpen, HardDrive, Image, Key, Link, Lock, Pencil, Plus, RefreshCw, Search,
  Settings, Shield, Table, Trash, Upload, User, Users, X,
} from 'lucide-react';

const icons = {
  folder: Folder, 'folder-open': FolderOpen, cloud: Cloud, database: Database, 'hard-drive': HardDrive,
  file: File, 'file-text': FileText, files: Files, image: Image, table: Table, archive: Archive,
  search: Search, filter: Filter, settings: Settings, users: Users, user: User, shield: Shield,
  key: Key, lock: Lock, link: Link, 'external-link': ExternalLink, upload: Upload, download: Download,
  'refresh-cw': RefreshCw, plus: Plus, check: Check, x: X, 'chevron-right': ChevronRight, pencil: Pencil, trash: Trash,
};
export type PlatformIconName = keyof typeof icons;

export function PlatformIcon({ name, size = 16, label }: { name: PlatformIconName; size?: number; label?: string }) {
  const titleId = useId();
  const Icon = icons[name];
  return <Icon size={size} focusable="false" role={label ? 'img' : undefined}
    aria-hidden={label ? undefined : true} aria-labelledby={label ? titleId : undefined}>
    {label && <title id={titleId}>{label}</title>}
  </Icon>;
}
