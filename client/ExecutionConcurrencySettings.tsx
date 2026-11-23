import { useEffect, useState } from 'react';
import { maxExecutionConcurrency } from '../shared/types';

export function ExecutionConcurrencySettings({ value, pending, save }: {
  value: number;
  pending: boolean;
  save: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const next = Number(draft);
  const valid = Number.isInteger(next) && next >= 1 && next <= maxExecutionConcurrency && next !== value;

  return <form className="setting-section execution-concurrency" onSubmit={event => {
    event.preventDefault();
    if (valid && !pending) save(next);
  }}>
    <h3><label htmlFor="execution-limit">Параллельные задания</label></h3>
    <p id="execution-limit-help" className="help">Общий лимит для всех моделей. Ходы одного чата выполняются по очереди.</p>
    <div className="settings-actions">
      <input id="execution-limit" type="number" min={1} max={maxExecutionConcurrency} step={1} required aria-describedby="execution-limit-help"
        disabled={pending} value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="secondary" disabled={pending || !valid}>Сохранить лимит</button>
    </div>
  </form>;
}
