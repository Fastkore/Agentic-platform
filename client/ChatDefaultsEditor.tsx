import { useId, useState } from 'react';
import { Select } from './Select';
import type { ProjectChatDefaults } from '../shared/types';

export function ChatDefaultsEditor({ value, save }: {
  value: ProjectChatDefaults;
  save: (draft: ProjectChatDefaults) => Promise<ProjectChatDefaults>;
}) {
  const effortId = useId();
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  return <details>
    <summary>Перенесённые настройки чата проекта</summary>
    <form className="project-instructions-form" onSubmit={async event => {
      event.preventDefault();
      setPending(true); setMessage('');
      try {
        setDraft(await save({ ...draft, instructionFiles: draft.instructionFiles?.filter(file => file.text.trim()) }));
        setMessage('Сохранено');
      } catch (error) { setMessage((error as Error).message); }
      finally { setPending(false); }
    }}>
      <label>Инструкции обычного чата<textarea value={draft.instructions} maxLength={20000}
        onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
      {draft.instructionFiles?.map((file, index) => <label key={file.name}>{file.name}
        <textarea value={file.text} onChange={event => setDraft({ ...draft, instructionFiles: draft.instructionFiles?.map((item, i) =>
          i === index ? { ...item, text: event.target.value } : item) })} /></label>)}
      <label>Модель обычного чата<input value={draft.model} placeholder="Модель по умолчанию"
        onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
      {draft.model && <div className="project-instructions-form">
        <label htmlFor={effortId}>Глубина рассуждения</label>
        <Select id={effortId} className="settings-select" value={draft.reasoningEffort}
          options={['low', 'medium', 'high', 'xhigh'].map(level => ({ value: level, label: level }))}
          onChange={value => setDraft({ ...draft, reasoningEffort: value as ProjectChatDefaults['reasoningEffort'] })} />
      </div>}
      <div className="settings-dialog-actions"><button className="primary" disabled={pending}>Сохранить настройки чата</button></div>
      {message && <p role="status">{message}</p>}
    </form>
  </details>;
}
