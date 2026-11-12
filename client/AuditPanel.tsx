import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Layers, LockKeyhole, LogIn, Search, Settings2, UserRound } from 'lucide-react';
import type { AuditEvent, ProjectSummary, User } from '../shared/types';
import { Select } from './Select';
import { shortUserName, userInitials } from './user-name';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const labels: Record<string, string> = {
  setup: 'Настройка руководителя', 'user.create': 'Создан пользователь', 'sso.user.create': 'Создан пользователь',
  'sso.login': 'Вход через Fastkore', 'sso.identity.link': 'Связана учётная запись Fastkore',
  'user.update': 'Изменён пользователь', 'user.projects': 'Изменён доступ к проектам',
  'project.members': 'Изменены участники проекта', 'project.agents': 'Изменены агенты проекта',
  'role.update': 'Изменена рабочая роль', 'profile.update': 'Изменён агент', 'dataset.update': 'Изменён источник',
  'chat.private': 'Чат сделан личным', 'chat.project': 'Чат открыт проекту',
  'chat.archive': 'Чат перемещён в архив', 'chat.restore': 'Чат восстановлен из архива', 'chat.delete': 'Чат удалён',
  'key.create': 'Создан ключ API', 'key.revoke': 'Отозван ключ API', 'password.change': 'Изменён пароль',
  'sso.installation.create': 'Добавлена установка Fastkore', 'sso.installation.update': 'Изменено подключение Fastkore',
  'erp.role.delete': 'Удалена роль из списка',
};
const groups = [
  { id: 'login', label: 'Входы', icon: LogIn },
  { id: 'action', label: 'Действия', icon: Layers },
  { id: 'settings', label: 'Изменения настроек', icon: Settings2 },
  { id: 'access', label: 'Доступ к проектам', icon: LockKeyhole },
];
function category(action: string) {
  if (action === 'sso.login' || action === 'login') return 'login';
  if (['user.projects', 'project.members', 'project.agents', 'chat.private', 'chat.project'].includes(action)) return 'access';
  if (action.endsWith('.update') || action.startsWith('sso.installation') || action === 'password.change' || action === 'setup') return 'settings';
  return 'action';
}

export function AuditPanel({ request }: { request: Request }) {
  const [data, setData] = useState<{ events: AuditEvent[]; users: User[]; projects: ProjectSummary[] }>();
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('7'), [actor, setActor] = useState('all'), [eventType, setEventType] = useState('all');
  const [search, setSearch] = useState(''), [ascending, setAscending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    Promise.all([request<AuditEvent[]>('/api/audit', options), request<User[]>('/api/users', options), request<ProjectSummary[]>('/api/projects', options)])
      .then(([events, users, projects]) => { if (!controller.signal.aborted) setData({ events, users, projects }); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [request]);
  if (error) return <p className="inline-error" role="alert">{error}</p>;
  if (!data) return <p role="status">Загрузка…</p>;
  const users = new Map(data.users.map(user => [user.id, user]));
  const projects = new Map(data.projects.map(project => [project.id, project.name]));
  const details = (event: AuditEvent) => {
    if (event.action === 'sso.login') return 'Вход по учётной записи Fastkore';
    if (users.has(event.targetId)) return 'Пользователь · ' + shortUserName(users.get(event.targetId)!.name);
    if (projects.has(event.targetId)) return 'Проект · ' + projects.get(event.targetId);
    return event.targetId;
  };
  const cutoff = Date.now() - Number(period) * 86400_000;
  const query = search.trim().toLocaleLowerCase('ru-RU');
  const rows = data.events.filter(event => Date.parse(event.createdAt) >= cutoff
    && (actor === 'all' || actor === event.actorId)
    && (eventType === 'all' || category(event.action) === eventType)
    && (!query || [users.get(event.actorId)?.name, labels[event.action], event.action, details(event)]
      .join(' ').toLocaleLowerCase('ru-RU').includes(query)))
    .sort((a, b) => (ascending ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
  const week = data.events.filter(event => Date.parse(event.createdAt) >= Date.now() - 7 * 86400_000);
  return <div className="audit-panel">
    <p className="audit-intro">Входы пользователей и изменения доступа за последние 7 дней.</p>
    <div className="audit-summary">{groups.map(({ id, label, icon: Icon }) => <div className="audit-metric" key={id}>
      <Icon size={21} aria-hidden="true" /><div><span>{label}</span><p><strong>{week.filter(event => category(event.action) === id).length}</strong><small>за 7 дней</small></p></div>
    </div>)}</div>
    <div className="audit-filters">
      <div><label><CalendarDays size={16} />Период</label><Select label="Период журнала" className="settings-select" value={period} onChange={setPeriod}
        options={[{ value: '1', label: 'Последние сутки' }, { value: '7', label: 'Последние 7 дней' }]} /></div>
      <div><label><UserRound size={16} />Пользователь</label><Select label="Пользователь журнала" className="settings-select" value={actor} onChange={setActor}
        options={[{ value: 'all', label: 'Все пользователи' }, ...data.users.map(user => ({ value: user.id, label: shortUserName(user.name) }))]} /></div>
      <div><label><Layers size={16} />Событие</label><Select label="Тип события" className="settings-select" value={eventType} onChange={setEventType}
        options={[{ value: 'all', label: 'Все события' }, ...groups.map(group => ({ value: group.id, label: group.label }))]} /></div>
      <div className="audit-search"><Search size={18} aria-hidden="true" /><input aria-label="Поиск в журнале" placeholder="Поиск в журнале…" value={search} onChange={event => setSearch(event.target.value)} /></div>
    </div>
    <div className="audit-table-scroll"><table className="audit-table">
      <thead><tr><th scope="col" aria-sort={ascending ? 'ascending' : 'descending'}><button onClick={() => setAscending(!ascending)}>Дата и время {ascending ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button></th>
        <th scope="col">Пользователь</th><th scope="col">Событие</th><th scope="col">Детали</th></tr></thead>
      <tbody>{rows.map(event => {
        const user = users.get(event.actorId);
        const Icon = groups.find(group => group.id === category(event.action))!.icon;
        return <tr key={event.id}>
          <td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('ru-RU')}</time></td>
          <td><div className="person-cell"><span className="person-avatar" aria-hidden="true">{user ? userInitials(user.name) : '—'}</span><div>
            <strong title={user?.name}>{user ? shortUserName(user.name) : 'Удалённый пользователь'}</strong>
            {user && <small>{user.role === 'admin' ? 'Руководитель' : 'Сотрудник'}</small>}</div></div></td>
          <td><span className="audit-event"><Icon size={18} aria-hidden="true" />{labels[event.action] ?? event.action}</span></td>
          <td><details className="audit-details"><summary>{details(event)}</summary><dl>
            <dt>Код события</dt><dd>{event.action}</dd><dt>Объект</dt><dd>{event.targetId}</dd><dt>ID события</dt><dd>{event.id}</dd>
          </dl></details></td>
        </tr>;
      })}</tbody>
    </table>{!rows.length && <p className="audit-empty" role="status">{data.events.length ? 'По выбранным условиям событий нет.' : 'В журнале пока нет записей.'}</p>}</div>
    <p className="audit-count" role="status">Показано {rows.length} из {data.events.length}</p>
  </div>;
}
