import { useCallback, useEffect, useState } from 'react';
import { Database, Info, Layers, Plus, RefreshCw, Upload } from 'lucide-react';
import type { ProjectSummary } from '../shared/types';
import type { MatrixCell, ProjectSourceBinding, ProjectSourceSettings, SnapshotSummary, SourceBundle, SourceKind, SourceMatrix, SourceOutputPolicy } from '../shared/sources';
import { WorkspaceDialog } from './WorkspaceDialog';
import { Select } from './Select';
import { PermissionSwitch } from './PermissionSwitch';
import { SourceUploadPanel } from './SourceUploadPanel';
import { formatBytes, type Request } from './source-upload';
import './specialists.css';
import './sources.css';

type BindingView = ProjectSourceBinding & { source: { id: string; name: string; kind: SourceKind; classification: string; description: string }; snapshots: SnapshotSummary[];
  warnings: string[]; canUpload: boolean };
interface Overview { settings: ProjectSourceSettings; storage: { configured: boolean; problem?: string }; matrix: SourceMatrix; bundles: SourceBundle[]; activeRevision: number;
  bindings: BindingView[]; available: { id: string; name: string; kind: SourceKind }[] }
export const sourceKinds: Record<SourceKind, string> = { code: 'Исходный код', documents: 'Документация', prices: 'Прайс-листы', mixed: 'Смешанный' };
export const snapshotStates: Record<string, string> = { uploading: 'Передача файлов', verifying: 'Проверка', indexing: 'Подготовка для агента', ready: 'Готов', failed: 'Ошибка', cancelled: 'Отменён', archived: 'Архив' };
export const outputModes: Record<SourceOutputPolicy, string> = { explanation_only: 'Только объяснение', excerpts_allowed: 'Короткие цитаты' };
const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }));
type Tab = 'sources' | 'matrix' | 'bundles' | 'dates';
const tabs: [Tab, string][] = [['sources', 'Папки'], ['matrix', 'Связи'], ['bundles', 'Наборы версий'], ['dates', 'Даты']];

export function snapshotLine(s: SnapshotSummary) {
  return [snapshotStates[s.state] + (s.state === 'indexing' ? ` ${s.indexedFiles}/${s.totalFiles}` : '') + (s.failure === 'partial_index' ? ' · индекс неполный' : ''),
    `${s.totalFiles.toLocaleString('ru')} файлов · ${formatBytes(s.totalBytes)}`,
    `для поиска ${s.indexedFiles}` + (s.unsupportedFiles ? `, без поиска ${s.unsupportedFiles}` : '') + (s.extractionErrors ? `, ошибок ${s.extractionErrors}` : ''),
    'загружен ' + new Date(s.uploadedAt).toLocaleString('ru')].join(' · ');
}

