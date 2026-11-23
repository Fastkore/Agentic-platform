import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Upload } from 'lucide-react';

const hasFiles = (data: DataTransfer | null) => data?.types.includes('Files') === true;

export function ChatFileDrop({ enabled, onFiles, onError, children }: {
  enabled: boolean; onFiles: (files: File[]) => void; onError: (message: string) => void; children: ReactNode;
}) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // Suppress the browser's default file navigation even outside the chat area.
    const preventFileNavigation = (event: DragEvent) => {
      if (hasFiles(event.dataTransfer) && !(event.target instanceof HTMLInputElement && event.target.type === 'file')) event.preventDefault();
    };
    const endDrag = (event: DragEvent) => {
      preventFileNavigation(event);
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', endDrag);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', endDrag);
    };
  }, []);

  return <main className="workspace-main"
    onDragEnter={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    }}
    onDragOver={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    }}
    onDragLeave={event => {
      if (!hasFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    }}
    onDrop={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!enabled) return;
      const { files, items } = event.dataTransfer;
      if (Array.from(items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
        onError('Перетащите отдельные файлы.');
        return;
      }
      if (files.length) onFiles(Array.from(files));
    }}>
    {children}
    {enabled && dragging && <div className="chat-file-drop" role="status">
      <span><Upload size={20} aria-hidden="true" />Отпустите файлы, чтобы прикрепить к сообщению</span>
    </div>}
  </main>;
}
