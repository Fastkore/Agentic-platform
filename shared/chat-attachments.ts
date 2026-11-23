import type { Attachment, Chat, Message, User } from './types.js';

export type PreviewModelFormat = 'stl' | 'glb';

export function previewModelFormat(name: string): PreviewModelFormat | undefined {
  if (/\.stl$/i.test(name)) return 'stl';
  if (/\.glb$/i.test(name)) return 'glb';
}

export function canReadChatAttachment(file: Attachment, message: Message, chatOwnerId: string | undefined, user: User) {
  if (message.role === 'assistant') return message.status === 'complete';
  const owner = file.ownerId ?? message.authorId ?? chatOwnerId;
  return user.role === 'admin' || owner === user.id;
}

export function chatFileEntries(chat: Chat, user: User) {
  const entries = new Map<string, { file: Attachment; messageId: string; canDelete: boolean }>();
  for (const file of chat.storedFiles ?? []) {
    if (user.role === 'admin' || file.ownerId === user.id) entries.set(file.id, { file, messageId: 'stored', canDelete: true });
  }
  for (const message of chat.messages) {
    for (const file of message.attachments) {
      if (!canReadChatAttachment(file, message, chat.ownerId, user)) continue;
      entries.set(file.id, { file, messageId: message.id, canDelete: user.role === 'admin' || (file.ownerId ?? message.authorId ?? chat.ownerId) === user.id });
    }
  }
  return [...entries.values()];
}