/** Project → Sources: connect sources, choose versions and assign specialists; same server policies as execution. */
export function ProjectSourcesDialog({ project, request, close, isAdmin, initialProfileId }: {
  project: ProjectSummary; request: Request; close: () => void; isAdmin: boolean; initialProfileId?: string;
}) {
  const base = '/api/projects/' + encodeURIComponent(project.id);
  const [data, setData] = useState<Overview>();
  const [tab, setTab] = useState<Tab>(initialProfileId ? 'matrix' : 'sources');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [uploadFor, setUploadFor] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', kind: 'code' as SourceKind, classification: 'shared', outputPolicy: 'explanation_only' as SourceOutputPolicy });
  const [profileFilter, setProfileFilter] = useState(initialProfileId ?? '');
  const [detail, setDetail] = useState<MatrixCell>();
  const [bundleDraft, setBundleDraft] = useState<{ label: string; items: Record<string, string> }>({ label: '', items: {} });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [settingsDraft, setSettingsDraft] = useState<{ tz: string; rule: boolean }>();

  const load = useCallback(async () => {
    try { setData(await request<Overview>(base + '/sources')); }
    catch (e) { setError((e as Error).message); }
  }, [base, request]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data?.bindings.some(b => b.snapshots.some(s => ['uploading', 'verifying', 'indexing'].includes(s.state)))) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [data, load]);
  async function act(work: () => Promise<unknown>) {
    if (pending) return;
    setPending(true); setError('');
    try { await work(); await load(); } catch (e) { await load(); setError((e as Error).message); } finally { setPending(false); }
  }
  const updateBinding = (b: { id: string; revision: number }, patch: Record<string, unknown>) =>
    act(() => request(base + '/source-bindings/' + b.id, { method: 'PUT', body: JSON.stringify({ revision: b.revision, ...patch }) }));
  const grant = (b: { id: string; revision: number }, profileId: string, enabled: boolean) =>
    act(() => request(base + '/source-grants', { method: 'PUT', body: JSON.stringify({ bindingId: b.id, profileId, enabled, bindingRevision: b.revision }) }));

  const uploading = data?.bindings.find(b => b.id === uploadFor);
  const pinned = data?.bindings.filter(b => b.selector === 'pinned' && b.enabled) ?? [];
  const profiles = data?.matrix.profiles.filter(p => !profileFilter || p.id === profileFilter) ?? [];
  const settings = settingsDraft ?? (data && { tz: data.settings.businessTimeZone, rule: data.settings.currentDateRule });

  return <WorkspaceDialog title="Библиотека проекта" className="project-agents-dialog project-sources-dialog" close={() => { if (!pending) close(); }}>
    <div className="project-agents-intro">
      <div>
        <strong>{project.name}</strong>
        <p className="source-selection"><Layers size={13} aria-hidden="true" />{data?.matrix.selectionLabel || 'Источники не выбраны'}</p>
      </div>
      <span className="project-specialist-actions">
        <button type="button" className="workspace-icon" title="Обновить" aria-label="Обновить" disabled={pending} onClick={() => void load()}><RefreshCw size={16} /></button>
        {isAdmin && <button type="button" className="secondary" aria-expanded={creating} onClick={() => { setTab('sources'); setCreating(!creating); }}><Plus size={16} aria-hidden="true" />Создать источник</button>}
      </span>
    </div>
    <div className="specialist-tabs source-tabs" role="tablist" aria-label="Разделы источников">
      {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {data && !data.storage.configured && <p className="inline-error">Хранилище источников не настроено. {data.storage.problem}</p>}
    {!data && !error && <p role="status">Загрузка…</p>}
    {data && <div className="project-agent-scroll source-panel">

      {tab === 'sources' && <>
        {creating && <form className="agent-card source-form" onSubmit={e => { e.preventDefault(); void act(async () => {
          await request('/api/admin/sources', { method: 'POST', body: JSON.stringify({ ...draft, projectId: project.id }) });
          setCreating(false); setDraft({ ...draft, name: '', description: '' });
        }); }}>
          <div className="source-form-grid">
            <div><label htmlFor="source-name">Название</label><input id="source-name" required maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></div>
            <div><label htmlFor="source-description">Назначение</label><input id="source-description" maxLength={2000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></div>
            <div><label htmlFor="source-kind">Тип</label><Select id="source-kind" className="settings-select" value={draft.kind} options={options(sourceKinds)} onChange={kind => setDraft({ ...draft, kind: kind as SourceKind })} /></div>
            <div><label htmlFor="source-class">Классификация</label><Select id="source-class" className="settings-select" value={draft.classification}
              options={[{ value: 'shared', label: 'Общий' }, { value: 'restricted', label: 'Закрытый' }]} onChange={classification => setDraft({ ...draft, classification })} /></div>
            <div><label htmlFor="source-output">Выдача по умолчанию</label><Select id="source-output" className="settings-select" value={draft.outputPolicy} options={options(outputModes)}
              onChange={outputPolicy => setDraft({ ...draft, outputPolicy: outputPolicy as SourceOutputPolicy })} /></div>
          </div>
          <p className="help">Источник появится в общем реестре и подключится к проекту. Агент начнёт его использовать после загрузки снимка и назначения специалистам.</p>
          <div className="settings-actions">
            <button type="submit" className="primary" disabled={pending || !draft.name.trim()}>Создать и подключить</button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>Отмена</button>
          </div>
        </form>}
        {uploading && <SourceUploadPanel request={request} sourceId={uploading.sourceId} sourceName={uploading.source.name} kind={uploading.source.kind}
          snapshots={uploading.snapshots} canDecideSecrets={isAdmin} close={() => setUploadFor(undefined)} done={() => void load()} />}
        {data.bindings.length > 0 ? <ul className="agent-card-list">
          {data.bindings.map(b => {
            const bundled = data.matrix.activeBundle?.items.find(i => i.bindingId === b.id)?.snapshotId;
            const current = b.snapshots.find(s => s.id === (bundled ?? b.snapshotId)) ?? (b.selector === 'effective_date' ? undefined : b.snapshots[0]);
            const assigned = data.matrix.cells.filter(c => c.bindingId === b.id && c.granted).map(c => data.matrix.profiles.find(p => p.id === c.profileId)?.name).filter(Boolean);
            return <li key={b.id} className={'agent-card' + (b.enabled ? '' : ' source-disabled')}>
              <div className="agent-card-heading">
                <Database size={17} aria-hidden="true" />
                <div>
                  <strong>{b.source.name}</strong>
                  <p>{[sourceKinds[b.source.kind], b.source.classification === 'restricted' ? 'Закрытый' : 'Общий', outputModes[b.outputPolicy], b.enabled ? '' : 'Отключён'].filter(Boolean).join(' · ')}
                    {b.source.description && <><br />{b.source.description}</>}</p>
                </div>
                {b.canUpload && <span className="project-specialist-actions">
                  <button type="button" className="secondary" disabled={pending || !data.storage.configured} onClick={() => setUploadFor(b.id)}><Upload size={15} aria-hidden="true" />{b.snapshots.some(s => s.state === 'ready') ? 'Обновить из папки' : 'Загрузить каталог'}</button>
                </span>}
              </div>
              <div className="source-card-body">
                {b.selector === 'pinned' ? <div className="source-field-row">
                  <label htmlFor={'version-' + b.id}>Версия</label>
                  <Select id={'version-' + b.id} className="settings-select" disabled={pending || !!bundled} value={bundled ?? b.snapshotId ?? ''}
                    options={[{ value: '', label: 'Не выбрана' }, ...b.snapshots.map(s => ({ value: s.id, label: s.label, detail: snapshotStates[s.state], disabled: s.state !== 'ready' }))]}
                    onChange={value => void updateBinding(b, { snapshotId: value || null })} />
                  {bundled && <p className="help">Задана активным набором «{data.matrix.activeBundle!.label}».</p>}
                </div> : <fieldset className="agent-tool-list source-periods">
                  <legend>Периоды действия · выбор по дате</legend>
                  {b.snapshots.map(s => <label key={s.id} className="agent-tool-choice">
                    <input type="checkbox" disabled={pending || s.state !== 'ready' || !s.validFrom} checked={b.approvedSnapshotIds.includes(s.id)}
                      onChange={e => void updateBinding(b, { approvedSnapshotIds: e.target.checked ? [...b.approvedSnapshotIds, s.id] : b.approvedSnapshotIds.filter(id => id !== s.id) })} />
                    <span><strong>{s.label}</strong><small>{s.validFrom ?? '—'} → {s.validTo ?? 'без окончания'} · {snapshotStates[s.state]}</small></span>
                  </label>)}
                  {!b.snapshots.length && <p className="help">Снимков ещё нет.</p>}
                  {b.warnings.map(w => <p key={w} className="inline-error">{w}</p>)}
                </fieldset>}
                {current && <p className="help">{snapshotLine(current)}</p>}
                <p className="help">Специалисты: {assigned.length ? assigned.join(', ') : 'не назначены — агент источник не использует'}</p>
              </div>
              <div className="settings-actions source-card-actions">
                <Select className="settings-select" label="Режим выдачи" value={b.outputPolicy} options={options(outputModes)} disabled={pending} fitContent
                  onChange={outputPolicy => void updateBinding(b, { outputPolicy })} />
                <button type="button" className="secondary" disabled={pending} onClick={() => void updateBinding(b, { enabled: !b.enabled })}>{b.enabled ? 'Отключить' : 'Включить'}</button>
                <button type="button" className="secondary" disabled={pending} onClick={() => {
                  if (confirm(`Отсоединить «${b.source.name}» от проекта? Снимки останутся в реестре.`)) void act(() => request(base + '/source-bindings/' + b.id, { method: 'DELETE', body: JSON.stringify({ revision: b.revision }) }));
                }}>Отсоединить</button>
              </div>
            </li>;
          })}
        </ul> : <p className="help">К проекту ещё не подключены источники.</p>}
        {data.available.length > 0 && <div className="settings-project-actions">
          <Select className="settings-select" label="Подключить существующий источник" value="" fitContent
            options={[{ value: '', label: 'Подключить существующий…', disabled: true }, ...data.available.map(s => ({ value: s.id, label: s.name, detail: sourceKinds[s.kind] }))]}
            onChange={id => { const s = data.available.find(x => x.id === id); if (s) void act(() => request(base + '/source-bindings', { method: 'POST', body: JSON.stringify({ sourceId: s.id, selector: s.kind === 'prices' ? 'effective_date' : 'pinned' }) })); }} />
        </div>}
      </>}

      {tab === 'matrix' && <>
        <div className="source-field-row source-filter">
          <label htmlFor="source-profile-filter">Специалист</label>
          <Select id="source-profile-filter" className="settings-select" value={profileFilter} fitContent
            options={[{ value: '', label: 'Все подключённые' }, ...data.matrix.profiles.map(p => ({ value: p.id, label: p.name }))]} onChange={setProfileFilter} />
        </div>
        {data.matrix.bindings.length ? <div className="source-matrix-wrap"><table className="source-matrix">
          <thead><tr><th scope="col">Источник · версия</th>{profiles.map(p => <th key={p.id} scope="col">{p.name}</th>)}</tr></thead>
          <tbody>{data.matrix.bindings.map(b => <tr key={b.id}>
            <th scope="row"><strong>{b.sourceName}</strong><small>{b.selection}</small></th>
            {profiles.map(p => {
              const cell = data.matrix.cells.find(c => c.bindingId === b.id && c.profileId === p.id)!;
              return <td key={p.id} data-state={cell.allowed ? 'allowed' : cell.granted ? 'blocked' : 'off'}>
                <span className="source-cell">
                  <PermissionSwitch name={`${b.sourceName} — ${p.name}`} checked={cell.granted} disabled={pending} onChange={checked => void grant(b, p.id, checked)} />
                  <span>{cell.granted ? (cell.allowed ? outputModes[cell.outputPolicy!] : 'Недоступно') : 'Нет доступа'}</span>
                  <button type="button" className="workspace-icon" title="Почему" aria-label={`Эффективный доступ: ${b.sourceName} — ${p.name}`} onClick={() => setDetail(cell)}><Info size={15} /></button>
                </span>
              </td>;
            })}
          </tr>)}</tbody>
        </table></div> : <p className="help">Подключите папку на вкладке «Папки».</p>}
        {detail && <div className="agent-card source-detail" role="status">
          <strong>{data.matrix.bindings.find(b => b.id === detail.bindingId)?.sourceName} → {data.matrix.profiles.find(p => p.id === detail.profileId)?.name}</strong>
          <p className="help">{detail.allowed ? `Специалист использует источник для анализа. Выдача: ${outputModes[detail.outputPolicy!]}.` : 'Недоступно: ' + detail.reasons.join('; ') + '.'}</p>
          <p className="help">Доступ сотрудника дополнительно ограничен членством в проекте и правом использовать специалиста.</p>
        </div>}
      </>}

      {tab === 'bundles' && <>
        {data.bundles.length > 0 && <ul className="agent-card-list">{data.bundles.map(b => <li key={b.id} className="agent-card">
          <div className="agent-card-heading">
            <Layers size={17} aria-hidden="true" />
            <div>
              <strong>{b.label}{b.state === 'active' && ' · активный'}</strong>
              <p>{b.items.map(i => { const x = data.bindings.find(v => v.id === i.bindingId); return `${x?.source.name ?? '—'} ${x?.snapshots.find(s => s.id === i.snapshotId)?.label ?? '—'}`; }).join(' → ')} · {new Date(b.createdAt).toLocaleString('ru')}</p>
            </div>
            {b.state !== 'active' && <span className="project-specialist-actions"><button type="button" className="secondary" disabled={pending} onClick={() => void act(async () => {
              const result = await request<{ warnings: string[] }>(base + '/source-bundles/' + b.id + '/activate', { method: 'POST', body: JSON.stringify({ expectedActiveRevision: data.activeRevision }) });
              setWarnings(result.warnings);
            })}>Сделать активным</button></span>}
          </div>
        </li>)}</ul>}
        {pinned.length > 0 ? <form className="agent-card source-form" onSubmit={e => { e.preventDefault(); void act(async () => {
          const result = await request<{ warnings: string[] }>(base + '/source-bundles', { method: 'POST', body: JSON.stringify({ label: bundleDraft.label, activate: true,
            expectedActiveRevision: data.activeRevision, items: Object.entries(bundleDraft.items).filter(([, v]) => v).map(([bindingId, snapshotId]) => ({ bindingId, snapshotId })) }) });
          setWarnings(result.warnings); setBundleDraft({ label: '', items: {} });
        }); }}>
          <strong>Новый набор версий</strong>
          <p className="help">Набор переключает все входящие источники одновременно. Совместимость конфигурации и платформы проверяется по подтверждённым зависимостям снимков.</p>
          <div className="source-form-grid">
            {pinned.map(b => <div key={b.id}><label htmlFor={'bundle-' + b.id}>{b.source.name}</label>
              <Select id={'bundle-' + b.id} className="settings-select" value={bundleDraft.items[b.id] ?? ''}
                options={[{ value: '', label: 'Не входит' }, ...b.snapshots.filter(s => s.state === 'ready').map(s => ({ value: s.id, label: s.label }))]}
                onChange={value => setBundleDraft({ ...bundleDraft, items: { ...bundleDraft.items, [b.id]: value } })} /></div>)}
            <div><label htmlFor="bundle-label">Название набора</label><input id="bundle-label" required maxLength={120} value={bundleDraft.label} onChange={e => setBundleDraft({ ...bundleDraft, label: e.target.value })} /></div>
          </div>
          <div className="settings-actions"><button type="submit" className="primary" disabled={pending || !bundleDraft.label.trim() || !Object.values(bundleDraft.items).some(Boolean)}>Создать и сделать активным</button></div>
        </form> : <p className="help">Наборы составляются из источников с закреплённой версией.</p>}
        {warnings.map(w => <p key={w} className="help source-warning">{w}</p>)}
      </>}

      {tab === 'dates' && settings && <form className="agent-card source-form" onSubmit={e => {
        e.preventDefault();
        void act(async () => { await request(base + '/source-settings', { method: 'PUT', body: JSON.stringify({ businessTimeZone: settings.tz, currentDateRule: settings.rule, revision: data.settings.revision }) }); setSettingsDraft(undefined); });
      }}>
        <div className="source-field-row"><label htmlFor="source-tz">Часовой пояс проекта (IANA)</label>
          <input id="source-tz" required value={settings.tz} onChange={e => setSettingsDraft({ ...settings, tz: e.target.value })} /></div>
        <label className="personal-toggle">
          <PermissionSwitch name="Текущая бизнес-дата" checked={settings.rule} onChange={rule => setSettingsDraft({ ...settings, rule })} />
          <span>Использовать текущую бизнес-дату, если в вопросе нет даты<small>Агент обязательно называет использованную дату в ответе.</small></span>
        </label>
        <p className="help">Прайсы выбираются по периоду [начало, окончание) среди допущенных снимков. Пересечение периодов требует решения управляющего, пробел даёт «Нет действующего источника». Дата загрузки не используется.</p>
        <div className="settings-actions"><button type="submit" className="primary" disabled={pending || !settingsDraft}>Сохранить</button></div>
      </form>}
    </div>}
  </WorkspaceDialog>;
}
