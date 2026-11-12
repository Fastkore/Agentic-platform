import { createHash } from 'node:crypto';
import { fastkoreChatContextKey, type FastkoreContext } from '../shared/fastkore-context.js';
import type { Chat, FastkoreChatBinding, Job, State } from '../shared/types.js';

export function chatBinding(installationId: string, context: FastkoreContext): FastkoreChatBinding | undefined {
  const key = fastkoreChatContextKey(context);
  if (!key) return;
  return { installationId, key: createHash('sha256').update(key).digest('hex'), view: context.view,
    entitySetId: context.entity_set_id, entityId: context.view === 'card' ? context.entity_id ?? undefined : undefined };
}

export function migrateFastkoreChatBindings(state: State) {
  const jobs = new Map(state.jobs?.map(job => [job.runId, job]));
  const credentials = new Map(state.security?.credentials.map(credential => [credential.id, credential]));
  const installations = new Map<string, Set<string>>();
  for (const identity of state.externalIdentities ?? []) {
    const known = installations.get(identity.userId) ?? new Set<string>();
    known.add(identity.installationId);
    installations.set(identity.userId, known);
  }
  const byChat = new Map<string, (Job | undefined)[]>();
  for (const run of state.runs) {
    if (!run.chatId) continue;
    const chatJobs = byChat.get(run.chatId) ?? [];
    chatJobs.push(jobs.get(run.id));
    byChat.set(run.chatId, chatJobs);
  }
  for (const project of state.projects) for (const chat of project.chats) {
    const owner = chat.ownerId;
    if (!owner || chat.fastkoreBinding || chat.visibility === 'project') continue;
    const chatJobs = byChat.get(chat.id);
    const userMessages = chat.messages.filter(message => message.role === 'user');
    if (chat.fastkoreHistory !== undefined) {
      const history = chat.fastkoreHistory;
      if (history && chatJobs?.length === history.turns && userMessages.length === history.turns &&
        userMessages.every(message => message.authorId === owner)) {
        chat.fastkoreBinding = history.binding;
        delete chat.fastkoreHistory;
      }
      continue;
    }
    if (!chatJobs?.length || !userMessages.length || userMessages.some(message => message.authorId !== owner || !message.runId || !jobs.has(message.runId))) continue;
    const bindings = chatJobs.map(job => {
      if (!job?.fastkoreContext || job.authorId !== owner || !job.credentialId) return;
      const credential = credentials.get(job.credentialId);
      const known = installations.get(owner);
      const installation = credential
        ? credential.source === 'fastkore' && credential.userId === owner && credential.installationId
        : known?.size === 1 ? known.values().next().value : undefined;
      return installation ? chatBinding(installation, job.fastkoreContext) : undefined;
    });
    const [first] = bindings;
    if (first && bindings.every(binding => binding?.installationId === first.installationId && binding.key === first.key)) chat.fastkoreBinding = first;
  }
}

/** Keep only enough information to migrate old contextual chats after their job payloads are removed. */
export function rememberFastkoreTurn(state: State, chat: Chat, job: Job, completed: boolean) {
  if (chat.fastkoreBinding || chat.visibility === 'project' || chat.fastkoreHistory === null) return;
  const credential = state.security?.credentials.find(item => item.id === job.credentialId && item.userId === chat.ownerId);
  const binding = completed && job.authorId === chat.ownerId && credential?.source === 'fastkore' && credential.installationId && job.fastkoreContext
    ? chatBinding(credential.installationId, job.fastkoreContext) : undefined;
  const previous = chat.fastkoreHistory;
  if (!binding || previous && (previous.binding.key !== binding.key || previous.binding.installationId !== binding.installationId)) {
    chat.fastkoreHistory = null;
    return;
  }
  chat.fastkoreHistory = { binding, turns: (previous?.turns ?? 0) + 1 };
}
