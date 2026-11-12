import { useEffect, useState } from 'react';
import type { DictationModelId, DictationModels } from '../shared/types';

const endpoint = '/api/dictation/models';
const labels: Record<DictationModelId, string> = { turbo: 'Быстро', quality: 'Точнее' };

export function DictationModelSettings({ request }: { request: <T>(url: string, init?: RequestInit) => Promise<T> }) {
  const [state, setState] = useState<DictationModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const working = !!(state?.loading || state?.downloading);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const result = await request<DictationModels | null>(endpoint);
        if (!alive) return;
        setState(result);
        setConnectionError('');
        if (result?.loading || result?.downloading) timer = setTimeout(() => void refresh(), 2000);
      } catch (e) {
        if (!alive) return;
        setConnectionError((e as Error).message);
        if (working) timer = setTimeout(() => void refresh(), 3000);
      }
    }
    if (!busy) void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [request, busy, working]);

  async function change(id: DictationModelId, action: 'download' | 'select') {
    setBusy(true);
    setError('');
    try {
      setState(await request<DictationModels>(`${endpoint}/${id}/${action}`, { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {state && <div className="dictation-model-list" aria-label="Модель распознавания речи">
      {state.models.map(model => <div className="dictation-model-row" key={model.id}>
        <span><b>{labels[model.id]}</b><small>{model.name}</small></span>
        {state.loading === model.id ? <small role="status">Загружается в память…</small>
          : state.downloading === model.id ? <small role="status">Скачивается…</small>
            : state.active === model.id ? <small className="active-dictation-model">Активна</small>
              : <button type="button" className="secondary" disabled={busy || working}
                aria-label={`${model.installed ? 'Выбрать' : 'Загрузить'} ${model.name}`}
                onClick={() => void change(model.id, model.installed ? 'select' : 'download')}>
                {model.installed ? 'Выбрать' : 'Загрузить'}
              </button>}
      </div>)}
    </div>}
    {(error || connectionError || state?.error) && <p className="inline-error" role="alert">{error || connectionError || state?.error}</p>}
  </>;
}
