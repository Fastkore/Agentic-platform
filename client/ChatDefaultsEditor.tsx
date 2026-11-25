import { useState } from 'react';
import type { ProjectChatDefaults } from '../shared/types';

export function ChatDefaultsEditor({ value, save }: {
  value: ProjectChatDefaults;
  save: (draft: ProjectChatDefaults) => Promise<ProjectChatDefaults>;
}) {
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
      {draft.model && <label>Глубина рассуждения<select value={draft.reasoningEffort}
        onChange={event => setDraft({ ...draft, reasoningEffort: event.target.value as ProjectChatDefaults['reasoningEffort'] })}>
        {['low', 'medium', 'high', 'xhigh'].map(level => <option key={level}>{level}</option>)}
      </select></label>}
      <div className="settings-dialog-actions"><button className="primary" disabled={pending}>Сохранить настройки чата</button></div>
      {message && <p role="status">{message}</p>}
    </form>
  </details>;
}
