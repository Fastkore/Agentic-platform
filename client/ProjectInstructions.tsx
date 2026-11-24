import { useState } from 'react';
import { maxProjectInstructions, type ProjectSummary } from '../shared/types';

export const projectInstructionsHint = 'Цель проекта, границы работы и требования к ответам агентов';

export function ProjectInstructions({ project, save }: {
  project: ProjectSummary;
  save: (previous: string, instructions: string) => Promise<string>;
}) {
  const [saved, setSaved] = useState(project.instructions ?? '');
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  if (!project.canRename) return <p className="project-instructions-text">{project.instructions || 'Инструкция проекта пока не задана.'}</p>;
  return <form className="project-instructions-form" onSubmit={async event => {
    event.preventDefault();
    if (pending || saved === draft.trim()) return;
    setPending(true); setError(''); setFeedback('');
    try {
      const text = await save(saved, draft);
      setSaved(text); setDraft(text); setFeedback('Сохранено. Инструкция применяется со следующего задания.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }}>
    <label htmlFor="edit-project-instructions">Инструкция для агентов проекта</label>
    <textarea id="edit-project-instructions" rows={5} value={draft} maxLength={maxProjectInstructions}
      placeholder={projectInstructionsHint} readOnly={pending}
      onChange={event => { setDraft(event.target.value); setFeedback(''); setError(''); }} />
    {error && <p className="inline-error" role="alert">{error}</p>}
    {feedback && <p className="help" role="status">{feedback}</p>}
    <div className="settings-dialog-actions"><button type="submit" className="primary" disabled={pending || saved === draft.trim()}>Сохранить</button></div>
  </form>;
}
