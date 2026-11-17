import { useRef, useState } from 'react';
import { FilePlus2, FolderOpen, LoaderCircle, Upload } from 'lucide-react';
import { libraryDefaults, profileExclusions, type LibraryFolderSummary, type OperationMode, type OperationSummary } from '../shared/library';
import { cancelUpload, collect, completeUpload, directoryPickerSupported, formatBytes, hashFiles, pendingUpload, prepareUpload, transferUpload, type Request, type ScanResult } from './library-upload';

type Stage = 'pick' | 'scanning' | 'preview' | 'prepared' | 'transfer' | 'done' | 'unchanged' | 'error';
const problemLabels: Record<string, string> = {
  too_large: 'больше предела файла', absolute: 'абсолютный путь', drive: 'путь с диском', dot: 'компонент . или ..', empty_segment: 'пустой компонент',
  control: 'управляющие символы', backslash: 'обратный слеш', encoded_separator: 'кодированный разделитель', too_long: 'слишком длинный путь', too_deep: 'слишком глубокая вложенность',
  reserved: 'зарезервированное имя Windows', not_normalized: 'ненормализованный Unicode',
};
const Facts = ({ rows }: { rows: [string, string][] }) => <dl className="library-facts">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
const limits = { maxFileBytes: libraryDefaults.maxFileBytes, maxPathLength: libraryDefaults.maxPathLength, maxDepth: libraryDefaults.maxDepth };

/**
 * Upload into a library folder. replace — "Загрузить папку" / "Обновить из папки": the chosen folder becomes the complete content;
 * add — "Добавить файлы": files are added or replace files with the same path. Checked in the browser first; nothing is sent before confirmation.
 */
