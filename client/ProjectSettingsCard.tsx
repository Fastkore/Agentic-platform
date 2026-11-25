import { useEffect, useState } from 'react';
import { Bot, Database, Folder, Settings2, ShieldCheck } from 'lucide-react';
import type { ProjectLibraryView } from '../shared/library';
import type { ProjectAgentSettings, ProjectSummary } from '../shared/types';
import type { Request } from './library-upload';
import { SettingsSpinner } from './SettingsSpinner';

export function ProjectSettingsCard({ project, request, configure }: {
  project: ProjectSummary;
  request: Request;
  configure: (trigger: HTMLButtonElement) => void;
}) {
  const [loadedSpecialists, setSpecialists] = useState<string[] | null>();
  const [loadedLibraries, setLibraries] = useState<string[] | null>();
  const specialists = project.specialists ?? loadedSpecialists;
  const libraries = project.libraries ?? loadedLibraries;
  const base = '/api/projects/' + encodeURIComponent(project.id);

  useEffect(() => {
    if (project.specialists !== undefined && project.libraries !== undefined) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    if (project.specialists === undefined) {
      void request<ProjectAgentSettings>(base + '/agent-settings', options).then(({ policy, profiles }) => {
        if (controller.signal.aborted) return;
        const connected = new Set(policy.connections.map(({ profileId }) => profileId));
        setSpecialists(profiles.filter(profile => connected.has(profile.id)).map(profile => profile.name));
      }).catch(() => { if (!controller.signal.aborted) setSpecialists(null); });
    }
    if (project.libraries === undefined) {
      void request<ProjectLibraryView>(base + '/library', options).then(({ connections }) => {
        if (controller.signal.aborted) return;
        setLibraries(connections.map(folder => folder.folderName + (folder.enabled && folder.folderActive ? '' : ' (выключена)')));
      }).catch(() => { if (!controller.signal.aborted) setLibraries(null); });
    }
    return () => controller.abort();
  }, [base, project.libraries, project.specialists, request]);

  return <li className="agent-card">
    <header className="project-overview-header">
      <div className="settings-project-title"><Folder size={16} aria-hidden="true" /><strong>{project.name}</strong></div>
      <button type="button" className="secondary" onClick={event => configure(event.currentTarget)}
        aria-label={`Настроить проект «${project.name}»`}><Settings2 size={15} aria-hidden="true" />Настроить проект</button>
    </header>
    <dl className="project-overview-details">
      {([[Database, 'Библиотеки', libraries, 'Пока нет'], [Bot, 'Агенты', specialists, 'Пока нет'],
        [ShieldCheck, 'Роли', (project.roles ?? []).map(role => role.name + ' · ' + role.installationName), 'Только администраторы']] as const).map(([Icon, title, entries, empty]) =>
        <div key={title}><dt><Icon size={16} aria-hidden="true" />{title}</dt>
          <dd>{entries?.length ? <ul className="project-summary-chips">{entries.map((item, index) => <li key={index}>
            <Icon size={14} aria-hidden="true" /><span>{item}</span>
          </li>)}</ul>
            : entries === undefined ? <SettingsSpinner inline label="Загрузка…" />
              : <span className="help">{entries === null ? 'Не удалось загрузить' : empty}</span>}</dd>
        </div>
      )}
    </dl>
  </li>;
}
