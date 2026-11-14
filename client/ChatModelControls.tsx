import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { ReasoningEffort } from '../shared/types';
import type { SelectOption } from './Select';

export const reasoningOptions: { value: ReasoningEffort; label: string }[] = [
  { value: 'low', label: 'Низкое' }, { value: 'medium', label: 'Среднее' },
  { value: 'high', label: 'Высокое' }, { value: 'xhigh', label: 'Максимальное' },
];

export function ChatModelControls({ effort, levels, model, models, disabled, onEffort, onModel }: {
  effort: ReasoningEffort; levels: typeof reasoningOptions; model: string; models: SelectOption[]; disabled: boolean;
  onEffort: (effort: ReasoningEffort) => void; onModel: (model: string) => void;
}) {
  const [step, setStep] = useState<'effort' | 'model' | null>(null);
  const [preview, setPreview] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const modelMenu = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const id = useId();
  const actual = Math.max(0, levels.findIndex(item => item.value === effort));
  const index = preview ?? actual;
  const level = levels[index] ?? levels[actual];
  const modelName = models.find(item => item.value === model)?.label ?? (model || 'Выбрать модель');
  const open = !!step;

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) { setStep(null); setPreview(undefined); }
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  useEffect(() => {
    if (step === 'model') (modelMenu.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')
      ?? modelMenu.current?.querySelector('button'))?.focus();
  }, [step]);

  function chooseLevel(next: number) {
    const value = levels[next]?.value;
    setPreview(undefined);
    if (value && value !== effort) onEffort(value);
  }

  return <div ref={root} className="chat-model-control" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) { setStep(null); setPreview(undefined); }
  }} onKeyDown={event => {
    if (event.key !== 'Escape' || !step) return;
    event.preventDefault(); event.stopPropagation();
    if (step === 'model') { setStep('effort'); requestAnimationFrame(() => modelButton.current?.focus()); }
    else { setStep(null); setPreview(undefined); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="workspace-select chat-model-trigger" aria-expanded={open}
      aria-controls={open ? id : undefined} aria-label={'Глубина рассуждения: ' + levels[actual].label} disabled={disabled}
      onClick={() => setStep(step ? null : 'effort')}>
      {levels[actual].label}<ChevronDown size={13} aria-hidden="true" />
    </button>
    {step === 'effort' && <div id={id} className="chat-model-popover effort-popover" aria-label="Настройки ответа">
      <div className="effort-heading">
        <button ref={modelButton} type="button" className="effort-model" disabled={disabled || !models.length} onClick={() => setStep('model')}>
          <strong>{level.label}</strong><span title={modelName}>{modelName}<ChevronRight size={12} aria-hidden="true" /></span>
        </button>
        <button type="button" className="workspace-icon effort-reset" aria-label="Сбросить до высокого" title="Сбросить до высокого"
          disabled={disabled || effort === 'high'} onClick={() => chooseLevel(levels.findIndex(item => item.value === 'high'))}><RotateCcw size={16} /></button>
      </div>
      <div className="effort-track" style={{ '--effort-fill': `${100 * index / Math.max(1, levels.length - 1)}%` } as React.CSSProperties}>
        <div className="effort-marks" aria-hidden="true">{levels.map(item => <span key={item.value} />)}</div>
        <input type="range" min={0} max={levels.length - 1} step={1} value={index} disabled={disabled}
          aria-label="Глубина рассуждения" aria-valuetext={level.label} onPointerDown={() => { dragging.current = true; }}
          onPointerUp={event => { dragging.current = false; chooseLevel(Number(event.currentTarget.value)); }}
          onPointerCancel={() => { dragging.current = false; setPreview(undefined); }}
          onChange={event => { const next = Number(event.currentTarget.value); if (dragging.current) setPreview(next); else chooseLevel(next); }} />
      </div>
    </div>}
    {step === 'model' && <div ref={modelMenu} id={id} className="chat-model-popover model-list-popover" role="group" aria-label="Выбрать модель">
      <p>Выбрать модель</p>
      {models.map(item => <button type="button" key={item.value} data-selected={item.value === model} aria-pressed={item.value === model}
        title={item.detailTitle} disabled={item.disabled || disabled} onClick={() => {
          setStep('effort'); requestAnimationFrame(() => { if (modelButton.current && !modelButton.current.disabled) modelButton.current.focus(); });
          if (item.value !== model) onModel(item.value);
        }}>
        <span>{item.label}</span>{item.detail && item.detail !== '—' && <small>{item.detail}</small>}
        {item.value === model && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>;
}