export function LibraryUploadPanel({ request, folder, mode: initialMode, canDecideSecrets, close, done }: {
  request: Request; folder: LibraryFolderSummary; mode: OperationMode; canDecideSecrets: boolean; close: () => void; done: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const open = folder.operation?.status === 'open' ? folder.operation : undefined;
  const saved = pendingUpload(folder.id);
  const [mode, setMode] = useState<OperationMode>(open?.mode ?? initialMode);
  const [stage, setStage] = useState<Stage>('pick');
  const [scan, setScan] = useState<ScanResult>();
  const [hashed, setHashed] = useState(0);
  const [rules, setRules] = useState((saved?.operationId === open?.id && saved?.options?.exclusions || profileExclusions(folder.profile)).join('\n'));
  const [prefix, setPrefix] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(new Set<string>());
  const [prepared, setPrepared] = useState<OperationSummary>();
  const [progress, setProgress] = useState<OperationSummary>();
  const [error, setError] = useState('');
  const [resumeId, setResumeId] = useState<string>();
  const folderPicker = mode === 'replace';
  const supported = !folderPicker || directoryPickerSupported();
  const ruleList = () => rules.split('\n').map(r => r.trim()).filter(Boolean);
  const projects = folder.projects.map(p => p.name ?? p.id);

  async function picked(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    const result = collect(files, ruleList(), limits, folderPicker ? undefined : { prefix });
    setScan(result); setStage('scanning'); setHashed(0);
    controller.current = new AbortController();
    try {
      await hashFiles(result, libraryDefaults.partBytes, value => setHashed(value), controller.current.signal);
      setScan({ ...result });
      if (resumeId) {
        const options = saved?.operationId === resumeId && saved.options ? { ...saved.options, includeSecrets: new Set(saved.options.includeSecrets) }
          : { mode, exclusions: ruleList(), includeSecrets };
        const status = await prepareUpload(request, folder.id, result, options, resumeId);
        if (status.operation.status === 'open') await transfer(resumeId, result);
        else { setPrepared(status.operation); setStage(status.operation.status === 'unchanged' ? 'unchanged' : 'done'); }
      } else setStage('preview');
    } catch (e) { if ((e as Error).name !== 'AbortError') { setError((e as Error).message); setStage('error'); } }
  }
  async function prepare() {
    if (!scan) return;
    setError('');
    try {
      const status = await prepareUpload(request, folder.id, scan, { mode, exclusions: ruleList(), includeSecrets });
      setPrepared(status.operation);
      if (status.operation.status === 'unchanged') { setStage('unchanged'); done(); }
      else setStage('prepared');
    } catch (e) { setError((e as Error).message); }
  }
  async function transfer(operationId: string, files = scan!) {
    setStage('transfer'); setError('');
    controller.current = new AbortController();
    try {
      const summary = await transferUpload(request, folder.id, operationId, files, setProgress, controller.current.signal);
      setProgress(summary);
      setProgress(await completeUpload(request, folder.id, operationId));
      setStage('done');
      done();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message + ' Передачу можно продолжить: выберите ту же папку ещё раз.');
      setResumeId(operationId);
      setStage('error');
    }
  }
  async function cancel() {
    controller.current?.abort();
    const id = prepared?.status === 'open' ? prepared.id : resumeId ?? open?.id;
    if (id) await cancelUpload(request, folder.id, id).catch(() => {});
    done();
    close();
  }
  const pct = (a: number, b: number) => b ? Math.min(100, Math.round(a / b * 100)) : 100;
  const title = (mode === 'add' ? 'Добавить файлы' : folder.current ? 'Обновить из папки' : 'Загрузить папку') + ' · ' + folder.name;
  const diff = prepared?.diff;
  return <section className="agent-card library-upload" aria-label={title}>
    <div className="agent-card-heading">
      <Upload size={17} aria-hidden="true" />
      <div><strong>{title}</strong>
        <p>{mode === 'add' ? 'Файлы добавятся или заменят файлы с тем же путём; остальные материалы сохранятся.'
          : 'Выбранная папка станет полным содержимым: новые файлы добавятся, изменённые заменятся, отсутствующие удалятся.'} До подтверждения на сервер ничего не передаётся.</p></div>
    </div>
    {!supported && <p className="inline-error">Этот браузер не умеет выбирать папку целиком. Откройте платформу в Chrome или Edge.</p>}
    <input ref={input} type="file" hidden multiple {...(folderPicker ? { webkitdirectory: '', directory: '' } : {})}
      onChange={event => { void picked(event.target.files); event.target.value = ''; }} />

    {stage === 'pick' && <>
      {open && !resumeId && <ul className="settings-records"><li><div>
        <strong>Есть незавершённая загрузка</strong><small>Передано {formatBytes(open.bytes.transferred + open.bytes.reused)} из {formatBytes(open.bytes.total)}.
          Выберите ту же папку, чтобы продолжить с подтверждённых частей.</small></div>
        <span className="settings-actions">
          <button type="button" className="secondary" onClick={() => { setMode(open.mode); setResumeId(open.id); setTimeout(() => input.current?.click()); }}>Продолжить загрузку</button>
          <button type="button" className="secondary" onClick={() => void cancel()}>Отменить её</button>
        </span></li></ul>}
      {!folderPicker && <div className="library-field-row">
        <label htmlFor="library-prefix">Папка внутри библиотеки <span className="help">необязательно</span></label>
        <input id="library-prefix" maxLength={512} value={prefix} placeholder="Например: Договоры/2026" onChange={e => setPrefix(e.target.value)} />
      </div>}
      <details className="agent-advanced"><summary>Исключения ({ruleList().length}) · профиль «{folder.profile === 'code' ? 'исходники' : 'документы'}»</summary>
        <label htmlFor="library-exclusions" className="help">Одно правило в строке; папки оканчиваются на «/». Исключённые файлы будут показаны с причиной.</label>
        <textarea id="library-exclusions" rows={6} value={rules} onChange={e => setRules(e.target.value)} />
      </details>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!supported || !!open} onClick={() => input.current?.click()}>
          {folderPicker ? <FolderOpen size={16} aria-hidden="true" /> : <FilePlus2 size={16} aria-hidden="true" />}{folderPicker ? 'Выбрать папку…' : 'Выбрать файлы…'}</button>
        <button type="button" className="secondary" onClick={close}>Закрыть</button>
      </div>
    </>}

    {stage === 'scanning' && scan && <div className="library-progress" role="status">
      <span><LoaderCircle className="spin" size={15} aria-hidden="true" />Проверка файлов: {formatBytes(hashed)} из {formatBytes(scan.bytes)} · {pct(hashed, scan.bytes)}%</span>
      <progress max={Math.max(1, scan.bytes)} value={hashed} />
    </div>}

    {stage === 'preview' && scan && <>
      <Facts rows={[...(folderPicker ? [['Папка', scan.root || '—'] as [string, string]] : []), ['Файлов', scan.files.length.toLocaleString('ru')], ['Объём', formatBytes(scan.bytes)],
        ['Исключено', scan.excluded.length.toLocaleString('ru')], ['Не будут загружены', String(scan.problems.length)]]} />
      {folderPicker && <details className="agent-advanced"><summary>Папки верхнего уровня</summary><ul className="agent-file-options">{Object.entries(scan.topFolders).sort((a, b) => b[1] - a[1]).slice(0, 50)
        .map(([name, n]) => <li key={name}>{name} — {n}</li>)}</ul></details>}
      <details className="agent-advanced"><summary>Типы файлов</summary><ul className="agent-file-options">{Object.entries(scan.types).sort((a, b) => b[1] - a[1]).slice(0, 40)
        .map(([ext, n]) => <li key={ext}>.{ext} — {n}</li>)}</ul></details>
      {scan.excluded.length > 0 && <details className="agent-advanced"><summary>Исключённые файлы ({scan.excluded.length})</summary><ul className="agent-file-options">{scan.excluded.slice(0, 300)
        .map(item => <li key={item.path}>{item.path} <small>правило {item.rule}</small></li>)}</ul></details>}
      {scan.problems.length > 0 && <details className="agent-advanced" open><summary>Не будут загружены ({scan.problems.length})</summary><ul className="agent-file-options">{scan.problems.slice(0, 300)
        .map(item => <li key={item.path}>{item.path} — {item.problem.startsWith('collision:') ? 'совпадает по регистру с ' + item.problem.slice(10) : problemLabels[item.problem] ?? item.problem}</li>)}</ul></details>}
      {scan.secrets.length > 0 && <fieldset className="agent-tool-list library-secrets">
        <legend>Возможные секреты ({scan.secrets.length}) — по умолчанию исключены</legend>
        <p className="help">Обнаружение секретов неполное. Включение файла — аудируемое решение управляющего папкой.</p>
        {scan.secrets.slice(0, 100).map(file => <label key={file.path} className="agent-tool-choice">
          <input type="checkbox" disabled={!canDecideSecrets} checked={includeSecrets.has(file.path)}
            onChange={e => { const next = new Set(includeSecrets); if (e.target.checked) next.add(file.path); else next.delete(file.path); setIncludeSecrets(next); }} />
          <span><strong>{file.path}</strong><small>{file.secretFindings!.join(', ')}</small></span>
        </label>)}
      </fieldset>}
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!scan.files.length} onClick={() => void prepare()}>Сравнить с библиотекой</button>
        <button type="button" className="secondary" onClick={() => setStage('pick')}>Выбрать другое</button>
      </div>
    </>}

    {stage === 'prepared' && prepared && <>
      <Facts rows={[['Добавится', String(diff?.added ?? 0)], ['Изменится', String(diff?.changed ?? 0)], ...(mode === 'replace' ? [['Удалится', String(diff?.removed ?? 0)] as [string, string]] : []),
        ['К передаче', prepared.files.pending.toLocaleString('ru') + ' файлов · ' + formatBytes(prepared.bytes.total - prepared.bytes.reused)],
        ['Уже на сервере', prepared.files.reused.toLocaleString('ru') + ' файлов']]} />
      {projects.length > 0 && <p className="help">Изменения действуют во всех подключённых проектах: {projects.join(', ')}.</p>}
      <div className="settings-actions">
        <button type="button" className="primary" onClick={() => void transfer(prepared.id)}>{prepared.files.pending ? 'Подтвердить и передать' : 'Подтвердить обновление'}</button>
        <button type="button" className="secondary" onClick={() => void cancel()}>Отменить</button>
      </div>
    </>}

    {stage === 'unchanged' && <>
      <p role="status"><strong>Библиотека актуальна.</strong> Выбранные файлы совпадают с текущим содержимым: обновление не требуется.</p>
      <div className="settings-actions"><button type="button" className="secondary" onClick={close}>Закрыть</button></div>
    </>}

    {(stage === 'transfer' || stage === 'done') && progress && <>
      <div className="library-progress" role="status">
        <span><strong>Передача файлов</strong> · {formatBytes(progress.bytes.transferred + progress.bytes.reused)} из {formatBytes(progress.bytes.total)} · файлов {progress.files.verified + progress.files.reused} из {progress.files.total}</span>
        <progress max={Math.max(1, progress.bytes.total)} value={progress.bytes.transferred + progress.bytes.reused} />
      </div>
      {stage === 'done' && <p className="help"><strong>Файлы приняты.</strong> Идёт подготовка к поиску; до её окончания агент использует прежнее содержимое папки.</p>}
      <div className="settings-actions">
        {stage === 'transfer' ? <button type="button" className="secondary" onClick={() => void cancel()}>Отменить загрузку</button>
          : <button type="button" className="secondary" onClick={close}>Закрыть</button>}
      </div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {stage === 'error' && <div className="settings-actions">
      {resumeId && <button type="button" className="primary" onClick={() => input.current?.click()}><FolderOpen size={16} aria-hidden="true" />Выбрать и продолжить</button>}
      <button type="button" className="secondary" onClick={() => void cancel()}>Отменить загрузку</button>
    </div>}
  </section>;
}
