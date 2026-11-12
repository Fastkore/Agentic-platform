import type { ChatSummary } from '../shared/types';

const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const shortDateFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function shortDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : shortDateFormat.format(date);
}

export function dateTooltip(value: string, name?: string) {
  const date = new Date(value);
  const timestamp = Number.isFinite(date.getTime()) ? dateTimeFormat.format(date) : '';
  return [name, timestamp].filter(Boolean).join('\n');
}

export function chatTooltip(chat: Pick<ChatSummary, 'title' | 'ownerName' | 'updatedAt'>, date = chat.updatedAt) {
  return [chat.title, dateTooltip(date, chat.ownerName)].filter(Boolean).join('\n');
}
