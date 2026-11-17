import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Copy, Database, HardDrive, History, KeyRound, Layers, RefreshCw, X } from 'lucide-react';
import type { SnapshotSummary, SourceSummary } from '../shared/sources';
import { Select } from './Select';
import { formatBytes, type Request } from './source-upload';
import { snapshotLine, snapshotStates, sourceKinds } from './ProjectSourcesDialog';
import './specialists.css';
import './sources.css';

interface Storage { configured: boolean; kind?: string; problem?: string; limits: Record<string, number>; activeParts: number; indexQueue: number; indexFailures: number;
  openUploads: number; orphanBlobs: number; unsupportedFiles: number; indexChunks: number }
interface Usage { bindings: { id: string; projectId: string; projectName?: string; selector: string; enabled: boolean }[];
  grants: { projectId: string; profileId: string; bindingId: string }[]; bundles: { id: string; projectId: string; label: string }[]; hiddenProjects: number; deletionBlockers: string[] }
type Snapshot = SnapshotSummary & { dependencies: { id: string }[] };
interface LegacyReport { version: number; applied: { version: number; appliedAt: string }[]; items: { datasetId: string; name: string; classification: string; projects: string[];
  missingProjects: string[]; profiles: string[]; roles: string[]; plan: { createSource: string; notes: string[] } }[] }

