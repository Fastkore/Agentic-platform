import { createHash } from 'node:crypto';
import { fastkoreChatContextKey, fastkoreChatTitle, fastkoreSelectionChatKey, isFastkoreTileList, parseFastkoreContext, type FastkoreContext } from '../shared/fastkore-context.js';
import type { Chat, Credential, FastkoreChatBinding, Job, State } from '../shared/types.js';

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function chatBinding(installationId: string, context: FastkoreContext, externalUserId?: string): FastkoreChatBinding | undefined {
  const key = fastkoreChatContextKey(context);
  if (!key) return;
  if (context.chat_key !== undefined && !externalUserId) return;
  const contextName = fastkoreChatTitle(context);
  const tile = isFastkoreTileList(context) ? context : undefined;
  const entityUri = context.view === 'card' || (context.view === 'link_list' && context.chat_key?.startsWith('card:'))
    ? context.entity_uri : undefined;
  return { installationId, externalUserId: context.chat_key !== undefined ? externalUserId : undefined,
    key: hashKey(key), view: context.view, entitySetId: context.view === 'none' ? undefined : context.entity_set_id,
    entityId: context.view === 'card' ? context.entity_ids[0] : undefined,
    ...(contextName ? { contextName } : {}),
    ...(entityUri ? { entityUri } : {}), ...(tile ? { tileId: tile.tile_id, tileName: tile.tile_name } : {}) };
}

export function parentFastkoreChatBindings(installationId: string, externalUserId: string | undefined, context: FastkoreContext): FastkoreChatBinding[] {
  if (context.view === 'link_list' && context.owner_entity_set_id && context.owner_entity_id) {
    const set = context.owner_entity_set_id, id = context.owner_entity_id;
    return [
      ...(externalUserId ? [{ installationId, externalUserId, key: hashKey(`card:${set}:${id}`), view: 'card' as const, entitySetId: set, entityId: id }] : []),
      { installationId, key: hashKey(JSON.stringify([1, 'card', set, id])), view: 'card', entitySetId: set, entityId: id },
    ];
  }
  if (context.view === 'card' && context.tile_id) {
    const set = context.entity_set_id, tile = context.tile_id;
    return [
      ...(externalUserId ? [{ installationId, externalUserId, key: hashKey(`tile:${tile}`), view: 'list' as const, entitySetId: set, tileId: tile }] : []),
      { installationId, key: hashKey(JSON.stringify([2, 'list', set, tile])), view: 'list', entitySetId: set, tileId: tile },
    ];
  }
  return [];
}

export function fastkoreChatSessionMatches(chat: Chat, credential?: Credential) {
  const binding = chat.fastkoreBinding;
  if (!binding || credential?.source !== 'fastkore') return true;
  if (chat.visibility === 'project') return binding.installationId === credential.installationId;
  return !binding.externalUserId || (binding.installationId === credential.installationId && binding.externalUserId === credential.externalUserId);
}

export function matchesFastkoreChat(binding: FastkoreChatBinding, installationId: string, context: FastkoreContext, externalUserId?: string, shared = false) {
  if (binding.installationId !== installationId) return false;
  if (matchesLegacyFastkoreList(binding, installationId, context)) return true;
  if (binding.externalUserId || context.chat_key !== undefined) {
    const current = chatBinding(installationId, context, externalUserId);
    if (shared && !binding.externalUserId && binding.view === 'card' && context.view === 'card' && binding.entityId) {
      return binding.entitySetId === context.entity_set_id && binding.entityId === context.entity_ids[0];
    }
    return !!current && (shared || binding.externalUserId === current.externalUserId) && binding.key === current.key;
  }
  // Old list chats stored only a hash of the exact selection. Keep them usable
  // from that selection without assuming which tile to migrate their history to.
  const key = binding.view === 'list' && !binding.tileId ? fastkoreSelectionChatKey(context) : fastkoreChatContextKey(context);
  return !!key && binding.key === hashKey(key);
}

export function matchesLegacyFastkoreList(binding: FastkoreChatBinding, installationId: string, context: FastkoreContext) {
  return binding.installationId === installationId && !binding.externalUserId && binding.view === 'list' &&
    context.view === 'list' && context.chat_key !== null && binding.entitySetId === context.entity_set_id &&
    (!binding.tileId || binding.tileId === context.tile_id);
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
  const chats = state.projects.flatMap(project => project.chats);
  const knownTiles = new Set<string>();
  const tileKey = (owner: string, binding: FastkoreChatBinding) => JSON.stringify([owner, binding.installationId, binding.externalUserId, binding.key]);
  for (const chat of chats) {
    if (chat.ownerId && chat.fastkoreBinding?.tileId) knownTiles.add(tileKey(chat.ownerId, chat.fastkoreBinding));
  }
  for (const chat of chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const owner = chat.ownerId;
    if (!owner || chat.fastkoreBinding || chat.visibility === 'project') continue;
    const bind = (binding: FastkoreChatBinding) => {
      if (!chat.archivedAt && binding.tileId) {
        const key = tileKey(owner, binding);
        if (knownTiles.has(key)) return;
        knownTiles.add(key);
      }
      chat.fastkoreBinding = binding;
      delete chat.fastkoreHistory;
    };
    const chatJobs = byChat.get(chat.id);
    const userMessages = chat.messages.filter(message => message.role === 'user');
    if (chat.fastkoreHistory !== undefined) {
      const history = chat.fastkoreHistory;
      if (history && chatJobs?.length === history.turns && userMessages.length === history.turns &&
        userMessages.every(message => message.authorId === owner)) {
        bind(history.binding);
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
      const context = parseFastkoreContext(job.fastkoreContext);
      return installation && context && context.chat_key === undefined ? chatBinding(installation, context) : undefined;
    });
    const [first] = bindings;
    if (first && bindings.every(binding => binding?.installationId === first.installationId && binding.key === first.key)) bind(first);
  }
}

/** Keep only enough information to migrate old contextual chats after their job payloads are removed. */
export function rememberFastkoreTurn(state: State, chat: Chat, job: Job, completed: boolean) {
  if (chat.fastkoreBinding || chat.visibility === 'project' || chat.fastkoreHistory === null) return;
  const credential = state.security?.credentials.find(item => item.id === job.credentialId && item.userId === chat.ownerId);
  const context = parseFastkoreContext(job.fastkoreContext);
  const binding = completed && job.authorId === chat.ownerId && credential?.source === 'fastkore' && credential.installationId && context && context.chat_key === undefined
    ? chatBinding(credential.installationId, context) : undefined;
  const previous = chat.fastkoreHistory;
  if (!binding || previous && (previous.binding.key !== binding.key || previous.binding.installationId !== binding.installationId)) {
    chat.fastkoreHistory = null;
    return;
  }
  chat.fastkoreHistory = { binding, turns: (previous?.turns ?? 0) + 1 };
}
