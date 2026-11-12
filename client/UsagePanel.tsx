import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { TokenActivityReport } from '../shared/types';
import { Select } from './Select';

const dayMs = 86_400_000;
const weeks = 52;
const modes = { days: 'По дням', weeks: 'По неделям', total: 'Нарастающим итогом' };
type Mode = keyof typeof modes;
const number = new Intl.NumberFormat('ru-RU');
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' });
const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' });
const dateKey = (date: number) => new Date(date).toISOString().slice(0, 10);

export function UsagePanel({ request }: { request: <T>(url: string, init?: RequestInit) => Promise<T> }) {
  const [report, setReport] = useState<TokenActivityReport>();
  const [error, setError] = useState('');
  const [owner, setOwner] = useState('all');
  const [mode, setMode] = useState<Mode>('days');
  const [selected, setSelected] = useState<number>();
  const plot = useRef<HTMLDivElement>(null);
  const today = new Date();
  const currentDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const weekStart = currentDay - ((new Date(currentDay).getUTCDay() + 6) % 7) * dayMs;
  const start = weekStart - (weeks - 1) * 7 * dayMs;
  const records = owner === 'all' ? report?.total : owner === 'unattributed'
    ? report?.unattributed : report?.users.find(user => user.id === owner)?.days;

  useEffect(() => {
    const controller = new AbortController();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    request<TokenActivityReport>('/api/admin/usage?timeZone=' + encodeURIComponent(timeZone), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [request]);

  const { days, periods, months, total } = useMemo(() => {
    const byDate = new Map(records?.map(day => [day.date, day.tokens]));
    const days = Array.from({ length: weeks * 7 }, (_, index) => {
      const date = start + index * dayMs;
      return { date, tokens: byDate.get(dateKey(date)) ?? 0 };
    });
    let total = 0;
    const periods = Array.from({ length: weeks }, (_, index) => {
      const date = start + index * 7 * dayMs;
      const tokens = days.slice(index * 7, index * 7 + 7).reduce((sum, day) => sum + day.tokens, 0);
      total += tokens;
      return { date, tokens, total };
    });
    const monthStarts = periods.flatMap(({ date }, index) => {
      const label = monthName.format(date);
      const prior = index ? monthName.format(periods[index - 1].date) : '';
      return label !== prior ? [{ column: index + 1, label }] : [];
    });
    const months = monthStarts.filter((month, index) => !monthStarts[index + 1] || monthStarts[index + 1].column - month.column >= 3);
    return { days, periods, months, total };
  }, [records, start]);

  useEffect(() => {
    if (plot.current) plot.current.scrollLeft = plot.current.scrollWidth;
  }, [report]);

  const rows = useMemo(() => {
    if (!report) return [];
    const today = dateKey(currentDay), week = dateKey(currentDay - 6 * dayMs), firstDay = dateKey(start);
    const accounts = [...report.users];
    if (report.unattributed.some(day => day.date >= firstDay && day.date <= today)) {
      accounts.push({ id: 'unattributed', name: 'Автор неизвестен', disabled: false, days: report.unattributed });
    }
    return accounts.map(({ id, name, disabled, days }) => {
      let daily = 0, weekly = 0, total = 0;
      for (const { date, tokens } of days) {
        if (date < firstDay || date > today) continue;
        if (date === today) daily += tokens;
        if (date >= week) weekly += tokens;
        total += tokens;
      }
      return { id, label: name + (disabled ? ' (отключён)' : ''), daily, weekly, total };
    }).sort((a, b) => b.weekly - a.weekly || b.total - a.total || a.label.localeCompare(b.label, 'ru'));
  }, [report, start, currentDay]);

  if (error) return <p className="inline-error" role="alert">{error}</p>;
  if (!records) return <p role="status">Загрузка…</p>;
  const isDaily = mode === 'days';
  const entries = isDaily ? days : periods.map(period => ({ date: period.date, tokens: mode === 'total' ? period.total : period.tokens }));
  const last = isDaily ? Math.round((currentDay - start) / dayMs) : weeks - 1;
  const active = Math.min(selected ?? last, last);
  const peak = Math.max(1, ...entries.map(entry => entry.tokens));
  const describe = ({ date, tokens }: typeof entries[number]) => {
    const period = isDaily ? fullDate.format(date)
      : mode === 'total' ? 'По ' + fullDate.format(Math.min(date + 6 * dayMs, currentDay))
        : shortDate.formatRange(date, Math.min(date + 6 * dayMs, currentDay));
    return period + ' · ' + number.format(tokens) + ' токенов';
  };

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === 'ArrowLeft' ? -(isDaily ? 7 : 1) : event.key === 'ArrowRight' ? (isDaily ? 7 : 1)
      : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.min(last, Math.max(0, index + step));
    plot.current?.querySelector<HTMLButtonElement>('[data-entry="' + next + '"]')?.focus();
  }

  return <section className="usage-activity" aria-labelledby="usage-heading">
    <div className="usage-owner">
      <label htmlFor="usage-owner">Пользователь</label>
      <Select id="usage-owner" className="settings-select" value={owner} onChange={setOwner}
        options={[{ value: 'all', label: 'Все пользователи' }, ...rows.map(({ id, label }) => ({ value: id, label }))]} />
    </div>
    <header className="usage-heading">
      <div><h3 id="usage-heading">Активность токенов</h3><p>{number.format(total)} за 52 недели</p></div>
      <div className="usage-modes" role="group" aria-label="Период графика">
        {(Object.keys(modes) as Mode[]).map(id => <button key={id} type="button" aria-pressed={id === mode}
          onClick={() => { setMode(id); setSelected(undefined); }}>{modes[id]}</button>)}
      </div>
    </header>
    <div className="usage-chart-scroll" ref={plot}>
      <div className={'usage-chart' + (isDaily ? ' usage-daily' : ' usage-weekly')} aria-label={modes[mode]}>
        {entries.map((entry, index) => index > last ? <span key={entry.date} aria-hidden="true" /> : <button key={entry.date} type="button"
          className="usage-cell" data-entry={index} data-level={entry.tokens ? Math.max(1, Math.ceil(Math.sqrt(entry.tokens / peak) * 4)) : 0}
          style={isDaily ? undefined : { '--bar-size': (100 * entry.tokens / peak) + '%' } as CSSProperties}
          aria-label={describe(entry)} title={describe(entry)} tabIndex={active === index ? 0 : -1} aria-pressed={active === index}
          onFocus={() => setSelected(index)} onClick={() => setSelected(index)} onKeyDown={event => move(event, index)} />)}
      </div>
      <div className="usage-months" aria-hidden="true">{months.map(month => <span key={month.column} style={{ gridColumnStart: month.column }}>{month.label}</span>)}</div>
    </div>
    <div className="usage-legend">
      <output aria-live="polite">{describe(entries[active])}</output>
      {isDaily && <div className="usage-scale" aria-label="От меньшей к большей активности">Меньше
        {[0, 1, 2, 3, 4].map(level => <span key={level} className="usage-cell" data-level={level} aria-hidden="true" />)}Больше
      </div>}
    </div>
    <p className="help">{total ? 'По данным завершённых запросов платформы. Входные и выходные токены.' : 'За этот период в платформе пока нет данных об использовании токенов.'}</p>
    <div className="usage-table-scroll">
      <table className="usage-table">
        <caption>Расход токенов по пользователям</caption>
        <thead><tr><th scope="col">Пользователь</th><th scope="col">Сегодня</th><th scope="col" aria-sort="descending">За 7 дней</th><th scope="col">За 52 недели</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} data-selected={owner === row.id}>
          <th scope="row">{row.label}</th><td>{number.format(row.daily)}</td><td>{number.format(row.weekly)}</td><td>{number.format(row.total)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
