const ticketPath = '/api/ai/validate-ticket';

export function normalizeFastkoreTicketUrl(value: string): string | undefined {
  const input = value.trim();
  if (!input || input.startsWith('/') || /[\s\\]/.test(input)) return;

  let url: URL;
  try {
    url = new URL(input.includes('://') ? input : 'https://' + input);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== url.origin + url.pathname) return;
  if (url.pathname === '/' || url.pathname === ticketPath) return url.origin + ticketPath;
}
