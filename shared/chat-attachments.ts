import type { Attachment, Message, User } from './types.js';

export type PreviewModelFormat = 'stl' | 'glb';

export function previewModelFormat(name: string): PreviewModelFormat | undefined {
  if (/\.stl$/i.test(name)) return 'stl';
  if (/\.glb$/i.test(name)) return 'glb';
}

export function canReadChatAttachment(file: Attachment, message: Message, chatOwnerId: string | undefined, user: User) {
  if (message.role === 'assistant') return message.status === 'complete';
  const owner = file.ownerId ?? message.authorId ?? chatOwnerId;
  return !!previewModelFormat(file.name) && (user.role === 'admin' || owner === user.id);
}