/** Settings → Sources: installation-wide registry, storage status and where each source is used. */
export function SourcesPanel({ request }: { request: Request }) {
  const [sources, setSources] = useState<SourceSummary[]>();
  const [storage, setStorage] = useState<Storage>();
  const [selected, setSelected] = useState<string>();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [usage, setUsage] = useState<Usage>();
  const [platform, setPlatform] = useState<{ id: string; label: string }[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<{ token: string; expiresAt: string }>();
  const [legacy, setLegacy] = useState<LegacyReport>();
  const load = useCallback(async () => {
    try {
      const [list, status, old] = await Promise.all([request<SourceSummary[]>('/api/admin/sources'), request<Storage>('/api/admin/sources-storage').catch(() => undefined),
        request<LegacyReport>('/api/admin/sources-legacy').catch(() => undefined)]);
      setSources(list); setStorage(status); setLegacy(old);
    } catch (e) { setError((e as Error).message); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  const source = sources?.find(s => s.id === selected);
  useEffect(() => {
    if (!selected || !sources) return;
    void Promise.all([request<Snapshot[]>(`/api/admin/sources/${selected}/snapshots`), request<Usage>(`/api/admin/sources/${selected}/usage`)])
      .then(([s, u]) => { setSnapshots(s); setUsage(u); }).catch(e => setError((e as Error).message));
    const others = sources.filter(s => s.id !== selected && !s.archivedAt && (s.kind === 'code' || s.kind === 'mixed'));
    void Promise.all(others.map(o => request<SnapshotSummary[]>(`/api/admin/sources/${o.id}/snapshots`)
      .then(list => list.filter(x => x.state === 'ready').map(x => ({ id: x.id, label: `${o.name} ${x.label}` }))).catch(() => []))).then(lists => setPlatform(lists.flat()));
  }, [selected, sources, request]);
  async function act(work: () => Promise<unknown>, done?: string) {
    setPending(true); setError(''); setNotice('');
    try { await work(); await load(); if (done) setNotice(done); } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }
  const setDeps = (s: Snapshot, ids: string[]) => act(() => request(`/api/admin/sources/${source!.id}/snapshots/${s.id}/dependencies`, { method: 'PUT', body: JSON.stringify({ platformSnapshotIds: ids }) }));
  const post = (url: string) => request(url, { method: 'POST', body: '{}' });

  if (source) return <div className="sources-settings">
    <button type="button" className="specialist-back" onClick={() => { setSelected(undefined); setToken(undefined); }}><ChevronLeft size={16} aria-hidden="true" />Все папки библиотеки</button>
    <div className="specialist-header"><h2>{source.name}</h2></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    <section className="specialist-card">
      <h3><Layers size={18} aria-hidden="true" />Где используется</h3>
      {usage && (usage.bindings.length ? <ul className="settings-records">{usage.bindings.map(b => <li key={b.id}><div>
        <strong>{b.projectName ?? b.projectId}</strong>
        <small>{b.selector === 'pinned' ? 'Закреплённая версия' : 'Выбор по дате'}{b.enabled ? '' : ' · отключён'} · специалистов {usage.grants.filter(g => g.bindingId === b.id).length}
          {usage.bundles.some(x => x.projectId === b.projectId) && ` · наборы: ${usage.bundles.filter(x => x.projectId === b.projectId).map(x => x.label).join(', ')}`}</small>
      </div></li>)}</ul> : <p className="help">Не подключён к проектам.</p>)}
      {!!usage?.hiddenProjects && <p className="help">Ещё проектов без вашего доступа: {usage.hiddenProjects}.</p>}
    </section>
    <section className="specialist-card">
      <h3><Database size={18} aria-hidden="true" />Снимки</h3>
      {snapshots.length ? <ul className="settings-records">{snapshots.map(s => <li key={s.id} className="source-snapshot-row">
        <div>
          <strong>{s.label}{s.validFrom && ` · ${s.validFrom} → ${s.validTo ?? 'без окончания'}`}</strong>
          <small>{snapshotLine(s)}{s.coverageAcceptedBy && ' · частичное покрытие принято'}</small>
          {(s.dependencies.length > 0 || (source.canManage && platform.length > 0)) && <span className="chat-consultants source-dependencies">
            <span className="chat-consultant-notice">Совместим с:</span>
            {s.dependencies.map(d => <span key={d.id} className="chat-consultant">{platform.find(o => o.id === d.id)?.label ?? d.id}
              {source.canManage && <button type="button" className="workspace-icon" aria-label="Снять зависимость" disabled={pending}
                onClick={() => void setDeps(s, s.dependencies.map(x => x.id).filter(id => id !== d.id))}><X size={12} /></button>}</span>)}
            {source.canManage && platform.some(o => !s.dependencies.some(d => d.id === o.id)) && <Select className="chat-consultants-select" label="Подтвердить совместимость" value="" fitContent disabled={pending}
              options={[{ value: '', label: '+ подтвердить', disabled: true }, ...platform.filter(o => !s.dependencies.some(d => d.id === o.id)).map(o => ({ value: o.id, label: o.label }))]}
              onChange={id => void setDeps(s, [...s.dependencies.map(x => x.id), id])} />}
          </span>}
        </div>
        {source.canManage && <span className="settings-actions">
          {s.failure === 'partial_index' && <button type="button" className="secondary" disabled={pending} onClick={() => {
            if (confirm('Принять частичное покрытие? Агент будет предупреждать о неполном индексе.')) void act(() => post(`/api/admin/sources/${source.id}/snapshots/${s.id}/accept-coverage`));
          }}>Принять покрытие</button>}
          {['failed', 'ready'].includes(s.state) && <button type="button" className="secondary" disabled={pending}
            onClick={() => void act(() => post(`/api/admin/sources/${source.id}/snapshots/${s.id}/reindex`), 'Подготовка поставлена в очередь.')}>Подготовить заново</button>}
          {s.state !== 'archived' && <button type="button" className="secondary" disabled={pending}
            onClick={() => void act(() => post(`/api/admin/sources/${source.id}/snapshots/${s.id}/archive`), 'Снимок архивирован.')}>В архив</button>}
        </span>}
      </li>)}</ul> : <p className="help">Снимков ещё нет. Загрузите каталог из экрана «Библиотека проекта».</p>}
      <p className="help">Совместимость конфигурации с платформой подтверждается явно и не выводится из номеров версий.</p>
    </section>
    {source.canUpload && !source.archivedAt && <section className="specialist-card">
      <h3><KeyRound size={18} aria-hidden="true" />Локальная утилита загрузки</h3>
      <p className="help">Для больших каталогов и браузеров без выбора папки. Токен действует 60 минут, только для загрузки снимков этого источника, и показывается один раз.</p>
      {token ? <div className="execution-device-code source-token">
        <code>{token.token}</code>
        <p className="help">Действует до {new Date(token.expiresAt).toLocaleString('ru')}. Сохраните в переменной FASTKORE_SOURCES_TOKEN или в файле для --token-file.</p>
        <code className="source-command">node tools/source-upload.mjs --server {location.origin} --source {source.id} --label ВЕРСИЯ ПАПКА</code>
      </div> : null}
      <div className="settings-actions">
        {token && <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(token.token).then(() => setNotice('Токен скопирован.'))}><Copy size={15} aria-hidden="true" />Скопировать токен</button>}
        <button type="button" className="secondary" disabled={pending} onClick={() => void act(async () => setToken(await request<{ token: string; expiresAt: string }>(`/api/admin/sources/${source.id}/upload-tokens`, { method: 'POST', body: JSON.stringify({ ttlMinutes: 60 }) })))}>Выдать токен</button>
        <button type="button" className="secondary" disabled={pending} onClick={() => void act(async () => { await request(`/api/admin/sources/${source.id}/upload-tokens`, { method: 'DELETE' }); setToken(undefined); }, 'Токены отозваны.')}>Отозвать токены</button>
      </div>
    </section>}
    <div className="settings-actions">
      {!source.archivedAt && <button type="button" className="secondary" disabled={pending || !source.canManage} onClick={() => {
        if (confirm('Архивировать источник? Новые подключения станут недоступны.')) void act(() => request(`/api/admin/sources/${source.id}/archive`, { method: 'POST', body: JSON.stringify({ revision: source.policyRevision }) }));
      }}>Архивировать</button>}
      {source.archivedAt && <button type="button" className="secondary" disabled={pending || !!usage?.deletionBlockers.length} onClick={() => {
        if (confirm('Удалить источник? Объекты без ссылок будут удалены из хранилища.')) void act(async () => { await request(`/api/admin/sources/${source.id}`, { method: 'DELETE' }); setSelected(undefined); }, 'Источник удалён.');
      }}>Удалить</button>}
    </div>
    {!!usage?.deletionBlockers.length && source.archivedAt && <p className="help">Удаление недоступно: {usage.deletionBlockers.join('; ')}.</p>}
  </div>;

  return <div className="sources-settings">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="help" role="status">{notice}</p>}
    <section className="setting-section">
      <div className="settings-model-row">
        <label>Хранилище источников</label>
        <button type="button" className="workspace-icon" title="Обновить" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={16} /></button>
      </div>
      {storage ? <>
        <ul className="settings-records">
          <li><div><strong><HardDrive size={15} aria-hidden="true" /> {storage.configured ? (storage.kind === 's3' ? 'Отдельный закрытый S3-бакет' : 'Тестовое локальное хранилище') : 'Хранилище источников не настроено'}</strong>
            <small>{storage.configured ? `Файл до ${formatBytes(storage.limits.maxFileBytes)} · до ${storage.limits.maxFiles?.toLocaleString('ru')} файлов · часть ${formatBytes(storage.limits.partBytes)} · квота по умолчанию ${formatBytes(storage.limits.defaultQuotaBytes)}` : storage.problem}</small></div>
            <button type="button" className="secondary" disabled={pending || !storage.configured} onClick={() => void act(() => post('/api/admin/sources-storage/check'), 'Соединение с хранилищем проверено.')}>Проверить соединение</button></li>
          <li><div><strong>Обработчики</strong>
            <small>Очередь подготовки {storage.indexQueue}{storage.indexFailures ? `, ошибок ${storage.indexFailures}` : ''} · активных загрузок {storage.openUploads} (частей в передаче {storage.activeParts}) · бесхозных объектов {storage.orphanBlobs} · файлов без поиска {storage.unsupportedFiles}</small></div></li>
        </ul>
        <p className="help">Адрес и ключи хранилища задаются на сервере (BRIDGE_SOURCES_S3_*) и здесь не показываются.</p>
      </> : <p className="help">Состояние хранилища доступно руководителю.</p>}
    </section>
    {legacy && legacy.items.length > 0 && <section className="setting-section">
      <div className="settings-model-row"><label>Прежние серверные источники</label></div>
      <ul className="settings-records">{legacy.items.map(item => <li key={item.datasetId}><div>
        <strong><History size={15} aria-hidden="true" /> {item.name}</strong>
        <small>{item.classification === 'restricted' ? 'Закрытый' : 'Общий'} · проектов {item.projects.length}{item.missingProjects.length ? `, удалённых ${item.missingProjects.length}` : ''} · ссылок в профилях {item.profiles.length}, в ролях {item.roles.length}</small>
        {item.plan.notes.map(note => <small key={note}>{note}</small>)}
      </div></li>)}</ul>
      {legacy.applied.length ? <p className="help">Перенос выполнен {new Date(legacy.applied[0].appliedAt).toLocaleString('ru')}. Импорт содержимого папки — через API <code>/api/admin/sources-legacy/&lt;id&gt;/import</code> с предварительным просмотром.</p>
        : <div className="settings-actions"><button type="button" className="secondary" disabled={pending} onClick={() => {
          if (confirm('Создать новые источники и выключенные привязки? Права чтения специалистов не переносятся.')) void act(() => post('/api/admin/sources-legacy/apply'), 'Перенос выполнен. Назначьте специалистов в матрице проекта.');
        }}>Перенести в реестр</button></div>}
    </section>}
    <section className="setting-section">
      <div className="settings-model-row"><label>Папки библиотеки</label></div>
      {sources?.length ? <ul className="settings-records">{sources.map(s => <li key={s.id}>
        <div>
          <strong>{s.name}{s.archivedAt && ' · архив'}</strong>
          <small>{sourceKinds[s.kind]} · {s.classification === 'restricted' ? 'закрытый' : 'общий'} · снимков {s.snapshots} · {formatBytes(s.usedBytes)} из {formatBytes(s.quotaBytes)}
            {s.reservedBytes ? ` · резерв ${formatBytes(s.reservedBytes)}` : ''}{s.latestSnapshot && ` · ${s.latestSnapshot.label}: ${snapshotStates[s.latestSnapshot.state]}`}</small>
        </div>
        <button type="button" className="secondary" onClick={() => { setNotice(''); setSelected(s.id); }}>Открыть</button>
      </li>)}</ul> : <p className="help">Папок пока нет. Добавьте папку в библиотеке проекта.</p>}
    </section>
  </div>;
}
