import { useId, useState } from 'react';
import { ArrowLeft, ArrowRight, Save, X } from 'lucide-react';
import { Select } from './Select';
import type { Request } from './library-upload';

export interface StorageLocation { endpoint: string; bucket: string; region: string; forcePathStyle: boolean }
export interface StorageStatus { configured: boolean; kind?: string; location?: StorageLocation; problem?: string; indexQueue: number; indexFailures: number; openUploads: number }

export function LibraryStorageSetup({ request, location, onSaved, cancel }: {
  request: Request; location?: StorageLocation; onSaved: () => void; cancel?: () => void;
}) {
  const hintId = useId();
  const [aws, setAws] = useState(location ? !location.endpoint : false);
  const [endpoint, setEndpoint] = useState(location?.endpoint || 'http://minio:9000');
  const [bucket, setBucket] = useState(location?.bucket || '');
  const [region, setRegion] = useState(location?.region || 'us-east-1');
  const [pathStyle, setPathStyle] = useState(location?.forcePathStyle ?? true);
  const [accessKeyId, setKey] = useState(''), [secretAccessKey, setSecret] = useState('');
  const [credentials, setCredentials] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      await request('/api/library/storage', { method: 'PUT', body: JSON.stringify({
        endpoint: aws ? '' : endpoint.trim(), bucket: bucket.trim(), region: region.trim(), forcePathStyle: !aws && pathStyle,
        accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(),
      }) });
      setSecret(''); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <fieldset className="library-source-fields library-setup" disabled={busy}>
    {credentials ? <>
      <strong>Шаг 2. Введите ключи доступа</strong>
      <ol>
        <li>{aws ? 'Откройте AWS IAM → Users и выберите пользователя с доступом к бакету.' : 'Откройте консоль управления вашим хранилищем. В MinIO выберите Access Keys.'}</li>
        <li>{aws ? 'В разделе Security credentials нажмите Create access key.' : 'Создайте ключ доступа для чтения и записи в бакет «' + bucket + '».'} Если ключ уже есть, используйте его.</li>
        <li>Вставьте оба значения ниже и нажмите «Проверить и сохранить».</li>
      </ol>
      <label>Ключ доступа (Access key ID)<input autoComplete="off" spellCheck={false} value={accessKeyId} onChange={e => setKey(e.target.value)} /></label>
      <label>Секретный ключ (Secret access key)<input type="password" autoComplete="new-password" value={secretAccessKey} onChange={e => setSecret(e.target.value)} /></label>
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!accessKeyId.trim() || !secretAccessKey.trim()} onClick={() => void save()}><Save size={16} aria-hidden="true" />{busy ? 'Проверяем бакет…' : 'Проверить и сохранить'}</button>
        <button type="button" className="secondary" onClick={() => { setCredentials(false); setError(''); }}><ArrowLeft size={16} aria-hidden="true" />Назад</button>
      </div>
    </> : <>
      <strong>Шаг 1. Укажите хранилище для файлов</strong>
      <label htmlFor={hintId + '-service'}>Сервис</label>
      <Select id={hintId + '-service'} className="settings-select" value={aws ? 'aws' : 'minio'} onChange={value => setAws(value === 'aws')}
        options={[{ value: 'minio', label: 'MinIO или другой S3-сервис' }, { value: 'aws', label: 'Amazon S3' }]} />
      {!aws && <div className="storage-field"><label>Адрес S3 API<input aria-describedby={hintId + '-endpoint'} type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="http://minio:9000" /></label>
        <p className="help" id={hintId + '-endpoint'}>Если хранилище в соседнем контейнере, подключите оба сервиса к общей Docker-сети. Укажите имя сервиса и внутренний порт API, например http://minio:9000.</p></div>}
      <div className="storage-field"><label>Название бакета<input aria-describedby={hintId + '-bucket'} value={bucket} onChange={e => setBucket(e.target.value)} placeholder="Например, project-library" /></label>
        <p className="help" id={hintId + '-bucket'}>Создайте отдельный закрытый бакет в консоли хранилища или укажите существующий бакет библиотеки.</p></div>
      {aws ? <label>Регион бакета<input value={region} onChange={e => setRegion(e.target.value)} /></label> :
        <details><summary>Дополнительные настройки</summary>
          <label>Регион<input value={region} onChange={e => setRegion(e.target.value)} /></label>
          <label><input type="checkbox" checked={pathStyle} onChange={e => setPathStyle(e.target.checked)} /> Имя бакета в пути запроса (MinIO)</label>
        </details>}
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!bucket.trim() || !region.trim() || (!aws && !endpoint.trim())} onClick={() => setCredentials(true)}>Далее — ключи доступа<ArrowRight size={16} aria-hidden="true" /></button>
        {cancel && <button type="button" className="secondary" onClick={cancel}><X size={16} aria-hidden="true" />Отмена</button>}
      </div>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </fieldset>;
}
