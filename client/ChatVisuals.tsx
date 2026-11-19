import { useState, type CSSProperties } from 'react';
import type { ChatVisual, VisualCell } from '../shared/chat-visuals';
import './chat-visuals.css';

const numbers = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 20 });

function display(value: VisualCell): string {
  if (typeof value === 'number') return numbers.format(value);
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return value ?? '—';
}

function valueWithUnit(value: string | number, unit?: string) {
  return display(value) + (unit ? '\u00a0' + unit : '');
}

function BarChart({ chart }: { chart: Extract<ChatVisual, { type: 'chart' }> }) {
  const [selected, setSelected] = useState<number>();
  const values = chart.points.map(point => point.value);
  const minimum = Math.min(0, ...values), maximum = Math.max(0, ...values);
  const range = (maximum - minimum) || 1;
  const zero = maximum === minimum ? 100 : (maximum / range) * 100;
  const choice = selected === undefined ? undefined : chart.points[selected];
  return <figure className="chat-visual-panel chat-visual-chart">
    <figcaption>{chart.title}{chart.unit && <small>{chart.unit}</small>}</figcaption>
    <div className="chat-visual-scroll">
      <div className="chat-visual-bars" style={{ '--bar-count': chart.points.length, '--zero': `${zero}%` } as CSSProperties}>
        {chart.points.map((point, index) => {
          const height = Math.abs(point.value) / range * 100;
          const amount = valueWithUnit(point.value, chart.unit);
          return <button key={index} type="button" className="chat-visual-point" aria-pressed={index === selected}
            aria-label={`${point.label}: ${amount}`} title={`${point.label}: ${amount}`} onClick={() => setSelected(index)}>
            <span className="chat-visual-track" aria-hidden="true">
              <span className="chat-visual-bar" style={{ top: `min(${point.value > 0 ? zero - height : zero}%, 100% - 2px)`, height: `${height}%` }} />
            </span>
            <span className="chat-visual-tick" aria-hidden="true">{point.label}</span>
          </button>;
        })}
      </div>
    </div>
    {choice && <output className="chat-visual-selected">{choice.label} <strong>{valueWithUnit(choice.value, chart.unit)}</strong></output>}
  </figure>;
}

export function ChatVisuals({ visuals }: { visuals: ChatVisual[] }) {
  return <div className="chat-visuals">
    {visuals.map((visual, index) => {
      switch (visual.type) {
        case 'metrics': return <dl key={index} className="chat-visual-metrics" aria-label="Показатели">
          {visual.items.map((item, itemIndex) => <div key={itemIndex} className="chat-visual-panel">
            <dt>{item.label}</dt><dd>{valueWithUnit(item.value, item.unit)}</dd>
          </div>)}
        </dl>;
        case 'chart': return <BarChart key={index} chart={visual} />;
        case 'table': return <div key={index} className="chat-visual-panel chat-visual-table chat-visual-scroll" tabIndex={0}>
          <table>
            <caption>{visual.title}</caption>
            <thead><tr>{visual.columns.map((column, columnIndex) => <th key={columnIndex} scope="col">{column}</th>)}</tr></thead>
            <tbody>{visual.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) =>
              <td key={columnIndex} data-numeric={typeof cell === 'number' || undefined}>{display(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>;
      }
    })}
  </div>;
}
