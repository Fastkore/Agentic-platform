import { useRef, useState } from 'react';
import { FolderOpen, LoaderCircle, Upload } from 'lucide-react';
import { defaultExclusions, sourceDefaults, type SnapshotSummary, type SourceKind, type UploadSummary } from '../shared/sources';
import { Select } from './Select';
import { cancelUpload, collect, completeUpload, directoryPickerSupported, formatBytes, hashFiles, pendingUpload, prepareUpload, transferUpload, type Request, type ScanResult } from './source-upload';

type Stage = 'pick' | 'scanning' | 'preview' | 'prepared' | 'transfer' | 'done' | 'error';
const problemLabels: Record<string, string> = {
  too_large: 'больше предела файла', absolute: 'абсолютный путь', drive: 'путь с диском', dot: 'компонент . или ..', empty_segment: 'пустой компонент',
  control: 'управляющие символы', backslash: 'обратный слеш', encoded_separator: 'кодированный разделитель', too_long: 'слишком длинный путь', too_deep: 'слишком глубокая вложенность',
  reserved: 'зарезервированное имя Windows', not_normalized: 'ненормализованный Unicode',
};
const Facts = ({ rows }: { rows: [string, string][] }) => <dl className="source-facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;

/** Folder upload: scan and preview in the browser, then manifest, transfer and server-side preparation. */
export function SourceUploadPanel({ request, sourceId, sourceName, kind, snapshots, canDecideSecrets, close, done }: {
  request: Request; sourceId: string; sourceName: string; kind: SourceKind; snapshots: SnapshotSummary[]; canDecideSecrets: boolean; close: () => void; done: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const resume = pendingUpload(sourceId);
  const [stage, setStage] = useState<Stage>('pick');
  const [scan, setScan] = useState<ScanResult>();
  const [hashed, setHashed] = useState(0);
  const [rules, setRules] = useState(defaultExclusions.join('\n'));
  const [label, setLabel] = useState('');
  const ready = snapshots.filter(s => s.state === 'ready');
  const [validFrom, setValidFrom] = useState(ready[0]?.validFrom ?? '');
  const [validTo, setValidTo] = useState(ready[0]?.validTo ?? '');
  const [baseSnapshotId, setBase] = useState(ready[0]?.id ?? '');
  const update = ready.length > 0;
  const [separateVersion, setSeparateVersion] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(new Set<string>());
  const [prepared, setPrepared] = useState<{ uploadId: string; diff?: { added: number; changed: number; removed: number }; upload: UploadSummary }>();
  const [progress, setProgress] = useState<UploadSummary>();
  const [error, setError] = useState('');
  const [resumeId, setResumeId] = useState<string>();
  const supported = directoryPickerSupported();
  const dated = kind === 'prices' || kind === 'documents' || kind === 'mixed';

  async function picked(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    const result = collect(files, rules.split('\n').map(r => r.trim()).filter(Boolean), { maxFileBytes: sourceDefaults.maxFileBytes, maxPathLength: sourceDefaults.maxPathLength, maxDepth: sourceDefaults.maxDepth });
    setScan(result); setStage('scanning'); setHashed(0);
    controller.current = new AbortController();
    try {
      await hashFiles(result, sourceDefaults.partBytes, value => setHashed(value), controller.current.signal);
      setScan({ ...result });
      if (resumeId) {
        const saved = pendingUpload(sourceId);
        if (saved?.uploadId === resumeId && saved.options) {
          const base = `/api/admin/sources/${encodeURIComponent(sourceId)}/uploads/${resumeId}`;
          const status = await request<{ upload: UploadSummary }>(base);
          if (status.upload.state === 'open' && (!status.upload.manifestComplete || saved.options.includeSecrets.length)) {
            await prepareUpload(request, sourceId, result, { ...saved.options, includeSecrets: new Set(saved.options.includeSecrets) }, resumeId);
          }
        }
        await transfer(resumeId, result);
      }
      else setStage('preview');
    } catch (e) { if ((e as Error).name !== 'AbortError') { setError((e as Error).message); setStage('error'); } }
  }
  async function prepare() {
    if (!scan) return;
    setError('');
    try {
      const version = label.trim() || 'Обновление ' + new Date().toISOString().slice(0, 23).replace('T', ' ') + ' UTC';
      const status = await prepareUpload(request, sourceId, scan, { label: version, validFrom, validTo, baseSnapshotId: baseSnapshotId || undefined,
        exclusions: rules.split('\n').map(r => r.trim()).filter(Boolean), includeSecrets, skipUnchanged: update && !separateVersion });
      setPrepared({ uploadId: status.upload.id, diff: status.diff, upload: status.upload });
      setStage('prepared');
    } catch (e) { setError((e as Error).message); }
  }
  async function transfer(uploadId: string, files = scan!) {
    setStage('transfer'); setError('');
    controller.current = new AbortController();
    try {
      const summary = await transferUpload(request, sourceId, uploadId, files, setProgress, controller.current.signal);
      setProgress(summary);
      setProgress(await completeUpload(request, sourceId, uploadId));
      setStage('done');
      done();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message + ' Передачу можно продолжить: выберите ту же папку ещё раз.');
      setResumeId(uploadId);
      setStage('error');
    }
  }
  async function cancel() {
    controller.current?.abort();
    const id = prepared?.uploadId ?? resumeId ?? resume?.uploadId;
    if (id) await cancelUpload(request, sourceId, id).catch(() => {});
    close();
  }
  const pct = (a: number, b: number) => b ? Math.min(100, Math.round(a / b * 100)) : 100;
  const title = (update ? 'Обновить из папки' : 'Загрузить каталог') + ' · ' + sourceName;
  return <section className="agent-card source-upload" aria-label={title}>
    <div className="agent-card-heading">
      <Upload size={17} aria-hidden="true" />
      <div><strong>{title}</strong>
        <p>Папка проверяется в браузере. На сервер ничего не передаётся до подтверждения.</p></div>
    </div>
    {!supported && <p className="inline-error">Этот браузер не умеет выбирать папку целиком. Откройте платформу в Chromium, Edge или окне Fastkore (WebView2).</p>}
    <input ref={input} type="file" hidden multiple {...{ webkitdirectory: '', directory: '' }} onChange={event => { void picked(event.target.files); event.target.value = ''; }} />

    {stage === 'pick' && <>
      {resume && !resumeId && <ul className="settings-records"><li><div>
        <strong>Есть незавершённая загрузка «{resume.label}»</strong><small>Выберите ту же папку, чтобы продолжить с подтверждённых частей.</small></div>
        <span className="settings-actions">
          <button type="button" className="secondary" onClick={() => {
            setResumeId(resume.uploadId);
            if (resume.options) setRules(resume.options.exclusions.join('\n'));
            input.current?.click();
          }}>Продолжить</button>
          <button type="button" className="secondary" onClick={() => void cancelUpload(request, sourceId, resume.uploadId).then(() => setResumeId(undefined))}>Отменить её</button>
        </span></li></ul>}
      <details className="agent-advanced"><summary>Исключения ({rules.split('\n').filter(r => r.trim()).length})</summary>
        <label htmlFor="source-exclusions" className="help">Одно правило в строке; папки оканчиваются на «/».</label>
        <textarea id="source-exclusions" rows={6} value={rules} onChange={e => setRules(e.target.value)} />
      </details>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!supported} onClick={() => input.current?.click()}><FolderOpen size={16} aria-hidden="true" />Выбрать папку…</button>
        <button type="button" className="secondary" onClick={close}>Отмена</button>
      </div>
    </>}

    {stage === 'scanning' && scan && <div className="source-progress" role="status">
      <span><LoaderCircle className="spin" size={15} aria-hidden="true" />Проверка файлов: {formatBytes(hashed)} из {formatBytes(scan.bytes)} · {pct(hashed, scan.bytes)}%</span>
      <progress max={Math.max(1, scan.bytes)} value={hashed} />
    </div>}

    {stage === 'preview' && scan && <>
      <Facts rows={[['Папка', scan.root || '—'], ['Файлов', scan.files.length.toLocaleString('ru')], ['Объём', formatBytes(scan.bytes)],
        ['Исключено', scan.excluded.length.toLocaleString('ru')], ['Не будут загружены', String(scan.problems.length)]]} />
      <details className="agent-advanced"><summary>Папки верхнего уровня</summary><ul className="agent-file-options">{Object.entries(scan.topFolders).sort((a, b) => b[1] - a[1]).slice(0, 50)
        .map(([name, n]) => <li key={name}>{name} — {n}</li>)}</ul></details>
      <details className="agent-advanced"><summary>Типы файлов</summary><ul className="agent-file-options">{Object.entries(scan.types).sort((a, b) => b[1] - a[1]).slice(0, 40)
        .map(([ext, n]) => <li key={ext}>.{ext} — {n}</li>)}</ul></details>
      {scan.excluded.length > 0 && <details className="agent-advanced"><summary>Исключённые файлы ({scan.excluded.length})</summary><ul className="agent-file-options">{scan.excluded.slice(0, 300)
        .map(item => <li key={item.path}>{item.path} <small>{item.rule}</small></li>)}</ul></details>}
      {scan.problems.length > 0 && <details className="agent-advanced" open><summary>Не будут загружены ({scan.problems.length})</summary><ul className="agent-file-options">{scan.problems.slice(0, 300)
        .map(item => <li key={item.path}>{item.path} — {item.problem.startsWith('collision:') ? 'совпадает по регистру с ' + item.problem.slice(10) : problemLabels[item.problem] ?? item.problem}</li>)}</ul></details>}
      {scan.secrets.length > 0 && <fieldset className="agent-tool-list source-secrets">
        <legend>Возможные секреты ({scan.secrets.length}) — по умолчанию исключены</legend>
        <p className="help">Обнаружение секретов неполное. Включение файла — аудируемое решение управляющего источником.</p>
        {scan.secrets.slice(0, 100).map(file => <label key={file.path} className="agent-tool-choice">
          <input type="checkbox" disabled={!canDecideSecrets} checked={includeSecrets.has(file.path)}
            onChange={e => { const next = new Set(includeSecrets); if (e.target.checked) next.add(file.path); else next.delete(file.path); setIncludeSecrets(next); }} />
          <span><strong>{file.path}</strong><small>{file.secretFindings!.join(', ')}</small></span>
        </label>)}
      </fieldset>}
      <div className="source-form-grid">
        <div><label htmlFor="snapshot-label">Версия снимка</label><input id="snapshot-label" required={!update || separateVersion} maxLength={120} value={label} onChange={e => setLabel(e.target.value)} placeholder={update && !separateVersion ? 'По умолчанию дата обновления' : 'например, 27.0.48'} /></div>
        <div><label htmlFor="snapshot-base">Сравнить с</label><Select id="snapshot-base" className="settings-select" value={baseSnapshotId} onChange={setBase}
          options={[{ value: '', label: 'Без сравнения' }, ...ready.map(s => ({ value: s.id, label: s.label }))]} /></div>
        {dated && <>
          <div><label htmlFor="snapshot-from">Действует с{kind === 'prices' && ' *'}</label><input id="snapshot-from" type="date" required={kind === 'prices'} value={validFrom} onChange={e => setValidFrom(e.target.value)} /></div>
          <div><label htmlFor="snapshot-to">Действует до (не включая)</label><input id="snapshot-to" type="date" value={validTo} onChange={e => setValidTo(e.target.value)} /></div>
        </>}
      </div>
      {update && <label className="agent-tool-choice"><input type="checkbox" checked={separateVersion} onChange={e => setSeparateVersion(e.target.checked)} />
        Создать отдельную версию, даже если файлы совпадают</label>}
      <div className="settings-actions">
        <button type="button" className="primary" disabled={(!update || separateVersion) && !label.trim() || !scan.files.length || (kind === 'prices' && !validFrom)} onClick={() => void prepare()}>Проверить на сервере</button>
        <button type="button" className="secondary" onClick={close}>Отмена</button>
      </div>
    </>}

    {stage === 'prepared' && prepared && <>
      <Facts rows={[['К передаче', prepared.upload.files.pending.toLocaleString('ru') + ' файлов'], ['Не изменились', prepared.upload.files.reused.toLocaleString('ru') + ' файлов'],
        ...(prepared.diff ? [['Добавлено / изменено / удалено', `${prepared.diff.added} / ${prepared.diff.changed} / ${prepared.diff.removed}`] as [string, string]] : [])]} />
      <div className="settings-actions">
        <button type="button" className="primary" onClick={() => void transfer(prepared.uploadId)}>{prepared.upload.files.pending ? 'Начать передачу' : 'Завершить проверку'}</button>
        <button type="button" className="secondary" onClick={() => void cancel()}>Отменить загрузку</button>
      </div>
    </>}

    {(stage === 'transfer' || stage === 'done') && progress && <>
      <div className="source-progress" role="status">
        <span><strong>Передача файлов</strong> · {formatBytes(progress.bytes.transferred + progress.bytes.reused)} из {formatBytes(progress.bytes.total)} · файлов {progress.files.verified + progress.files.reused} из {progress.files.total}{progress.files.failed ? ` · ошибок ${progress.files.failed}` : ''}</span>
        <progress max={Math.max(1, progress.bytes.total)} value={progress.bytes.transferred + progress.bytes.reused} />
      </div>
      {stage === 'done' && <p className="help">{progress.unchanged ? 'Папка совпадает с готовым снимком. Используется прежняя версия.' : <><strong>Подготовка для агента</strong> выполняется в фоне. Агент получит доступ после готовности снимка и назначения специалистам.</>}</p>}
      <div className="settings-actions">
        {stage === 'transfer' ? <button type="button" className="secondary" onClick={() => void cancel()}>Отменить загрузку</button>
          : <button type="button" className="secondary" onClick={close}>Закрыть</button>}
      </div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {stage === 'error' && <div className="settings-actions">
      {resumeId && <button type="button" className="primary" onClick={() => input.current?.click()}><FolderOpen size={16} aria-hidden="true" />Выбрать папку и продолжить</button>}
      <button type="button" className="secondary" onClick={() => void cancel()}>Отменить загрузку</button>
    </div>}
  </section>;
}
